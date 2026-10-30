import { backendOcrService, namesFromRawText } from './ocr.service';
import type { ExtractedNameResult, ExtractedStudentResult, OcrLanguage } from './ocr.service';
import { GeminiOcrError, getGeminiModels, isGeminiConfigured, recognizeWithGemini } from './gemini-ocr.service';

export type OcrProviderName = 'gemini' | 'tesseract';

export interface NamesOutcome {
  rawText: string;
  names: ExtractedNameResult[];
  provider: OcrProviderName;
  model?: string;
  fallbackReason?: string;
  warnings: string[];
}

export interface OcrOutcome {
  rawText: string;
  extracted: ExtractedStudentResult[];
  provider: OcrProviderName;
  model?: string;
  /** Set when the preferred engine failed and the offline Tesseract engine answered instead. */
  fallbackReason?: string;
  warnings: string[];
}

/**
 * OCR_PROVIDER = auto (default) | gemini | tesseract
 *   auto      → Gemini when GEMINI_API_KEY is set, otherwise Tesseract
 *   gemini    → Gemini (falls back to Tesseract on failure unless OCR_FALLBACK_TO_TESSERACT=false)
 *   tesseract → offline only; nothing leaves the server
 */
export function getConfiguredProvider(): { provider: OcrProviderName; reason?: string } {
  const wanted = (process.env.OCR_PROVIDER || 'auto').trim().toLowerCase();
  if (wanted === 'tesseract') return { provider: 'tesseract' };
  if (isGeminiConfigured()) return { provider: 'gemini' };
  return {
    provider: 'tesseract',
    reason: wanted === 'gemini' ? 'OCR_PROVIDER=gemini but GEMINI_API_KEY is not set' : undefined,
  };
}

export function describeOcrConfig() {
  const { provider, reason } = getConfiguredProvider();
  return {
    provider,
    models: provider === 'gemini' ? getGeminiModels() : [],
    geminiConfigured: isGeminiConfigured(),
    fallbackToTesseract: process.env.OCR_FALLBACK_TO_TESSERACT !== 'false',
    note: reason,
  };
}

function toBuffer(image: Buffer | string): Buffer {
  return typeof image === 'string' ? Buffer.from(image.replace(/^data:[^;]+;base64,/, ''), 'base64') : image;
}

export class OcrManager {
  async recognize(image: Buffer | string, lang: OcrLanguage = 'auto'): Promise<OcrOutcome> {
    const buffer = toBuffer(image);
    const { provider, reason } = getConfiguredProvider();

    if (provider === 'gemini') {
      try {
        const res = await recognizeWithGemini(buffer, lang);
        const warnings: string[] = [];
        for (const d of res.droppedDetails.slice(0, 5)) warnings.push(`Skipped "${d.name}": ${d.reason}`);
        if (res.droppedDetails.length > 5) warnings.push(`…and ${res.droppedDetails.length - 5} more skipped rows`);
        console.log(`[OCR] provider=gemini model=${res.model} lang=${lang} extracted=${res.extracted.length} dropped=${res.droppedRows}`);
        return { rawText: res.rawText, extracted: res.extracted, provider: 'gemini', model: res.model, warnings };
      } catch (err: any) {
        const msg = err instanceof GeminiOcrError ? err.message : `Gemini failed: ${err?.message ?? err}`;
        console.warn(`[OCR] Gemini failed: ${msg}`);
        if (process.env.OCR_FALLBACK_TO_TESSERACT === 'false') throw new Error(msg);
        return this.runTesseract(buffer, lang, msg);
      }
    }
    return this.runTesseract(buffer, lang, reason);
  }

  /** Attendance scan: only the names on the page (no grades needed). */
  async recognizeNames(image: Buffer | string, lang: OcrLanguage = 'auto'): Promise<NamesOutcome> {
    const buffer = toBuffer(image);
    const { provider, reason } = getConfiguredProvider();

    if (provider === 'gemini') {
      try {
        const res = await recognizeWithGemini(buffer, lang, 'names');
        const warnings: string[] = [];
        for (const d of res.droppedDetails.slice(0, 5)) warnings.push(`Skipped "${d.name}": ${d.reason}`);
        if (res.droppedDetails.length > 5) warnings.push(`…and ${res.droppedDetails.length - 5} more skipped rows`);
        console.log(`[OCR] provider=gemini mode=names model=${res.model} lang=${lang} names=${res.names.length} dropped=${res.droppedRows}`);
        return { rawText: res.rawText, names: res.names, provider: 'gemini', model: res.model, warnings };
      } catch (err: any) {
        const msg = err instanceof GeminiOcrError ? err.message : `Gemini failed: ${err?.message ?? err}`;
        console.warn(`[OCR] Gemini failed: ${msg}`);
        if (process.env.OCR_FALLBACK_TO_TESSERACT === 'false') throw new Error(msg);
        return this.runTesseractNames(buffer, lang, msg);
      }
    }
    return this.runTesseractNames(buffer, lang, reason);
  }

  private async runTesseractNames(buffer: Buffer, lang: OcrLanguage, fallbackReason?: string): Promise<NamesOutcome> {
    const res = await backendOcrService.recognizeText(buffer, lang);
    const names = namesFromRawText(res.rawText);
    const warnings = fallbackReason
      ? ['Used the offline Tesseract engine, which is much less accurate on handwritten Arabic. Check every name.']
      : [];
    console.log(`[OCR] provider=tesseract mode=names lang=${lang} names=${names.length}`);
    return { rawText: res.rawText, names, provider: 'tesseract', fallbackReason, warnings };
  }

  private async runTesseract(buffer: Buffer, lang: OcrLanguage, fallbackReason?: string): Promise<OcrOutcome> {
    const res = await backendOcrService.recognize(buffer, lang);
    const warnings = fallbackReason
      ? ['Used the offline Tesseract engine, which is much less accurate on handwritten Arabic. Check every name.']
      : [];
    return {
      rawText: res.rawText,
      extracted: res.extracted,
      provider: 'tesseract',
      fallbackReason,
      warnings,
    };
  }
}

export const ocrManager = new OcrManager();
