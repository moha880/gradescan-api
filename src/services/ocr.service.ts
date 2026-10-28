import { createWorker, PSM } from 'tesseract.js';
import sharp from 'sharp';
import path from 'path';
import fs from 'fs';

export interface ExtractedStudentResult {
  name: string;
  grade: number;
  maxGrade: number | null;
  confidence: number;
  rawText?: string;
}

export type OcrLanguage = 'eng' | 'ara' | 'auto';

/* ------------------------------------------------------------------ */
/* Text helpers                                                        */
/* ------------------------------------------------------------------ */

export function convertArabicDigits(text: string): string {
  return text
    .replace(/[٠-٩]/g, d => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, d => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٫،]/g, m => (m === '٫' ? '.' : ','));
}

const BIDI_MARKS = /[‎‏‪-‮⁦-⁩]/g;
const LETTER = /[A-Za-z\u0600-\u06FF]/;
const HEADER_WORDS =
  /^(#|no\.?|id|name|student|students|student name|grade|grades|mark|marks|score|total|sum|average|avg|date|page|class|م|الاسم|اسم|الطالب|اسم الطالب|الدرجة|الدرجات|المجموع|العلامة|المتوسط|التاريخ)$/i;

/** Fix common OCR letter/digit confusions, only inside tokens that are clearly numeric. */
function fixNumericToken(tok: string): string {
  if (!/\d/.test(tok)) return tok;
  if (!/^[\dOoIlS|.,/]+$/.test(tok)) return tok;
  return tok
    .replace(/[Oo]/g, '0')
    .replace(/[Il|]/g, '1')
    .replace(/S/g, '5')
    .replace(/,/g, '.');
}

const NUM = String.raw`\d{1,3}(?:\.\d{1,2})?`;
const SEP = String.raw`\s*(?:\/|من|out\s+of|of)\s*`;
const GRADE_AT_END = new RegExp(String.raw`(${NUM})(?:${SEP}(${NUM}))?\s*$`, 'i');
const GRADE_AT_START = new RegExp(String.raw`^\s*(${NUM})(?:${SEP}(${NUM}))?(?=\s)`, 'i');

function cleanName(text: string): string {
  return text
    .split(/\s+/)
    .map(t => t.replace(/[^A-Za-z\u0600-\u06FF'.\-]|[\u0660-\u0669\u06F0-\u06F9]/g, '').replace(/^[.\-']+|[.\-']+$/g, ''))
    // drop OCR crumbs: 1-char Latin tokens (keep Arabic single letters joined in names like "عبد")
    .filter(t => t.length >= 2 || /[\u0600-\u06FF]/.test(t))
    .join(' ')
    .trim();
}

function isPlausibleGrade(grade: number, maxGrade: number | null): boolean {
  if (isNaN(grade) || grade < 0) return false;
  if (maxGrade !== null) return !isNaN(maxGrade) && maxGrade > 0 && maxGrade <= 1000 && grade <= maxGrade;
  return grade <= 100;
}

/**
 * Parse ONE table row of OCR text into { name, grade, maxGrade }.
 * Handles: "1  Ahmed Ali  18/20", "Ahmed Ali: 18", "١ أحمد علي ١٨ من ٢٠",
 * stray table-border characters, a leading serial number, and RTL lines
 * where the grade ends up at the start of the logical text.
 */
export function parseRow(rawLine: string): { name: string; grade: number; maxGrade: number | null } | null {
  let line = convertArabicDigits(rawLine.replace(BIDI_MARKS, ''));
  // table borders / OCR noise → spaces
  line = line.replace(/[|[\]{}()_=~“”"«»;:—–]+/g, ' ');
  line = line
    .split(/\s+/)
    .map(fixNumericToken)
    .join(' ')
    .replace(/(\d)\s*[.,]\s*(\d)/g, '$1.$2') // "12 . 5" → "12.5"
    .replace(/\s+/g, ' ')
    .trim();
  if (!LETTER.test(line)) return null;

  let grade: number | null = null;
  let maxGrade: number | null = null;
  let rest = line;

  const end = line.match(GRADE_AT_END);
  if (end && end.index !== undefined && LETTER.test(line.slice(0, end.index))) {
    grade = parseFloat(end[1]);
    maxGrade = end[2] ? parseFloat(end[2]) : null;
    rest = line.slice(0, end.index);
  } else {
    // RTL sheets: the grade can come out first in logical order
    const start = line.match(GRADE_AT_START);
    if (start && LETTER.test(line.slice(start[0].length)) && /[\u0600-\u06FF]/.test(line)) {
      grade = parseFloat(start[1]);
      maxGrade = start[2] ? parseFloat(start[2]) : null;
      rest = line.slice(start[0].length);
    }
  }
  if (grade === null || !isPlausibleGrade(grade, maxGrade)) return null;

  // remove serial numbers / IDs that are left in the name part
  rest = rest.replace(/(^|\s)\d+(\.\d+)?(?=\s|$)/g, ' ');
  const name = cleanName(rest);
  if (name.replace(/\s/g, '').length < 2) return null;
  if (HEADER_WORDS.test(name) || /^(total|average|sum|المجموع|المتوسط)\b/i.test(name)) return null;

  return { name, grade, maxGrade };
}

/* ------------------------------------------------------------------ */
/* Image preprocessing                                                 */
/* ------------------------------------------------------------------ */

/** Adaptive mean threshold (integral image). Returns 0 = ink, 255 = paper. */
function adaptiveThreshold(g: Uint8Array | Buffer, w: number, h: number, win: number, C: number): Uint8Array {
  const W1 = w + 1;
  const I = new Float64Array(W1 * (h + 1));
  for (let y = 0; y < h; y++) {
    let s = 0;
    for (let x = 0; x < w; x++) {
      s += g[y * w + x];
      I[(y + 1) * W1 + x + 1] = I[y * W1 + x + 1] + s;
    }
  }
  const out = new Uint8Array(w * h);
  const r = win >> 1;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const sum = I[y1 * W1 + x1] - I[y0 * W1 + x1] - I[y1 * W1 + x0] + I[y0 * W1 + x0];
      const mean = sum / ((y1 - y0) * (x1 - x0));
      out[y * w + x] = g[y * w + x] < mean - C ? 0 : 255;
    }
  }
  return out;
}

/** Estimate page skew (degrees) by maximising the sharpness of the row ink profile. */
function estimateSkew(b: Uint8Array, w: number, h: number): number {
  const pts: number[] = [];
  for (let y = 0; y < h; y += 2) for (let x = 0; x < w; x += 2) if (b[y * w + x] === 0) pts.push(x, y);
  let best = 0, bestScore = -1;
  for (let a = -10; a <= 10.001; a += 0.25) {
    const t = Math.tan((a * Math.PI) / 180);
    const hist = new Float64Array(h + Math.ceil(w * 0.2) + 2);
    const off = Math.ceil(w * 0.2);
    for (let i = 0; i < pts.length; i += 2) {
      // bin width = sampling step (2px) to avoid aliasing at 0°
      const yy = Math.floor((pts[i + 1] - pts[i] * t + off) / 2);
      if (yy >= 0 && yy < hist.length) hist[yy]++;
    }
    let s = 0;
    for (let i = 1; i < hist.length; i++) { const d = hist[i] - hist[i - 1]; s += d * d; }
    if (s > bestScore) { bestScore = s; best = a; }
  }
  return best;
}

/** Whiten long horizontal / vertical ink runs (table borders, underlines). */
function removeLines(b: Uint8Array, w: number, h: number): Uint8Array {
  const minH = Math.round(w * 0.12), minV = Math.round(h * 0.12), pad = 1;
  const o = Uint8Array.from(b);
  for (let y = 0; y < h; y++) {
    let s = -1;
    for (let x = 0; x <= w; x++) {
      const ink = x < w && b[y * w + x] === 0;
      if (ink && s < 0) s = x;
      if (!ink && s >= 0) {
        if (x - s >= minH)
          for (let yy = Math.max(0, y - pad); yy <= Math.min(h - 1, y + pad); yy++)
            for (let xx = s; xx < x; xx++) o[yy * w + xx] = 255;
        s = -1;
      }
    }
  }
  for (let x = 0; x < w; x++) {
    let s = -1;
    for (let y = 0; y <= h; y++) {
      const ink = y < h && b[y * w + x] === 0;
      if (ink && s < 0) s = y;
      if (!ink && s >= 0) {
        if (y - s >= minV)
          for (let xx = Math.max(0, x - pad); xx <= Math.min(w - 1, x + pad); xx++)
            for (let yy = s; yy < y; yy++) o[yy * w + xx] = 255;
        s = -1;
      }
    }
  }
  return o;
}

/** Binary → PNG, either pure black/white or "line-free grayscale" (better for Arabic script). */
async function toPng(bin: Uint8Array, gray: Buffer, w: number, h: number, keepGray: boolean): Promise<Buffer> {
  const out = Buffer.alloc(w * h);
  for (let i = 0; i < out.length; i++) out[i] = bin[i] === 255 ? 255 : keepGray ? gray[i] : 0;
  return sharp(out, { raw: { width: w, height: h, channels: 1 } }).png().toBuffer();
}

export interface PreparedImage {
  width: number;          // reference width that all word boxes are mapped to
  skew: number;
  textPng: Buffer;        // grayscale, deskewed, grid lines removed — for names
  digitPngs: { png: Buffer; scale: number }[]; // binarised at several sizes — for grades
}

/**
 * Phone photo → deskewed images with the table grid lines removed.
 * Shadows, noise and grid lines were the main reason Tesseract produced garbage.
 */
export async function preprocessImage(input: Buffer, refWidth = 2000): Promise<PreparedImage> {
  let { data, info } = await sharp(input)
    .rotate() // honour EXIF orientation
    .grayscale()
    .resize({ width: refWidth })
    .median(3)
    .normalise()
    .raw()
    .toBuffer({ resolveWithObject: true });

  let bin = adaptiveThreshold(data, info.width, info.height, 41, 12);
  const skew = estimateSkew(bin, info.width, info.height);
  if (Math.abs(skew) > 0.2) {
    const rotated = await sharp(data, { raw: { width: info.width, height: info.height, channels: 1 } })
      .rotate(-skew, { background: '#ffffff' })
      .resize({ width: refWidth })
      .toColourspace('b-w')
      .raw()
      .toBuffer({ resolveWithObject: true });
    data = rotated.data;
    info = rotated.info;
    bin = adaptiveThreshold(data, info.width, info.height, 41, 12);
  }
  const W = info.width, H = info.height;
  const clean = removeLines(bin, W, H);

  const textPng = await toPng(clean, data, W, H, true);
  const digitPngs: { png: Buffer; scale: number }[] = [
    { png: await sharp(await toPng(clean, data, W, H, false)).median(3).png().toBuffer(), scale: 1 },
  ];
  // A second, smaller rendering: Tesseract misreads a spaced slash ("7 / 20") differently
  // at different sizes, so two readings let us vote.
  const small = Math.round(W * 0.7);
  const s = await sharp(data, { raw: { width: W, height: H, channels: 1 } })
    .resize({ width: small })
    .extractChannel(0)
    .raw()
    .toBuffer({ resolveWithObject: true });
  const sb = removeLines(adaptiveThreshold(s.data, s.info.width, s.info.height, 31, 12), s.info.width, s.info.height);
  digitPngs.push({ png: await toPng(sb, s.data, s.info.width, s.info.height, false), scale: W / s.info.width });

  return { width: W, skew, textPng, digitPngs };
}

/* ------------------------------------------------------------------ */
/* Table reconstruction                                                */
/* ------------------------------------------------------------------ */

interface Word { text: string; conf: number; x0: number; y0: number; x1: number; y1: number; }
const xc = (w: Word) => (w.x0 + w.x1) / 2;
const yc = (w: Word) => (w.y0 + w.y1) / 2;
const median = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[b.length >> 1] : 0; };

export function collectWords(data: any, scale = 1): Word[] {
  const out: Word[] = [];
  for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? [])
    for (const w of l.words ?? []) {
      const text = (w.text ?? '').replace(BIDI_MARKS, '').trim();
      if (!text) continue;
      out.push({ text, conf: w.confidence ?? 0, x0: w.bbox.x0 * scale, y0: w.bbox.y0 * scale, x1: w.bbox.x1 * scale, y1: w.bbox.y1 * scale });
    }
  return out;
}

interface GradeReading { grade: number; maxGrade: number | null; penalty: number; }

/** All plausible interpretations of one numeric OCR token, incl. repairs of known confusions. */
function interpretNumber(raw: string, rtl = false): GradeReading[] {
  const converted = convertArabicDigits(raw).replace(/\s+(?:من|of|out\s+of)\s+/gi, ' ');
  // two separate numbers in one cell, e.g. "18 من 20" / "18 20" (text is in left→right x order)
  const pair = converted.trim().match(/^(\d{1,3}(?:\.\d{1,2})?)\s+(\d{1,4})$/);
  if (pair) {
    const [l, r] = [parseFloat(pair[1]), parseFloat(pair[2])];
    const [g, m] = rtl ? [r, l] : [l, r];
    return isPlausibleGrade(g, m) ? [{ grade: g, maxGrade: m, penalty: 2 }] : [];
  }
  const t = fixNumericToken(converted).replace(/[^\d./]/g, '');
  const res: GradeReading[] = [];
  const push = (g: number, m: number | null, penalty: number) => {
    if (isPlausibleGrade(g, m)) res.push({ grade: g, maxGrade: m, penalty });
  };
  const frac = t.match(/^(\d{1,3}(?:\.\d{1,2})?)\/(\d{1,4})$/);
  if (frac) {
    const [a, b] = [frac[1], parseFloat(frac[2])];
    const twoDecimals = /\.\d\d$/.test(a);
    push(parseFloat(a), b, twoDecimals ? 12 : 0);
    // "7 / 20" is often read as "71/20" or "12.5 / 20" as "12.57/20": the space+slash became 7 or 1
    if (/[71]$/.test(a) && a.length >= 2) {
      const penalty = !isPlausibleGrade(parseFloat(a), b) ? 3 : twoDecimals ? 4 : 15;
      push(parseFloat(a.slice(0, -1).replace(/\.$/, '')), b, penalty);
    }
    return res;
  }
  const plain = t.match(/^(\d{1,3}(?:\.\d{1,2})?)$/);
  if (plain) push(parseFloat(plain[1]), null, 0);
  // "20720" / "19720"  → 20/20, 19/20 (slash read as 7 or 1)
  const glued = t.match(/^(\d{1,2}(?:\.\d)?)[71](10|20|25|30|40|50|60|100)$/);
  if (glued) push(parseFloat(glued[1]), parseFloat(glued[2]), 6);
  return res;
}

const COMMON_MAXES = new Set([5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 75, 80, 90, 100, 120, 150, 200]);

interface Row { yc: number; words: Word[]; nums: { w: Word; pass: number }[]; }

function buildRows(nameWords: Word[]): Row[] {
  const sorted = [...nameWords].sort((a, b) => yc(a) - yc(b));
  const tol = Math.max(12, median(sorted.map(w => w.y1 - w.y0)) * 0.75);
  const rows: Row[] = [];
  for (const w of sorted) {
    const r = rows[rows.length - 1];
    if (r && Math.abs(yc(w) - r.yc) <= tol) {
      r.words.push(w);
      r.yc = r.words.reduce((s, x) => s + yc(x), 0) / r.words.length;
    } else rows.push({ yc: yc(w), words: [w], nums: [] });
  }
  return rows;
}

/**
 * Rebuild the table from word positions: names from the language pass, numbers from
 * digit-only passes, grouped into rows by height and into columns by x-position.
 * The serial-number column (1, 2, 3, …) is detected and ignored.
 */
export function reconstructTable(nameWords: Word[], numberPasses: Word[][], pageWidth: number): ExtractedStudentResult[] {
  const letters = nameWords.filter(w => {
    const t = w.text.replace(/[^A-Za-z\u0600-\u06FF]|[\u0660-\u0669\u06F0-\u06F9]/g, '');
    if (/^(من|of)$/i.test(t)) return false; // "18 من 20" connector, not part of a name
    // longer words are kept even at low confidence (they're usually right); 2-letter crumbs need more
    return (t.length >= 3 && w.conf >= 15) || (t.length === 2 && w.conf >= 50);
  });
  if (letters.length === 0) return [];
  const rows = buildRows(letters);
  const rowH = median(letters.map(w => w.y1 - w.y0));
  const rowGap = rows.length > 1 ? median(rows.slice(1).map((r, i) => r.yc - rows[i].yc)) : rowH * 2;
  const maxDist = Math.min(rowGap * 0.5, rowH * 1.2);

  // attach every numeric token to its row
  numberPasses.forEach((words, pass) => {
    for (const w of words) {
      if (!/^[\d٠-٩۰-۹./\s]+$/.test(w.text) && !/^(من|of)$/i.test(w.text)) continue;
      if (/^(من|of)$/i.test(w.text)) continue;
      // ignore digits that sit on top of a name (noise from the digit-only pass)
      if (letters.some(l => w.x0 < l.x1 && w.x1 > l.x0 && Math.abs(yc(w) - yc(l)) < rowH)) continue;
      let best: Row | null = null, bd = Infinity;
      for (const r of rows) { const d = Math.abs(yc(w) - r.yc); if (d < bd) { bd = d; best = r; } }
      if (best && bd <= maxDist) best.nums.push({ w, pass });
    }
  });

  const isArabic = letters.filter(w => /[\u0600-\u06FF]/.test(w.text)).length > letters.length / 2;

  // merge numbers of the same pass that sit in one cell ("18 من 20", "18 / 20")
  for (const r of rows) {
    const merged: { w: Word; pass: number }[] = [];
    for (let pass = 0; pass < numberPasses.length; pass++) {
      const ns = r.nums.filter(n => n.pass === pass).sort((a, b) => a.w.x0 - b.w.x0);
      for (const n of ns) {
        const last = merged[merged.length - 1];
        if (last && last.pass === pass && n.w.x0 - last.w.x1 < rowH * 2.5 && !last.w.text.includes(' ')) {
          const slash = last.w.text.endsWith('/') || n.w.text.startsWith('/');
          last.w = {
            text: slash ? last.w.text + n.w.text : `${last.w.text} ${n.w.text}`,
            conf: Math.min(last.w.conf, n.w.conf),
            x0: last.w.x0, y0: Math.min(last.w.y0, n.w.y0), x1: n.w.x1, y1: Math.max(last.w.y1, n.w.y1),
          };
        } else merged.push({ w: { ...n.w }, pass });
      }
    }
    r.nums = merged.filter(n => interpretNumber(n.w.text, isArabic).length > 0);
  }

  // cluster numbers into columns by x
  const all = rows.flatMap((r, ri) => r.nums.map(n => ({ ...n, ri })));
  all.sort((a, b) => xc(a.w) - xc(b.w));
  const cols: (typeof all)[] = [];
  for (const n of all) {
    const c = cols[cols.length - 1];
    if (c && xc(n.w) - xc(c[c.length - 1].w) < pageWidth * 0.06) c.push(n);
    else cols.push([n]);
  }
  const colInfo = cols.map(c => {
    const perRow = new Map<number, number>();
    for (const n of c) {
      const v = interpretNumber(n.w.text, isArabic)[0];
      if (v && !perRow.has(n.ri)) perRow.set(n.ri, v.maxGrade === null ? v.grade : NaN);
    }
    const ris = [...perRow.keys()].sort((a, b) => a - b);
    let consecutive = 0;
    for (let i = 1; i < ris.length; i++) if (perRow.get(ris[i])! - perRow.get(ris[i - 1])! === ris[i] - ris[i - 1]) consecutive++;
    const isSerial = ris.length >= 3 && consecutive / (ris.length - 1) >= 0.6;
    const hasSlash = c.filter(n => n.w.text.includes('/')).length;
    return { c, rowsCovered: new Set(c.map(n => n.ri)).size, isSerial, hasSlash, x0: Math.min(...c.map(n => n.w.x0)), x1: Math.max(...c.map(n => n.w.x1)) };
  });
  const gradeCol = colInfo
    .filter(ci => !ci.isSerial)
    .sort((a, b) => b.rowsCovered - a.rowsCovered || b.hasSlash - a.hasSlash)[0];
  if (!gradeCol) return [];

  const results: ExtractedStudentResult[] = [];
  const langPass = numberPasses.length - 1;
  rows.forEach((row, ri) => {
    const nameWordsInRow = row.words
      .filter(w => !(xc(w) >= gradeCol.x0 && xc(w) <= gradeCol.x1)) // e.g. the word "من" in "18 من 20"
      .sort((a, b) => (isArabic ? xc(b) - xc(a) : xc(a) - xc(b)));
    const name = cleanName(nameWordsInRow.map(w => w.text).join(' '));
    if (name.replace(/\s/g, '').length < 2 || HEADER_WORDS.test(name) || nameWordsInRow.every(w => HEADER_WORDS.test(cleanName(w.text)))) return;

    // vote between the readings of this cell from the different passes
    // The language pass is unreliable for Latin digits, so it only votes for Arabic-Indic
    // digits (١٨) or when the digit passes found nothing in this cell.
    const all = gradeCol.c.filter(n => n.ri === ri);
    const digitOnly = all.filter(n => n.pass !== langPass);
    const cell = all.filter(n => n.pass !== langPass || /[٠-٩۰-۹]/.test(n.w.text) || digitOnly.length === 0);
    const votes = new Map<string, { r: GradeReading; score: number; passes: Set<number>; conf: number }>();
    for (const n of cell) for (const r of interpretNumber(n.w.text, isArabic)) {
      const key = `${r.grade}|${r.maxGrade}`;
      const v = votes.get(key) ?? { r, score: 0, passes: new Set<number>(), conf: 0 };
      v.score += Math.max(5, n.w.conf) - r.penalty * 3;
      v.passes.add(n.pass);
      v.conf = Math.max(v.conf, n.w.conf);
      votes.set(key, v);
    }
    const ranked = [...votes.values()].sort((a, b) => b.passes.size - a.passes.size || b.score - a.score);
    const win = ranked[0];
    if (!win) return;
    const nameConf = nameWordsInRow.reduce((s, w) => s + w.conf, 0) / Math.max(1, nameWordsInRow.length);
    let conf = Math.min(nameConf, Math.max(win.conf, 40)) / 100;
    if (win.r.penalty > 0 || (ranked[1] && ranked[1].passes.size === win.passes.size)) conf *= 0.75; // flag for review
    results.push({
      name,
      grade: win.r.grade,
      maxGrade: win.r.maxGrade,
      confidence: Math.max(0.05, Math.min(0.99, conf)),
      rawText: `${name} ${cell.map(n => n.w.text).join(' ')}`,
    });
  });

  // fill a missing max grade from the column's common max ("18" in a column of "x/20")
  const maxes = results.map(r => r.maxGrade).filter((m): m is number => m !== null);
  const commonMax = maxes.length >= results.length / 2 ? median(maxes) : null;
  if (commonMax) for (const r of results) if (r.maxGrade === null && r.grade <= commonMax) r.maxGrade = commonMax;
  // a max that disagrees with the rest of the sheet ("11/71" when everyone else is "/20") is a misread
  for (const r of results) {
    if (commonMax && r.maxGrade !== null && r.maxGrade !== commonMax) r.confidence = Math.min(r.confidence, 0.4);
    if (r.maxGrade !== null && !COMMON_MAXES.has(r.maxGrade)) r.confidence = Math.min(r.confidence, 0.4);
  }
  return results;
}

/* ------------------------------------------------------------------ */
/* Tesseract                                                           */
/* ------------------------------------------------------------------ */

function getLangPath(): string {
  // TESSDATA_PATH lets you point at a folder with better models (e.g. tessdata_best)
  if (process.env.TESSDATA_PATH && fs.existsSync(path.join(process.env.TESSDATA_PATH, 'eng.traineddata'))) {
    return process.env.TESSDATA_PATH;
  }
  const candidates = [process.cwd(), path.resolve(__dirname, '../../'), path.resolve(__dirname, '../'), __dirname];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, 'eng.traineddata'))) return c;
  }
  return '.';
}

export class BackendOCRService {
  private workers = new Map<string, Promise<any>>();
  private queue: Promise<unknown> = Promise.resolve();

  private getWorker(key: 'eng' | 'ara' | 'digits') {
    if (!this.workers.has(key)) {
      this.workers.set(
        key,
        (async () => {
          // Never mix eng+ara in one pass: on English sheets the Arabic model hallucinates
          // Arabic glyphs and bidi-reorders the line (grade and serial number swap places).
          const worker = await createWorker(key === 'ara' ? ['ara'] : ['eng'], 1, { langPath: getLangPath(), gzip: false, cacheMethod: 'none' });
          await worker.setParameters(
            key === 'digits'
              ? { tessedit_pageseg_mode: PSM.SPARSE_TEXT, tessedit_char_whitelist: '0123456789/.' }
              // Read ROW BY ROW. The default (auto) mode reads tables column by column — all
              // names, then all grades — which is what paired names with the wrong grades.
              : { tessedit_pageseg_mode: PSM.SINGLE_BLOCK, preserve_interword_spaces: '1' }
          );
          return worker;
        })()
      );
    }
    return this.workers.get(key)!;
  }

  private async run(key: 'eng' | 'ara' | 'digits', png: Buffer) {
    const worker = await this.getWorker(key);
    return (await worker.recognize(png, {}, { text: true, blocks: true })).data;
  }

  /** Requests are serialised so concurrent scans don't fight over the shared workers. */
  recognize(imageBufferOrBase64: Buffer | string, lang: OcrLanguage = 'auto') {
    const job = this.queue.then(() => this.recognizeNow(imageBufferOrBase64, lang));
    this.queue = job.catch(() => undefined);
    return job;
  }

  private async recognizeNow(
    imageBufferOrBase64: Buffer | string,
    lang: OcrLanguage
  ): Promise<{ rawText: string; extracted: ExtractedStudentResult[]; skew: number }> {
    const buffer =
      typeof imageBufferOrBase64 === 'string'
        ? Buffer.from(imageBufferOrBase64.replace(/^data:image\/\w+;base64,/, ''), 'base64')
        : imageBufferOrBase64;

    const prep = await preprocessImage(buffer);
    const digitWords: Word[][] = [];
    for (const d of prep.digitPngs) digitWords.push(collectWords(await this.run('digits', d.png), d.scale));

    const attempt = async (key: 'eng' | 'ara') => {
      const data = await this.run(key, prep.textPng);
      const words = collectWords(data);
      // the language pass can also read Arabic-Indic digits (١٨), so it votes on numbers too
      let extracted = reconstructTable(words, [...digitWords, words], prep.width);
      // fallback: plain line parsing
      if (extracted.length === 0) {
        extracted = [];
        for (const b of data.blocks ?? []) for (const p of b.paragraphs ?? []) for (const l of p.lines ?? []) {
          const row = parseRow(l.text ?? '');
          if (row) extracted.push({ ...row, confidence: Math.max(0.05, Math.min(0.9, (l.confidence ?? 0) / 100)), rawText: (l.text ?? '').trim() });
        }
      }
      return { rawText: (data.text as string) || '', extracted };
    };

    let best: { rawText: string; extracted: ExtractedStudentResult[] };
    if (lang === 'eng') best = await attempt('eng');
    else if (lang === 'ara') best = await attempt('ara');
    else {
      const e = await attempt('eng');
      const a = await attempt('ara');
      const score = (r: typeof e) => r.extracted.reduce((s, x) => s + x.confidence, 0);
      best = score(a) > score(e) ? a : e;
    }

    console.log(`[OCR] lang=${lang} skew=${prep.skew.toFixed(2)}° extracted=${best.extracted.length}`);
    return { ...best, skew: prep.skew };
  }
}

export const backendOcrService = new BackendOCRService();
