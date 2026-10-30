import dotenv from 'dotenv';
import { app } from './app';
import { getRedirectUri, isGoogleSignInConfigured, isRelayMode } from './services/google-oauth.service';
import { hasGoogleCredentials, getServiceAccountEmail } from './services/google-auth';
import { describeOcrConfig } from './services/ocr.manager';
import { isApiKeyRequired } from './middleware/api-key';

dotenv.config();

const port = process.env.PORT || 3000;

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
    console.log('Google sign-in: ENABLED — it tells the app who the teacher is (name, e-mail) and, on the same Google page, asks for per-file Drive access (drive.file) so new attendance sheets can be created in the teacher\'s own Drive. It gives GradeScan no access to their other files or sheets.');
    console.log(`  Authorized redirect URI to register in Google Cloud Console: ${getRedirectUri()}`);
    if (isRelayMode()) console.log('  (relay mode: Google returns through that page, the app finishes the sign-in with this server)');
  } else {
    console.warn('Google sign-in: not configured (set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET, see DEPLOY.md)');
  }
  if (hasGoogleCredentials()) {
    console.log(`Google Sheets: READY${email ? ` (account ${email})` : ''} — a teacher's sheet works once they share it with that e-mail as Editor.`);
    console.log('  Attendance mode, "create a new Google Sheet": made in the teacher\'s own Drive with their sign-in permission; needs the Google Drive API enabled in the same Google project and the teacher listed as a Test user while the app is in Testing (DEPLOY.md, Parts 2 and 3).');
  } else {
    console.warn('Google Sheets: NOT SET UP — add backend/service-account.json (DEPLOY.md, Part 2). Until then grades cannot be saved to a sheet; sheets shared as "Anyone with the link can view" can still be read.');
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
