/**
 * Turns a Google API failure into a sentence a teacher can act on. Sheets are always opened with the
 * server's own Google account (the "service account" robot), so the usual fix is to share the sheet
 * with that account's e-mail address as Editor; `serviceEmail` is that address when the server knows it.
 */
export function describeGoogleError(err: any, serviceEmail?: string | null, context?: 'create'): string {
  const raw = String(err?.response?.data?.error_description ?? err?.response?.data?.error?.message ?? err?.message ?? err ?? '');
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  const shareWith = serviceEmail ? serviceEmail : 'the e-mail shown under Settings → TEST';
  const shareHow = `Open the sheet in Google Sheets → Share, add ${shareWith} as Editor, then try again.`;

  if (err?.name === 'ServiceAccountMissingError') {
    return String(err.message);
  }
  if (/invalid_grant|invalid_rapt/i.test(raw)) {
    return 'Google does not accept the server\'s service account key. Ask whoever runs the server to check backend/service-account.json (and that the PC\'s clock is right).';
  }
  if (/invalid_client|unauthorized_client|deleted_client/i.test(raw)) {
    return 'The server\'s Google settings are wrong. Ask whoever runs the server to check them.';
  }
  if (status === 401 || /invalid credentials|login required|unauthenticated/i.test(raw)) {
    return 'Google rejected the server\'s credentials. Ask whoever runs the server to check backend/service-account.json.';
  }
  if (status === 403 || /permission|forbidden|insufficient/i.test(raw)) {
    if (/has not been used in project|accessNotConfigured|API has not been enabled/i.test(raw)) {
      if (/drive/i.test(raw)) {
        return 'The Google Drive API is not enabled for the server\'s Google project (the attendance mode needs it to create and share a new sheet). Ask whoever runs the server to enable it (DEPLOY.md, Part 2).';
      }
      return 'The Google Sheets API is not enabled for the server\'s Google project. Ask whoever runs the server to enable it.';
    }
    if (/storage ?quota|storageQuotaExceeded|out of storage/i.test(raw)) {
      return context === 'create'
        ? 'Your Google Drive is full, so the new sheet could not be created there. Free some space in Google Drive, then try again.'
        : 'The server\'s Google account is out of storage. Ask whoever runs the server to delete the old sheets it created, then try again.';
    }
    if (context === 'create') {
      // Google's own wording is shown so whoever runs the server can tell the causes apart (see DEPLOY.md, Troubleshooting).
      const why = raw.replace(/\s+/g, ' ').trim().slice(0, 160);
      return `Google did not allow GradeScan to create the sheet in your Drive${why ? ` (Google said: "${why}")` : ''}. Ask whoever runs the server to check the Google project (DEPLOY.md, Part 2).`;
    }
    return `GradeScan cannot open that sheet because it is not shared with GradeScan's Google account. ${shareHow}`;
  }
  if (status === 404 || /not found|Requested entity was not found/i.test(raw)) {
    return `Google could not find that sheet. Check that the link is complete, and that the sheet is shared with GradeScan's Google account. ${shareHow}`;
  }
  if (status === 429 || /quota|rate limit/i.test(raw)) {
    return 'Google is limiting requests right now. Try again in a minute.';
  }
  return raw.slice(0, 200) || 'Google Sheets update failed';
}

/** True for the failures that mean "this sheet is not shared with the robot" (the app then shows the share advice). */
export function isShareProblem(err: any): boolean {
  const raw = String(err?.response?.data?.error?.message ?? err?.message ?? err ?? '');
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  if (/has not been used in project|accessNotConfigured|API has not been enabled/i.test(raw)) return false;
  return status === 403 || status === 404 || /permission|forbidden|Requested entity was not found/i.test(raw);
}

/**
 * True when the TEACHER's own Google token is the problem while GradeScan is creating a sheet in their Drive:
 * the permission was never given, was taken back, or expired (an app still in Google's "Testing" state loses
 * it after 7 days). The app then asks the teacher to allow Google Drive again.
 */
export function isUserTokenProblem(err: any): boolean {
  const raw = String(err?.response?.data?.error_description ?? err?.response?.data?.error?.message ?? err?.response?.data?.error ?? err?.message ?? err ?? '');
  const status = Number(err?.code ?? err?.response?.status ?? err?.status);
  if (/has not been used in project|accessNotConfigured|API has not been enabled/i.test(raw)) return false;
  if (/invalid_grant|invalid_rapt|token has been expired or revoked/i.test(raw)) return true;
  if (/insufficient authentication scopes|insufficientPermissions|ACCESS_TOKEN_SCOPE_INSUFFICIENT/i.test(raw)) return true;
  return status === 401;
}
