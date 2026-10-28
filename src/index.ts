import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import syncRoutes from './routes/sync.routes';
import spreadsheetRoutes from './routes/spreadsheet.routes';
import ocrRoutes from './routes/ocr.routes';
import { authPageRouter, authApiRouter } from './routes/auth.routes';
import { getRedirectUri, isGoogleSignInConfigured } from './services/google-oauth.service';
import { hasGoogleCredentials, getServiceAccountEmail } from './services/google-auth';
import { describeOcrConfig } from './services/ocr.manager';
import { apiKeyAuth, hasValidApiKey, isApiKeyRequired } from './middleware/api-key';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

app.use((req, _res, next) => {
  // never log the query of the sign-in pages: it carries one-time codes
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path.startsWith('/auth/') ? req.path : req.url}`);
  next();
});

// "Continue with Google" pages: opened in the phone's browser, so they cannot carry the app's
// x-api-key header and sit outside /api (they are protected by a signed `state` instead).
app.use('/auth/google', authPageRouter);

// Everything under /api requires the access key when APP_API_KEY is set (see middleware/api-key.ts)
app.use('/api', apiKeyAuth);

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

app.listen(port, () => {
  if (!isApiKeyRequired()) {
    console.warn(
      process.env.RENDER || process.env.NODE_ENV === 'production'
        ? 'SECURITY: APP_API_KEY is not set — anyone with this URL can use your OCR quota and write to your shared sheets. Set APP_API_KEY.'
        : 'APP_API_KEY not set: API is open (fine for local development).'
    );
  }
  const email = getServiceAccountEmail();
  console.log(`GradeScan Backend API listening on port ${port}`);
  if (isGoogleSignInConfigured()) {
    console.log('Google sign-in: ENABLED — teachers tap "Continue with Google" in the app, no sharing needed.');
    console.log(`  Authorized redirect URI to register in Google Cloud Console: ${getRedirectUri()}`);
  } else {
    console.warn('Google sign-in: not configured (set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET, see DEPLOY.md)');
  }
  if (hasGoogleCredentials()) {
    console.log(`Google service account: READY${email ? ` (${email})` : ''} — sheets must be shared with that e-mail as Editor.`);
  } else if (!isGoogleSignInConfigured()) {
    console.warn('Google Sheets: NOT CONFIGURED — set up Google sign-in or add backend/service-account.json');
  }
  const ocr = describeOcrConfig();
  if (ocr.provider === 'gemini') {
    console.log(`OCR: Gemini (${ocr.models.join(' -> ')})${ocr.fallbackToTesseract ? ', Tesseract fallback' : ''}`);
  } else {
    console.log('OCR: Tesseract (eng + ara) — offline engine');
    console.warn(
      ocr.note ?? 'Handwritten Arabic names need a Gemini key: set GEMINI_API_KEY in backend/.env (see .env.example).'
    );
  }
});
