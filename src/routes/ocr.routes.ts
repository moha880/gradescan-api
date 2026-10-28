import { Router, Request, Response } from 'express';
import type { OcrLanguage } from '../services/ocr.service';
import { ocrManager, describeOcrConfig } from '../services/ocr.manager';

const router = Router();

// Which OCR engine is active (no secrets). Handy for a quick check: GET /api/ocr/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(describeOcrConfig());
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { image, lang } = req.body;
    if (!image) {
      return res.status(400).json({ error: 'Missing image payload (base64 string required)' });
    }

    // 'eng' | 'ara' | 'auto' — the app picks this from the class roster's script
    const language: OcrLanguage = lang === 'eng' || lang === 'ara' ? lang : 'auto';
    const { rawText, extracted, provider, model, fallbackReason, warnings } = await ocrManager.recognize(image, language);
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
    console.error('OCR processing error:', error);
    return res.status(500).json({ error: error.message || 'OCR processing failed' });
  }
});

export default router;
