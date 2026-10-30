import type { NextFunction, Request, Response } from 'express';

/**
 * How many photos one phone may send to the reader (POST /api/ocr) per hour.
 *
 * Why: every teacher's phone shares ONE access key (it is inside the app), so the key cannot tell phones apart,
 * and the free Gemini quota belongs to the whole server. Without a limit one phone (or one person who took the key
 * out of the app file) could use up the day's quota for everybody.
 *
 * Two buckets, both counted in memory (one server process; a restart or a wake-up from sleep starts them empty):
 *   - the phone: a random id the app makes on first start and sends as `x-client-id`. It can be made up by anyone,
 *     which is why there is a second bucket;
 *   - the address the request came from, 5x wider (a whole school can sit behind one public address).
 * The limit is OCR_SCANS_PER_HOUR (default 200 per phone, so 1000 per address).
 */
const HOUR = 3_600_000;
const PRUNE_AT = 5000; // entries; buckets with nothing in the last hour are dropped once the log grows past this
const log = new Map<string, number[]>();

export function ocrScansPerHour(): number {
  const n = parseInt(process.env.OCR_SCANS_PER_HOUR ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : 200;
}

/** The phone's own random id, when it sent a sane one (letters, digits, - and _ only, so it is safe in a log line). */
export function clientIdFrom(req: Request): string | null {
  const raw = req.header('x-client-id');
  const id = typeof raw === 'string' ? raw.trim() : '';
  return /^[A-Za-z0-9_-]{8,64}$/.test(id) ? id : null;
}

const recentOf = (key: string, now: number): number[] => (log.get(key) ?? []).filter(t => now - t < HOUR);

function prune(now: number): void {
  for (const [key, times] of log) {
    if (times.length === 0 || now - times[times.length - 1] >= HOUR) log.delete(key);
  }
}

/**
 * Counts one photo for this caller. Returns 0 when it may go on, otherwise the number of seconds until the oldest
 * photo that counts against the full bucket is more than an hour old.
 */
export function takeOcrSlot(clientId: string | null, ip: string | undefined, now = Date.now()): number {
  if (log.size > PRUNE_AT) prune(now);
  const limit = ocrScansPerHour();
  const buckets: { key: string; max: number }[] = [{ key: `ip:${ip || 'unknown'}`, max: limit * 5 }];
  if (clientId) buckets.unshift({ key: `c:${clientId}`, max: limit });

  // look at every bucket before counting in any, so a refused photo does not use up the other bucket
  let wait = 0;
  for (const b of buckets) {
    const recent = recentOf(b.key, now);
    if (recent.length >= b.max) wait = Math.max(wait, Math.ceil((recent[0] + HOUR - now) / 1000));
  }
  if (wait > 0) return Math.max(wait, 1);
  for (const b of buckets) log.set(b.key, [...recentOf(b.key, now), now]);
  return 0;
}

/** Test hooks. */
export function resetOcrRateLimit(): void { log.clear(); }
export function ocrRateLimitSize(): number { return log.size; }

/** Express middleware for POST /api/ocr. Runs after the access key check and before the body is read. */
export function ocrRateLimit(req: Request, res: Response, next: NextFunction) {
  if (req.method !== 'POST') return next();
  const wait = takeOcrSlot(clientIdFrom(req), req.ip);
  if (wait === 0) return next();
  const minutes = Math.max(1, Math.ceil(wait / 60));
  res.setHeader('Retry-After', String(wait));
  return res.status(429).json({
    error: `Too many photos were sent from this phone in the last hour. Please try again in about ${minutes} minute${minutes === 1 ? '' : 's'}.`,
    retryAfterSeconds: wait,
  });
}
