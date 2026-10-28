import crypto from 'crypto';
import type { NextFunction, Request, Response } from 'express';

const digest = (s: string) => crypto.createHash('sha256').update(s).digest();

/** True when APP_API_KEY is configured, i.e. the API is locked. */
export function isApiKeyRequired(): boolean {
  return !!process.env.APP_API_KEY?.trim();
}

/** True when the request carries the right key (or no key is configured). */
export function hasValidApiKey(req: Request): boolean {
  const expected = process.env.APP_API_KEY?.trim();
  if (!expected) return true;
  const given = String(req.header('x-api-key') ?? '').trim();
  // hash both sides so the comparison is constant-time and length-independent
  return crypto.timingSafeEqual(digest(given), digest(expected));
}

/**
 * Locks the API when APP_API_KEY is set. Needed as soon as the backend is reachable from the
 * internet (e.g. on Render): without it anyone who finds the URL could spend your Gemini quota
 * through /api/ocr or write into the Google Sheets shared with your service account.
 * With no key configured (local development) everything stays open, as before.
 *
 * The key travels in the `x-api-key` header; `Authorization: Bearer …` is already used by
 * /api/sync for the user's Google token.
 */
export function apiKeyAuth(req: Request, res: Response, next: NextFunction) {
  if (hasValidApiKey(req)) return next();
  return res.status(401).json({ error: 'Invalid or missing access key (x-api-key)' });
}
