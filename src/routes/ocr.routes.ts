import { Router, Request, Response } from 'express';
import type { OcrLanguage } from '../services/ocr.service';
import { ocrManager, describeOcrConfig } from '../services/ocr.manager';
import { ImageInputError, readImageInput } from '../services/image-guard';

const router = Router();

// Which OCR engine is active (no secrets). Handy for a quick check: GET /api/ocr/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(describeOcrConfig());
});

router.post('/', async (req: Request, res: Response) => {
  try {
    // Express 5 leaves req.body undefined when the request has no (JSON) body
    const { image, lang, mode } = req.body ?? {};

    // 400 for anything that is not a readable picture of a sane size (never a 500 / library message)
    const picture = await readImageInput(image);

    // 'eng' | 'ara' | 'auto' — the app picks this from the class roster's script
    const language: OcrLanguage = lang === 'eng' || lang === 'ara' ? lang : 'auto';

    // Attendance scan: only the names on the page, no grades.
    if (mode === 'names') {
      const n = await ocrManager.recognizeNames(picture, language);
      return res.json({
        success: true,
        mode: 'names',
        rawText: n.rawText,
        names: n.names,
        count: n.names.length,
        provider: n.provider,
        model: n.model,
        fallbackReason: n.fallbackReason,
        warnings: n.warnings,
      });
    }

    const { rawText, extracted, provider, model, fallbackReason, warnings } = await ocrManager.recognize(picture, language);
    return res.json({
      success: true,
      rawText,
      extracted,
      count: extracted.length,
      provider,
      model,
      fallbackReason,
      warnings,
    });
  } catch (error: any) {
    if (error instanceof ImageInputError) {
      return res.status(error.status).json({ error: error.message });
    }
    console.error('OCR processing error:', error);
    return res.status(500).json({ error: error.message || 'OCR processing failed' });
  }
});

export default router;
