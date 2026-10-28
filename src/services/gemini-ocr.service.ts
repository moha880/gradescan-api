import sharp from 'sharp';
import { convertArabicDigits } from './ocr.service';
import type { ExtractedStudentResult, OcrLanguage } from './ocr.service';

/**
 * Gemini-based OCR for photographed grade sheets.
 *
 * Why Gemini: on the KITAB-Bench Arabic OCR benchmark Gemini Flash had a character error
 * rate of 0.13 (0.19 on handwritten KHATT) versus 0.54 / 0.67 for Tesseract. Handwritten
 * Arabic names are the hard case, and a vision-language model reads them far better than
 * a classic OCR engine. It also understands the table layout, so name and grade stay on
 * the same row without the fragile geometry code the Tesseract path needs.
 *
 * Free usage: a key from https://aistudio.google.com/apikey works without billing.
 * PRIVACY: on Google's unpaid tier, submitted images may be used to improve Google's
 * products and reviewed by humans (not in the EEA/UK/Switzerland). Link a billing account
 * to the key's project to switch to the paid-tier data terms (no training on your data) —
 * a scan costs a fraction of a cent.
 *
 * All settings are read lazily (not at import time) because index.ts calls dotenv.config()
 * after the route modules have been imported.
 */

const DEFAULT_API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
// Tried in order. A model that is missing from your plan (404) or out of quota (429)
// simply hands over to the next one.
const DEFAULT_MODELS = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite'];

// Gemini 3.x models "think" before answering, so a single call can take 10-30 s on a busy day.
// Each call gets its own timeout; the whole scan (all models together) gets one budget.
// Both can be tuned from the environment.
function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = parseInt(process.env[name] ?? '', 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}
const requestTimeoutMs = () => envInt('GEMINI_REQUEST_TIMEOUT_MS', 30_000, 3_000, 120_000);
const totalBudgetMs = () => envInt('GEMINI_TOTAL_BUDGET_MS', 75_000, 5_000, 300_000);

const THINKING_LEVELS = ['minimal', 'low', 'medium', 'high'];
/**
 * How much the model may "think" before it answers (generationConfig.thinkingConfig.thinkingLevel).
 * Reading printed or handwritten text is perception, not reasoning, so the cheapest level that
 * every current Flash model accepts ("low") is the default — it cuts latency a lot.
 * GEMINI_THINKING_LEVEL = minimal | low | medium | high | default (default = do not send the setting).
 * A model that rejects the setting is retried without it automatically.
 */
export function getThinkingLevel(): string | null {
  const v = (process.env.GEMINI_THINKING_LEVEL ?? 'low').trim().toLowerCase();
  if (!v || v === 'default' || v === 'off' || v === 'none') return null;
  return THINKING_LEVELS.includes(v) ? v : 'low';
}

export class GeminiOcrError extends Error {
  constructor(message: string, readonly kind: 'config' | 'auth' | 'quota' | 'blocked' | 'network' | 'bad_response') {
    super(message);
    this.name = 'GeminiOcrError';
  }
}

export interface GeminiOcrResult {
  rawText: string;
  extracted: ExtractedStudentResult[];
  model: string;
  droppedRows: number;
  /** Rows the model returned but we did not keep, with the reason — so nothing disappears silently. */
  droppedDetails: { name: string; reason: string }[];
}

export function isGeminiConfigured(): boolean {
  return !!process.env.GEMINI_API_KEY?.trim();
}

export function getGeminiModels(): string[] {
  const fromEnv = (process.env.GEMINI_MODELS ?? process.env.GEMINI_MODEL ?? '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);
  return fromEnv.length ? fromEnv : DEFAULT_MODELS;
}

/* ------------------------------------------------------------------ */
/* Prompt                                                              */
/* ------------------------------------------------------------------ */

function buildPrompt(lang: OcrLanguage): string {
  const langHint =
    lang === 'ara'
      ? 'The student names on this sheet are written in Arabic (the table reads right-to-left).'
      : lang === 'eng'
        ? 'The student names on this sheet are written in English (the table reads left-to-right).'
        : 'Student names may be in Arabic or English; keep each name in the script it is written in.';

  return `You are a precise OCR engine reading a photographed exam-results sheet: a table with one student per row. ${langHint}

For EVERY student row return an object with:
- "name": the student's full name exactly as written, in its original script. Do NOT translate, transliterate, shorten, reorder or "correct" the spelling, and keep every word of the name (Arabic names usually have 3-4 parts). Do not include row numbers, student IDs or grades in the name.
- "grade": the student's mark as a plain number. Convert Arabic-Indic digits (٠١٢٣٤٥٦٧٨٩ and ۰۱۲۳۴۵۶۷۸۹) to 0-9 and use "." as the decimal separator. Use null if the grade cell is empty or unreadable. Never guess a grade that is not visible.
- "max_grade": the maximum mark when the sheet shows it (for example "18/20" or "18 من 20" gives 20), otherwise null.
- "confidence": a number from 0 to 1 for how sure you are that BOTH the name and the grade were read correctly. Use a value below 0.6 whenever any letter or digit is ambiguous (for example dots on Arabic letters that could be ب/ت/ث/ن/ي, or a digit that could be 1/7 or 0/6).

Rules:
- List rows in top-to-bottom order.
- Skip header rows, total/average rows, signatures, dates and empty rows.
- Never invent rows or names. If a name is partly illegible, give your best reading and lower the confidence.

Respond with ONLY this JSON, no markdown and no commentary:
{"rows":[{"name":"...","grade":0,"max_grade":0,"confidence":0.0}]}`;
}

/* ------------------------------------------------------------------ */
/* Image preparation                                                   */
/* ------------------------------------------------------------------ */

/**
 * Keep the photo natural (no binarising — a vision model reads colour/grey handwriting
 * better than thresholded pixels). Just honour EXIF rotation and cap the size so the
 * upload stays small and quick.
 */
export async function prepareImageForGemini(input: Buffer): Promise<{ data: Buffer; mime: string }> {
  const data = await sharp(input)
    .rotate()
    .resize({ width: 2400, height: 2400, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 90 })
    .toBuffer();
  return { data, mime: 'image/jpeg' };
}

/* ------------------------------------------------------------------ */
/* Response parsing                                                    */
/* ------------------------------------------------------------------ */

const BIDI_AND_ZW = /[​-‏‪-‮⁦-⁩﻿]/g;
const TATWEEL = /ـ/g;
const HEADER_OR_TOTAL =
  /^(#|no\.?|id|name|student|students|student name|grade|grades|mark|marks|score|total|sum|average|avg|date|page|class|م|الاسم|اسم|الطالب|اسم الطالب|الدرجة|الدرجات|المجموع|العلامة|المتوسط|التاريخ|الإجمالي|الاجمالي)$/i;

/** Pull the JSON object out of the model text (tolerates ```json fences and stray prose). */
export function extractJson(text: string): any {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to bracket search */
  }
  // Prose around the JSON: take whichever bracket (object or array) opens first, so that
  // "[{...},{...}]" is read as the array and not as its first object.
  const candidates: [number, number][] = [
    [trimmed.indexOf('{'), trimmed.lastIndexOf('}')],
    [trimmed.indexOf('['), trimmed.lastIndexOf(']')],
  ];
  candidates.sort((a, b) => (a[0] < 0 ? Infinity : a[0]) - (b[0] < 0 ? Infinity : b[0]));
  for (const [start, end] of candidates) {
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(trimmed.slice(start, end + 1));
      } catch {
        /* try the next candidate */
      }
    }
  }
  throw new GeminiOcrError('Gemini returned text that is not valid JSON', 'bad_response');
}

function cleanName(raw: unknown): string {
  return String(raw ?? '')
    .replace(BIDI_AND_ZW, '')
    .replace(TATWEEL, '')
    .replace(/[0-9٠-٩۰-۹]+/g, ' ') // stray serial numbers / IDs
    .replace(/[|_=~"“”«»(){}[\]:;,،؛؟?!*#/\\<>+]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\-' ]+|[.\-' ]+$/g, '')
    .trim();
}

function toNumber(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = convertArabicDigits(String(v)).replace(',', '.').replace(/[^\d.]/g, '');
  if (!s) return null;
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const median = (a: number[]) => {
  const b = [...a].sort((x, y) => x - y);
  return b.length ? b[b.length >> 1] : 0;
};

/** Turn the model's JSON into app rows, applying the same sanity checks as the Tesseract path. */
export function normalizeRows(json: any): {
  rows: ExtractedStudentResult[];
  dropped: number;
  droppedDetails: { name: string; reason: string }[];
} {
  const list: any[] = Array.isArray(json) ? json : Array.isArray(json?.rows) ? json.rows : [];
  const rows: ExtractedStudentResult[] = [];
  const droppedDetails: { name: string; reason: string }[] = [];

  for (const item of list) {
    const name = cleanName(item?.name);
    const grade = toNumber(item?.grade);
    let maxGrade = toNumber(item?.max_grade ?? item?.maxGrade);
    if (maxGrade !== null && (maxGrade <= 0 || maxGrade > 1000)) maxGrade = null;

    const letters = name.replace(/[\s.\-']/g, '');
    const dropReason =
      letters.length < 2 ? 'name too short'
      : HEADER_OR_TOTAL.test(name) ? 'header or total row'
      : grade === null ? 'no readable grade'
      : grade < 0 || grade > 1000 ? `grade out of range (${grade})`
      : null;
    if (dropReason) {
      droppedDetails.push({ name: name || String(item?.name ?? '').trim(), reason: dropReason });
      continue;
    }
    // (grade is non-null from here on)
    const gradeValue = grade as number;

    let confidence = toNumber(item?.confidence);
    confidence = confidence === null ? 0.7 : confidence > 1 ? confidence / 100 : confidence;
    confidence = Math.max(0.05, Math.min(0.97, confidence));
    // grade above the printed maximum is almost always a misread digit: make it surface in review
    if (maxGrade !== null && gradeValue > maxGrade) confidence = Math.min(confidence, 0.3);

    rows.push({
      name,
      grade: gradeValue,
      maxGrade,
      confidence,
      rawText: `${name} ${gradeValue}${maxGrade !== null ? `/${maxGrade}` : ''}`,
    });
  }

  // Same cross-check as the Tesseract path: the sheet's usual maximum fills gaps and
  // outliers (e.g. "11/71" on a sheet where everyone else is "/20") are flagged.
  const maxes = rows.map(r => r.maxGrade).filter((m): m is number => m !== null);
  const commonMax = maxes.length > 0 && maxes.length >= rows.length / 2 ? median(maxes) : null;
  if (commonMax) {
    for (const r of rows) {
      if (r.maxGrade === null && r.grade <= commonMax) r.maxGrade = commonMax;
      else if (r.maxGrade !== null && r.maxGrade !== commonMax) r.confidence = Math.min(r.confidence, 0.4);
    }
  }
  return { rows, dropped: droppedDetails.length, droppedDetails };
}


/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

type PostResult =
  | { type: 'http'; status: number; json: any }
  | { type: 'timeout' }
  | { type: 'network'; message: string };

async function postGenerate(model: string, apiKey: string, body: unknown, timeoutMs: number): Promise<PostResult> {
  const base = (process.env.GEMINI_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    // read the body inside the timer too: a response that stalls half-way must also time out
    const text = await res.text();
    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON error body */
    }
    return { type: 'http', status: res.status, json };
  } catch (err: any) {
    if (err?.name === 'AbortError') return { type: 'timeout' };
    const code = err?.cause?.code ? ` (${err.cause.code})` : '';
    return { type: 'network', message: `${err?.message ?? err}${code}` };
  } finally {
    clearTimeout(timer);
  }
}

const apiMessage = (json: any) => String(json?.error?.message ?? '').slice(0, 200);

/* ------------------------------------------------------------------ */
/* Model health                                                        */
/* ------------------------------------------------------------------ */

/**
 * Free-tier models are flaky in different ways at different times (overloaded, slow, out of
 * quota). Remember which one just failed so the next scan does not spend 30 s waiting on it
 * again: models in "cool-down" are tried last, everything else keeps the configured order.
 */
type FailureKind = 'timeout' | 'server' | 'quota' | 'missing' | 'bad';
const COOLDOWN_MS: Record<FailureKind, number> = {
  timeout: 5 * 60_000,
  server: 2 * 60_000,
  quota: 2 * 60_000,
  missing: 30 * 60_000,
  bad: 0, // a model that answered with unusable text is not "down"
};
const coolingUntil = new Map<string, number>();
const withoutThinking = new Set<string>(); // models that rejected the thinkingConfig field

export function orderModelsByHealth(models: string[], now = Date.now()): string[] {
  const until = (m: string) => coolingUntil.get(m) ?? 0;
  const healthy = models.filter(m => until(m) <= now);
  const cooling = models.filter(m => until(m) > now).sort((a, b) => until(a) - until(b));
  return [...healthy, ...cooling];
}

/** Test hook / manual reset. */
export function resetGeminiHealth(): void {
  coolingUntil.clear();
  withoutThinking.clear();
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

interface Outcome {
  model: string;
  kind: FailureKind;
  text: string;
}

export async function recognizeWithGemini(image: Buffer, lang: OcrLanguage = 'auto'): Promise<GeminiOcrResult> {
  const apiKey = process.env.GEMINI_API_KEY?.trim();
  if (!apiKey) throw new GeminiOcrError('GEMINI_API_KEY is not set', 'config');

  const prepared = await prepareImageForGemini(image);
  const imageB64 = prepared.data.toString('base64');
  const prompt = buildPrompt(lang);
  const makeBody = (jsonMode: boolean, thinkingLevel: string | null) => ({
    contents: [
      {
        role: 'user',
        parts: [{ text: prompt }, { inline_data: { mime_type: prepared.mime, data: imageB64 } }],
      },
    ],
    generationConfig: {
      temperature: 0,
      ...(jsonMode ? { response_mime_type: 'application/json' } : {}),
      ...(thinkingLevel ? { thinkingConfig: { thinkingLevel } } : {}),
    },
  });

  const started = Date.now();
  const budget = totalBudgetMs();
  const perRequest = requestTimeoutMs();
  const remaining = () => budget - (Date.now() - started);
  const thinking = getThinkingLevel();
  const models = orderModelsByHealth(getGeminiModels());

  const outcomes: Outcome[] = [];
  const retryable = new Set<string>(); // failed in a way that may pass a moment later (5xx, dropped connection)
  const fail = (model: string, kind: FailureKind, text: string, retry = false) => {
    outcomes.push({ model, kind, text });
    if (COOLDOWN_MS[kind] > 0) coolingUntil.set(model, Date.now() + COOLDOWN_MS[kind]);
    if (retry) retryable.add(model);
    console.warn(`[OCR] ${model}: ${text}`);
  };

  /** One model, up to a few quick request tweaks (JSON mode / thinking level) — never a blind repeat. */
  const tryModel = async (model: string): Promise<GeminiOcrResult | null> => {
    let useJson = true;
    let useThinking = thinking !== null && !withoutThinking.has(model);

    for (let tweak = 0; tweak < 3; tweak++) {
      const left = remaining();
      if (left < 3_000) return null;
      const t0 = Date.now();
      const res = await postGenerate(model, apiKey, makeBody(useJson, useThinking ? thinking : null), Math.min(perRequest, left));
      const secs = ((Date.now() - t0) / 1000).toFixed(1);

      // A timeout means THIS model is slow right now: move on instead of waiting for it again.
      if (res.type === 'timeout') {
        fail(model, 'timeout', `timed out after ${secs}s`);
        return null;
      }
      if (res.type === 'network') {
        fail(model, 'server', `network error (${res.message})`, true);
        return null;
      }

      const { status, json } = res;
      if (status === 200) {
        const block = json?.promptFeedback?.blockReason;
        if (block) throw new GeminiOcrError(`Gemini blocked the image (${block})`, 'blocked');
        const cand = json?.candidates?.[0];
        const text: string = (cand?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('');
        if (!text.trim()) {
          const why = cand?.finishReason;
          if (why && /SAFETY|PROHIBITED|BLOCKLIST|IMAGE_SAFETY|RECITATION/i.test(why)) {
            throw new GeminiOcrError(`Gemini returned no text (${why})`, 'blocked');
          }
          fail(model, 'bad', `empty response${why ? ` (${why})` : ''} after ${secs}s`);
          return null;
        }
        if (process.env.OCR_DEBUG === 'true') {
          // opt-in: shows exactly what the model returned (contains student names — local debugging only)
          console.log(`[OCR][debug] ${model} raw response:\n${text.slice(0, 4000)}`);
        }
        let parsed;
        try {
          parsed = normalizeRows(extractJson(text));
        } catch (e: any) {
          fail(model, 'bad', `${e?.message ?? 'unreadable answer'} (after ${secs}s)`);
          return null;
        }
        coolingUntil.delete(model);
        console.log(`[OCR] ${model}: ok in ${secs}s (image ${Math.round(prepared.data.length / 1024)} KB, thinking=${useThinking ? thinking : 'default'})`);
        return {
          rawText: parsed.rows.map(r => `${r.name}\t${r.grade}${r.maxGrade !== null ? `/${r.maxGrade}` : ''}`).join('\n'),
          extracted: parsed.rows,
          model,
          droppedRows: parsed.dropped,
          droppedDetails: parsed.droppedDetails,
        };
      }

      if (status === 401 || status === 403) {
        throw new GeminiOcrError(`Gemini rejected the API key (HTTP ${status}): ${apiMessage(json)}`, 'auth');
      }
      if (status === 400) {
        const msg = apiMessage(json);
        // keep working if this model/API version rejects an optional field
        if (useJson && /response_mime_type|responseMimeType|mime/i.test(msg)) {
          useJson = false; // the prompt already demands JSON
          continue;
        }
        if (useThinking && /thinking/i.test(msg)) {
          useThinking = false;
          withoutThinking.add(model);
          console.warn(`[OCR] ${model}: does not accept thinkingLevel, retrying without it`);
          continue;
        }
        if (/API key/i.test(msg)) throw new GeminiOcrError(`Gemini rejected the API key: ${msg}`, 'auth');
        throw new GeminiOcrError(`Gemini rejected the request (HTTP 400): ${msg}`, 'bad_response');
      }
      if (status === 404) {
        fail(model, 'missing', 'not available to this API key');
        return null;
      }
      if (status === 429) {
        fail(model, 'quota', 'quota exceeded (HTTP 429)'); // each model has its own free-tier quota → next one
        return null;
      }
      if (status >= 500) {
        fail(model, 'server', `server error ${status} after ${secs}s`, true);
        return null;
      }
      throw new GeminiOcrError(`Gemini returned HTTP ${status}: ${apiMessage(json)}`, 'bad_response');
    }
    return null;
  };

  // Pass 1: every model once. Pass 2 (only if time is left): the models that failed with a
  // server error / dropped connection get one more chance after a short pause.
  outer: for (let pass = 0; pass < 2; pass++) {
    const list = pass === 0 ? models : models.filter(m => retryable.has(m));
    if (!list.length) break;
    if (pass === 1) {
      if (remaining() < 8_000) break;
      await sleep(1_500);
    }
    for (const model of list) {
      if (remaining() < 3_000) break outer;
      retryable.delete(model);
      const result = await tryModel(model);
      if (result) return result;
    }
  }

  // Nothing worked — say why, model by model.
  if (outcomes.length === 0) {
    throw new GeminiOcrError(`Gemini did not answer within ${Math.round(budget / 1000)} s`, 'network');
  }
  // one entry per model (its latest outcome), in the order the models were first tried
  const latest = new Map<string, string>();
  for (const o of outcomes) latest.set(o.model, o.text);
  const summary = [...latest].map(([m, t]) => `${m}: ${t}`).join('; ');
  if (outcomes.every(o => o.kind === 'quota')) {
    throw new GeminiOcrError(`Gemini quota exceeded (${models.join(', ')}) — free-tier limit reached, try again later`, 'quota');
  }
  if (outcomes.every(o => o.kind === 'missing')) {
    throw new GeminiOcrError(`None of the configured Gemini models (${models.join(', ')}) is available to this API key`, 'network');
  }
  if (outcomes.every(o => o.kind === 'bad' || o.kind === 'missing')) {
    throw new GeminiOcrError(`Gemini could not read the sheet — ${summary}`, 'bad_response');
  }
  throw new GeminiOcrError(`Gemini did not answer — ${summary}`, 'network');
}
