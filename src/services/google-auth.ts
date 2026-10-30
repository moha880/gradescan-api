import { google, Auth } from 'googleapis';
import fs from 'fs';
import path from 'path';

/**
 * GradeScan reads and writes a teacher's sheet with the server's OWN Google account (a "service
 * account", the robot). The teacher never gives GradeScan access to their Google account or to their
 * other sheets: the robot can only open a sheet its owner shared with the robot's e-mail address.
 * ("Continue with Google" in the app tells the app who the teacher is and carries the teacher's own per-file Drive
 * permission, used only to create a new attendance sheet in their Drive; the robot is then added to that sheet.)
 */

/** Thrown when the server has no service account yet: whoever runs the server has to add one (DEPLOY.md). */
export class ServiceAccountMissingError extends Error {
  constructor() {
    super(
      'Saving to Google Sheets is not set up on the server yet. Ask whoever runs the server to add the Google service account key (backend/service-account.json, see DEPLOY.md).'
    );
    this.name = 'ServiceAccountMissingError';
  }
}

function serviceAccountPath(): string {
  return process.env.GOOGLE_SERVICE_ACCOUNT_PATH || path.join(process.cwd(), 'service-account.json');
}

/** Credentials of the server's service account (service-account.json / GOOGLE_SERVICE_ACCOUNT_JSON). */
export function createGoogleAuth(): Auth.GoogleAuth {
  // spreadsheets: read and write the sheets that were shared with the robot. (New attendance sheets are not
  // made by the robot: they are created in the teacher's own Drive with the teacher's permission.)
  const scopes = ['https://www.googleapis.com/auth/spreadsheets'];

  const jsonInline = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (jsonInline) {
    return new google.auth.GoogleAuth({ credentials: JSON.parse(jsonInline), scopes });
  }

  const jsonPath = serviceAccountPath();
  if (fs.existsSync(jsonPath)) {
    return new google.auth.GoogleAuth({ keyFile: jsonPath, scopes });
  }

  throw new ServiceAccountMissingError();
}

/** True when the server holds a service account (the app's Settings → TEST shows it). */
export function hasGoogleCredentials(): boolean {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return true;
  return fs.existsSync(serviceAccountPath());
}

/** The e-mail address teachers share their sheet with (Editor). */
export function getServiceAccountEmail(): string | null {
  try {
    if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
      return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON).client_email ?? null;
    }
    const jsonPath = serviceAccountPath();
    if (fs.existsSync(jsonPath)) {
      return JSON.parse(fs.readFileSync(jsonPath, 'utf8')).client_email ?? null;
    }
  } catch {
    /* ignore */
  }
  return null;
}
