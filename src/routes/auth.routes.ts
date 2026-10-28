import { Router, Request, Response } from 'express';
import {
  appendParams,
  buildAuthUrl,
  exchangeCode,
  getRedirectUri,
  GoogleSignInError,
  isAllowedReturnUrl,
  isGoogleSignInConfigured,
  revokeRefreshToken,
  verifyState,
} from '../services/google-oauth.service';

/**
 * Browser-facing sign-in pages. They live OUTSIDE /api on purpose: a browser cannot send the
 * app's x-api-key header, and nothing here is sensitive without a valid signed `state`.
 */
export const authPageRouter = Router();
/** App-facing calls (protected by the access key like the rest of /api). */
export const authApiRouter = Router();

const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);

function html(res: Response, status: number, title: string, message: string, appUrl?: string) {
  const link = appUrl
    ? `<p><a class="btn" href="${escapeHtml(appUrl)}">Open GradeScan</a></p>
       <script>setTimeout(function(){ window.location.href = ${JSON.stringify(appUrl).replace(/</g, '\\u003c')}; }, 300);</script>`
    : '';
  res
    .status(status)
    .set({ 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' })
    .send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;background:#f6f3ec;color:#2b2118;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:24px}
main{max-width:420px;text-align:center}h1{font-size:22px}p{line-height:1.5}.btn{display:inline-block;background:#3d3128;color:#fff;padding:12px 22px;border-radius:8px;text-decoration:none}</style>
</head><body><main><h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${link}</main></body></html>`);
}

// 1. The app opens this in the browser.
authPageRouter.get('/start', (req: Request, res: Response) => {
  if (!isGoogleSignInConfigured()) {
    return html(res, 503, 'Google sign-in is not set up', 'The server has no Google sign-in settings yet. Ask whoever runs the server to add GOOGLE_OAUTH_CLIENT_ID and GOOGLE_OAUTH_CLIENT_SECRET.');
  }
  const returnUrl = req.query.return;
  if (!isAllowedReturnUrl(returnUrl)) {
    return html(res, 400, 'Cannot sign in from here', 'Open this page from the GradeScan app (Settings → Continue with Google).');
  }
  return res.redirect(buildAuthUrl(returnUrl));
});

// 2. Google sends the browser here after the consent screen.
authPageRouter.get('/callback', async (req: Request, res: Response) => {
  if (!isGoogleSignInConfigured()) return html(res, 503, 'Google sign-in is not set up', 'Ask whoever runs the server to add the Google sign-in settings.');

  const returnUrl = verifyState(req.query.state);
  if (!returnUrl) {
    return html(res, 400, 'Sign-in link expired', 'This sign-in link is not valid any more. Go back to GradeScan and press Continue with Google again.');
  }
  const back = (params: Record<string, string>, title: string, message: string) =>
    html(res, 200, title, message, appendParams(returnUrl, params));

  const googleError = req.query.error;
  if (typeof googleError === 'string') {
    return back({ error: googleError === 'access_denied' ? 'cancelled' : googleError.slice(0, 80) }, 'Sign-in cancelled', 'Returning to GradeScan…');
  }
  const code = req.query.code;
  if (typeof code !== 'string' || !code) return back({ error: 'Google did not send a sign-in code' }, 'Sign-in failed', 'Returning to GradeScan…');

  try {
    const { refreshToken, email } = await exchangeCode(code);
    console.log(`[auth] Google sign-in OK${email ? ` (${email})` : ''}`);
    return back({ refresh_token: refreshToken, email: email ?? '' }, 'Signed in', email ? `Signed in as ${email}. Returning to GradeScan…` : 'Returning to GradeScan…');
  } catch (err: any) {
    const message = err instanceof GoogleSignInError ? err.message : 'Sign-in failed. Please try again.';
    console.warn(`[auth] Google sign-in failed: ${err?.message ?? err}`);
    return back({ error: message }, 'Sign-in failed', 'Returning to GradeScan…');
  }
});

// "Sign out" in the app: ask Google to forget the token (the phone deletes its copy either way).
authApiRouter.post('/google/revoke', async (req: Request, res: Response) => {
  const token = typeof req.body?.refreshToken === 'string' ? req.body.refreshToken.trim() : '';
  if (token && isGoogleSignInConfigured()) await revokeRefreshToken(token);
  res.json({ success: true });
});

// Where to register the redirect address (also shown in the startup log and /health).
export const googleRedirectUri = getRedirectUri;
