import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import syncRoutes from './routes/sync.routes';
import spreadsheetRoutes from './routes/spreadsheet.routes';
import ocrRoutes from './routes/ocr.routes';
import { authPageRouter, authApiRouter } from './routes/auth.routes';
import { getRedirectUri, isGoogleSignInConfigured } from './services/google-oauth.service';
import { hasGoogleCredentials, getServiceAccountEmail } from './services/google-auth';
import { describeOcrConfig } from './services/ocr.manager';
import { apiKeyAuth, hasValidApiKey, isApiKeyRequired } from './middleware/api-key';
import { ocrRateLimit } from './middleware/ocr-limit';

/**
 * The HTTP application, without starting a server (index.ts does that), so tests can run the real
 * middleware chain: security headers → access key → body parsing → routes → JSON 404 / JSON errors.
 */

/** Body size limits. Only the photo upload needs a large one; everything else is small JSON. */
const apiBodyLimit = () => process.env.API_BODY_LIMIT?.trim() || '1mb';
const ocrBodyLimit = () => process.env.OCR_BODY_LIMIT?.trim() || '50mb';

const parsers = new Map<string, express.RequestHandler>();
/** One JSON parser per size limit (the limit is read from the environment at request time). */
function jsonBody(limit: string): express.RequestHandler {
  let parser = parsers.get(limit);
  if (!parser) {
    parser = express.json({ limit });
    parsers.set(limit, parser);
  }
  return parser;
}

/** How many reverse proxies sit in front of the server (so req.ip is the caller, not the proxy). */
function trustProxySetting(): number | boolean | undefined {
  const raw = process.env.TRUST_PROXY?.trim();
  if (raw) {
    if (/^\d+$/.test(raw)) return parseInt(raw, 10);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  }
  return process.env.RENDER ? 1 : undefined; // Render always puts one proxy in front
}

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  const proxy = trustProxySetting();
  if (proxy !== undefined) app.set('trust proxy', proxy);

  // Small, always-safe response headers (the sign-in pages are HTML, the API is JSON).
  app.use((_req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  app.use(cors());

  app.use((req, _res, next) => {
    // never log the query of the sign-in pages: it carries one-time codes
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path.startsWith('/auth/') ? req.path : req.url}`);
    next();
  });

  // "Continue with Google" pages: opened in the phone's browser, so they cannot carry the app's
  // x-api-key header and sit outside /api (they are protected by a signed `state` instead). They only
  // read the query string, so no body is parsed for them.
  app.use('/auth/google', authPageRouter);

  // Everything under /api requires the access key when APP_API_KEY is set (see middleware/api-key.ts).
  // The key is checked BEFORE any request body is read: a caller without it never makes the server
  // parse (and hold in memory) a large upload.
  app.use('/api', apiKeyAuth);

  // Photos per phone per hour (the free Gemini quota is shared by every teacher). Before the body is read, so a
  // refused photo is never parsed.
  app.use('/api/ocr', ocrRateLimit);

  // Bodies: large only for the photo upload, 1 MB for everything else.
  app.use('/api/ocr', (req, res, next) => jsonBody(ocrBodyLimit())(req, res, next));
  app.use('/api', (req, res, next) => jsonBody(apiBodyLimit())(req, res, next));

  app.use('/api/sync', syncRoutes);
  app.use('/api/spreadsheet', spreadsheetRoutes);
  app.use('/api/ocr', ocrRoutes);
  app.use('/api/auth', authApiRouter);

  // Open on purpose: the app's "Test connection" button and the host's health check call it.
  // Details (service account e-mail, OCR engine) are only shown to callers with a valid key.
  app.get('/health', (req, res) => {
    const authorized = hasValidApiKey(req);
    const base = {
      status: 'ok',
      service: 'gradescan-api',
      timestamp: new Date().toISOString(),
      authRequired: isApiKeyRequired(),
      authorized,
    };
    if (!authorized) return res.json(base);
    const sheetsReady = hasGoogleCredentials();
    const ocr = describeOcrConfig();
    return res.json({
      ...base,
      googleSheets: sheetsReady ? 'configured' : 'missing_credentials',
      googleSignIn: isGoogleSignInConfigured(),
      googleRedirectUri: isGoogleSignInConfigured() ? getRedirectUri() : null,
      serviceAccountEmail: getServiceAccountEmail(),
      ocr: { provider: ocr.provider, models: ocr.models },
    });
  });

  // Anything else: JSON, never Express's default HTML page.
  app.use((req, res) => {
    res.status(404).json({ error: `Not found: ${req.method} ${req.path}` });
  });

  // Errors: JSON, no stack trace, no library internals. Client mistakes keep their 4xx status
  // (malformed JSON → 400, body too large → 413); everything else is a plain 500 and is logged here.
  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    if (res.headersSent) return;
    const status = Number(err?.status ?? err?.statusCode);
    if (err?.type === 'entity.too.large' || status === 413) {
      return res.status(413).json({ error: 'The request is too large.' });
    }
    if (err?.type === 'entity.parse.failed' || (status >= 400 && status < 500)) {
      return res.status(status >= 400 && status < 500 ? status : 400).json({
        error: err?.type === 'entity.parse.failed' ? 'The request body is not valid JSON.' : 'Bad request.',
      });
    }
    console.error('Unhandled error:', err?.message || err);
    return res.status(500).json({ error: 'Internal server error' });
  });

  return app;
}

export const app = createApp();
