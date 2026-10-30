import crypto from 'crypto';
import { google } from 'googleapis';
import type { Auth } from 'googleapis';

/**
 * "Continue with Google": the teacher signs in with their Google account so the app knows who they
 * are (name and e-mail). The app asks for the per-file Drive permission in the same trip (`drive: true`), so the
 * attendance sheets can be created in the teacher's own Drive without a second Google page in the middle of the work;
 * the teacher may untick it, which exchangeCode reports as `driveGranted: false`. No Sheets permission is ever requested:
 * existing sheets are opened by the server's own Google account (google-auth.ts). The phone never sees the client
 * secret: the OAuth code exchange happens here:
 *
 *   Hosted server (Render, a VPS …):
 *     phone ──opens──▶ GET /auth/google/start?return=<app url>
 *     server ──redirect──▶ Google consent screen
 *     Google ──redirect──▶ GET /auth/google/callback?code&state
 *     server exchanges the code, then sends the browser back to the app with the refresh token
 *   Server on a PC (GOOGLE_REDIRECT_URI set, "relay mode"):
 *     app ──GET /api/auth/google/url──▶ Google consent screen (in the phone's browser)
 *     Google ──redirect──▶ static page on GitHub Pages ──▶ app link with ?code&state
 *     app ──POST /api/auth/google/exchange {code,state}──▶ server returns the refresh token
 *   Either way the phone keeps the token as proof of the sign-in and, when Drive was granted, as the permission
 *   for creating attendance sheets in the teacher's Drive (per-file: it cannot open any other file or sheet).
 *   "Sign out" revokes it again.
 *
 * A refresh token is useless without this server's client secret. All settings are read lazily
 * (dotenv runs after the imports).
 */

// openid/email/profile: who the teacher is (their address and display name), so Google is also the app's
// login. No Sheets permission is requested: the sheets are opened by the server's own Google account, and
// only the ones their owner shared with it.
const SCOPES = ['openid', 'email', 'profile'];
// Asked together with the sign-in (the app passes drive=1) and nowhere else: lets GradeScan create the new attendance sheet in the teacher's
// own Drive. Google classes this scope as non-sensitive: it reaches only the files the app creates itself,
// never the rest of the teacher's Drive.
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file';
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

/**
 * "Relay mode": the server cannot be reached from the internet (it runs on a PC at home or school),
 * so Google is sent back to a small static page (GitHub Pages, see auth-relay/) which hands the
 * one-time code to the app; the app then finishes the sign-in with POST /api/auth/google/exchange.
 */
export function isRelayMode(): boolean {
  return !!(process.env.GOOGLE_REDIRECT_URI ?? '').trim();
}

/** Register exactly this address under "Authorized redirect URIs" in Google Cloud Console. */
export function getRedirectUri(): string {
  const relay = (process.env.GOOGLE_REDIRECT_URI ?? '').trim();
  return relay || `${getPublicBaseUrl()}/auth/google/callback`;
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

/**
 * `alt` is an optional second app link (e.g. the Expo Go link next to the installed app's link).
 * The relay page offers it as a second button; the server never redirects to it.
 */
export function signState(returnUrl: string, now = Date.now(), alt?: string): string {
  const payload = b64(
    JSON.stringify({
      r: returnUrl,
      ...(alt && alt !== returnUrl ? { a: alt } : {}),
      e: now + STATE_TTL_MS,
      n: crypto.randomBytes(8).toString('hex'),
    })
  );
  return `${payload}.${b64(hmac(payload))}`;
}

/** Why a `state` was refused (shown to the person and written to the server log, so a failure can be traced). */
export type StateProblem = 'missing' | 'malformed' | 'bad-signature' | 'expired' | 'bad-return';

export type StateCheck =
  | { ok: true; returnUrl: string }
  | { ok: false; problem: StateProblem; /** only for 'expired': how long ago the link ran out */ expiredForMs?: number };

/** Looks at a `state` the app sent back and says what is wrong with it, if anything. */
export function checkState(state: unknown, now = Date.now()): StateCheck {
  if (typeof state !== 'string' || state.length === 0) return { ok: false, problem: 'missing' };
  const parts = state.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, problem: 'malformed' };
  const [payload, sig] = parts;
  const expected = hmac(payload);
  let given: Buffer;
  try {
    given = Buffer.from(sig, 'base64url');
  } catch {
    return { ok: false, problem: 'malformed' };
  }
  if (given.length !== expected.length || !crypto.timingSafeEqual(given, expected)) {
    return { ok: false, problem: 'bad-signature' };
  }
  try {
    const { r, e } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof e !== 'number') return { ok: false, problem: 'malformed' };
    if (e < now) return { ok: false, problem: 'expired', expiredForMs: now - e };
    return isAllowedReturnUrl(r) ? { ok: true, returnUrl: r } : { ok: false, problem: 'bad-return' };
  } catch {
    return { ok: false, problem: 'malformed' };
  }
}

/** Returns the app address the sign-in must return to, or null when the state is forged/expired. */
export function verifyState(state: unknown, now = Date.now()): string | null {
  const check = checkState(state, now);
  return check.ok ? check.returnUrl : null;
}

/** One line for the person (and the app) saying what happened to the sign-in link. */
export function describeStateProblem(check: Extract<StateCheck, { ok: false }>): string {
  if (check.problem === 'expired') return 'This sign-in link expired. Press Continue with Google again.';
  return `This sign-in link is not valid (${check.problem}). Press Continue with Google again.`;
}

/* --------------------------------- Google --------------------------------- */

function newClient(): Auth.OAuth2Client {
  return new google.auth.OAuth2(clientId(), clientSecret(), getRedirectUri());
}

export function buildAuthUrl(returnUrl: string, alt?: string, opts: { drive?: boolean } = {}): string {
  return newClient().generateAuthUrl({
    access_type: 'offline', // we need a refresh token so the phone can sync later
    prompt: 'consent', // always hand out a refresh token (Google only sends it on the first consent otherwise)
    scope: opts.drive ? [...SCOPES, DRIVE_FILE_SCOPE] : SCOPES,
    state: signState(returnUrl, Date.now(), alt),
  });
}

/** Google credentials that act as the teacher, from the token the phone keeps (used only to create their attendance sheet). */
export function createUserAuthClient(refreshToken: string): Auth.OAuth2Client {
  const client = newClient();
  client.setCredentials({ refresh_token: refreshToken });
  return client;
}

export class GoogleSignInError extends Error {}

export interface GoogleSignInResult {
  refreshToken: string;
  email: string | null;
  /** The display name on the Google account (null when Google did not send one). */
  name: string | null;
  /** The teacher ticked the Drive permission on Google's screen (they can untick it). */
  driveGranted: boolean;
}

export async function exchangeCode(code: string): Promise<GoogleSignInResult> {
  const client = newClient();
  let tokens: Auth.Credentials;
  try {
    tokens = (await client.getToken(code)).tokens;
  } catch (err: any) {
    throw new GoogleSignInError(`Google did not accept the sign-in (${String(err?.message ?? err).slice(0, 120)})`);
  }

  if (!tokens.refresh_token) {
    throw new GoogleSignInError(
      'Google did not return a long-lived sign-in. Remove GradeScan at myaccount.google.com/permissions and sign in again.'
    );
  }

  let email: string | null = null;
  let name: string | null = null;
  try {
    if (tokens.id_token) {
      const ticket = await client.verifyIdToken({ idToken: tokens.id_token, audience: clientId() });
      const payload = ticket.getPayload();
      email = payload?.email ?? null;
      const displayName = typeof payload?.name === 'string' ? payload.name.trim().slice(0, 120) : '';
      name = displayName || null;
    }
  } catch {
    /* the e-mail and name only label the account in the app; signing in still works without them */
  }
  const granted = String(tokens.scope ?? '').split(/\s+/);
  return { refreshToken: tokens.refresh_token, email, name, driveGranted: granted.includes(DRIVE_FILE_SCOPE) };
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
