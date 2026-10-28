import { google, Auth } from 'googleapis';
import fs from 'fs';
import path from 'path';
import { createUserAuth, isGoogleSignInConfigured } from './google-oauth.service';

/**
 * Creates authenticated Google API credentials, in this order:
 *   1. the signed-in teacher ("Continue with Google" refresh token) — works on any sheet they can edit
 *   2. a user OAuth access token sent as `Authorization: Bearer` (older clients)
 *   3. the shared service account (service-account.json / GOOGLE_SERVICE_ACCOUNT_JSON); the sheet
 *      must be shared with its e-mail
 */
export function createGoogleAuth(accessToken?: string, refreshToken?: string): Auth.GoogleAuth | Auth.OAuth2Client {
  if (refreshToken && isGoogleSignInConfigured()) {
    return createUserAuth(refreshToken);
  }

  if (accessToken && accessToken !== 'mock_token') {
    const oauth2 = new google.auth.OAuth2();
    oauth2.setCredentials({ access_token: accessToken });
    return oauth2;
  }

  const jsonInline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const jsonPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    path.join(process.cwd(), 'service-account.json');

  if (jsonInline) {
    const credentials = JSON.parse(jsonInline);
    return new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  if (fs.existsSync(jsonPath)) {
    return new google.auth.GoogleAuth({
      keyFile: jsonPath,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  }

  throw new Error(
    isGoogleSignInConfigured()
      ? 'Sign in with Google (Settings) to save grades to your sheet.'
      : 'Google Sheets is not set up on the server. Set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET ' +
          '(teachers sign in with Google) or add a service-account.json and share the sheet with its e-mail.'
  );
}

/** Whose credentials createGoogleAuth() will use — decides which error advice is right. */
export function credentialMode(accessToken?: string, refreshToken?: string): 'user' | 'service' {
  return (refreshToken && isGoogleSignInConfigured()) || (accessToken && accessToken !== 'mock_token') ? 'user' : 'service';
}

/** True when the server itself holds a Google identity (service account). Teachers may still sign in on top of that. */
export function hasGoogleCredentials(): boolean {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return true;
  const jsonPath =
    process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
    path.join(process.cwd(), 'service-account.json');
  return fs.existsSync(jsonPath);
}

export function getServiceAccountEmail(): string | null {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email ?? null;
    }
    const jsonPath =
      process.env.GOOGLE_SERVICE_ACCOUNT_PATH ||
      path.join(process.cwd(), 'service-account.json');
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8')).client_email ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}
