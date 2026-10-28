/**
 * Turns a Google API failure into a sentence a teacher can act on. `mode` says whose
 * credentials were used, because the fix differs: a signed-in teacher needs Editor access
 * on the sheet, the shared "service account" robot needs the sheet shared with its e-mail.
 */
export function describeGoogleError(err: any, mode: 'user' | 'service' = 'user'): string {
  const raw = String(err?.response?.data?.error_description ?? err?.response?.data?.error?.message ?? err?.message ?? err ?? '');
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);

  if (/invalid_grant|token has been expired or revoked|invalid_rapt/i.test(raw)) {
    return 'Your Google sign-in has expired. Open Settings and sign in with Google again.';
  }
  if (/invalid_client|unauthorized_client|deleted_client/i.test(raw)) {
    return 'The server\'s Google sign-in settings are wrong (client ID or secret). Ask whoever runs the server to check them.';
  }
  if (status === 401 || /invalid credentials|login required|unauthenticated/i.test(raw)) {
    return mode === 'user'
      ? 'Google rejected the sign-in. Open Settings and sign in with Google again.'
      : 'Google rejected the server\'s credentials. Ask whoever runs the server to check them.';
  }
  if (status === 403 || /permission|forbidden|insufficient/i.test(raw)) {
    if (/has not been used in project|accessNotConfigured|API has not been enabled/i.test(raw)) {
      return 'The Google Sheets API is not enabled for the server\'s Google project. Ask whoever runs the server to enable it.';
    }
    return mode === 'user'
      ? 'This Google account cannot edit that sheet. Ask the owner to share it with you as Editor, or sign in with another account.'
      : 'The sheet is not shared with the server\'s Google account. Share it as Editor with the e-mail shown under Settings → Test.';
  }
  if (status === 404 || /not found|Requested entity was not found/i.test(raw)) {
    return 'Google could not find that sheet, or this account has no access to it. Check the link and the sharing settings.';
  }
  if (status === 429 || /quota|rate limit/i.test(raw)) {
    return 'Google is limiting requests right now. Try again in a minute.';
  }
  return raw.slice(0, 200) || 'Google Sheets update failed';
}
