import crypto from 'crypto';
import { google } from 'googleapis';
import type { Auth } from 'googleapis';

/**
 * "Continue with Google": lets a teacher write grades into THEIR OWN Google Sheet without any
 * key or sharing step. The phone never sees the client secret — the OAuth code exchange happens
 * here:
 *
 *   phone ──opens──▶ GET /auth/google/start?return=<app url>
 *   server ──redirect──▶ Google consent screen
 *   Google ──redirect──▶ GET /auth/google/callback?code&state
 *   server exchanges the code, then sends the browser back to the app with the refresh token
 *   phone stores it and sends it with every sync (header x-google-refresh-token)
 *
 * A refresh token is useless without this server's client secret, so keeping it on the phone
 * does not let anyone else reach the teacher's sheets. All settings are read lazily (dotenv runs
 * after the imports).
 */

// spreadsheets: read + write cells. email/openid: show "Signed in as …" in the app.
const SCOPES = ['openid', 'email', 'https://www.googleapis.com/auth/spreadsheets'];
const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets';
const STATE_TTL_MS = 10 * 60_000;

const clientId = () => (process.env.GOOGLE_OAUTH_CLIENT_ID ?? '').trim();
const clientSecret = () => (process.env.GOOGLE_OAUTH_CLIENT_SECRET ?? '').trim();

export function isGoogleSignInConfigured(): boolean {
  return !!clientId() && !!clientSecret();
}

/** Public https address of this server (Render sets RENDER_EXTERNAL_URL by itself). */
export function getPublicBaseUrl(): string {
  const v = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${process.env.PORT || 3000}`).trim();
  return v.replace(/\/+$/, '');
}

/** Register exactly this address under "Authorized redirect URIs" in Google Cloud Console. */
export function getRedirectUri(): string {
  return `${getPublicBaseUrl()}/auth/google/callback`;
}

/* ---------------------------- return-URL allow-list ---------------------------- */

function allowedSchemes(): string[] {
  const own = (process.env.APP_SCHEME || 'gradescan')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(Boolean)
    .map(s => `${s}:`);
  // exp:/exps: = Expo Go while developing
  return ['exp:', 'exps:', ...own];
}

/**
 * The browser is sent back to this address with the teacher's token attached, so it must be an
 * app link (never an arbitrary website, or anyone could use /start to steal a token).
 */
export function isAllowedReturnUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 600 || /[\s<>"'`]/.test(value)) return false;
  try {
    return allowedSchemes().includes(new URL(value).protocol.toLowerCase());
  } catch {
    return false;
  }
}

/* ------------------------------ signed state ------------------------------ */

const b64 = (buf: Buffer | string) => Buffer.from(buf).toString('base64url');
const hmac = (data: string) =>
  crypto.createHmac('sha256', `gradescan-oauth-state:${clientSecret()}`).update(data).digest();

export function signState(returnUrl: string, now = Date.now()): string {
  const payload = b64(JSON.stringify({ r: returnUrl, e: now + STATE_TTL_MS, n: crypto.randomBytes(8).toString('hex') }));
  return `${payload}.${b64(hmac(payload))}`;
}

/** Returns the app address the sign-in must return to, or null when the state is forged/expired. */
export function verifyState(state: unknown, now = Date.now()): string | null {
  if (typeof state !== 'string') return null;
  const [payload, sig] = state.split('.');
  if (!payload || !sig) return null;
  const expected = hmac(payload);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return null;
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) return null;
  try {
    const { r, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'number' || e < now) return null;
    return isAllowedReturnUrl(r) ? r : null;
  } catch {
    return null;
  }
}

/* --------------------------------- Google --------------------------------- */

function newClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(clientId(), clientSecret(), getRedirectUri());
}

export function buildAuthUrl(returnUrl: string): string {
  return newClient().generateAuthUrl({
    access_type: 'offline', // we need a refresh token so the phone can sync later
    prompt: 'consent', // always hand out a refresh token (Google only sends it on the first consent otherwise)
    scope: SCOPES,
    state: signState(returnUrl),
  });
}

export class GoogleSignInError extends Error {}

export async function exchangeCode(code: string): Promise<{ refreshToken: string; email: string | null }> {
  const client = newClient();
  let tokens: Auth.Credentials;
  try {
    tokens = (await client.getToken(code)).tokens;
  } catch (err: any) {
    throw new GoogleSignInError(`Google did not accept the sign-in (${String(err?.message ?? err).slice(0, 120)})`);
  }

  // The consent screen lets people untick individual permissions: without Sheets access nothing can be saved.
  if (!(tokens.scope ?? '').includes(SHEETS_SCOPE)) {
    throw new GoogleSignInError('Please allow access to Google Sheets when Google asks, otherwise grades cannot be saved.');
  }
  if (!tokens.refresh_token) {
    throw new GoogleSignInError(
      'Google did not return a long-lived sign-in. Remove GradeScan at myaccount.google.com/permissions and sign in again.'
    );
  }

  let email: string | null = null;
  try {
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId() });
      email = ticket.getPayload()?.email ?? null;
    }
  } catch {
    /* the e-mail is only shown in the app; signing in still works without it */
  }
  return { refreshToken: tokens.refresh_token, email };
}

/** Credentials that act as the signed-in teacher; google-auth-library refreshes the access token by itself. */
export function createUserAuth(refreshToken: string): Auth.OAuth2Client {
  const client = new google.auth.OAuth2(clientId(), clientSecret());
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

/** Best effort: tell Google to forget this sign-in (used by "Sign out"). */
export async function revokeRefreshToken(refreshToken: string): Promise<void> {
  try {
    await newClient().revokeToken(refreshToken);
  } catch {
    /* already revoked or unreachable: the phone forgets it either way */
  }
}

/** Query string for the way back into the app. */
export function appendParams(url: string, params: Record<string, string | null | undefined>): string {
  const q = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
    .join('&');
  if (!q) return url;
  return `${url}${url.includes('?') ? '&' : '?'}${q}`;
}
