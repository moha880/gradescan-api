import { createHash } from 'crypto';
import { Request, Response } from 'express';
import { AttendanceInputError, GoogleSheetsProvider } from '../services/google-sheets.service';
import { createGoogleAuth, getServiceAccountEmail, ServiceAccountMissingError } from '../services/google-auth';
import { createUserAuthClient, isGoogleSignInConfigured } from '../services/google-oauth.service';
import { describeGoogleError, isShareProblem, isUserTokenProblem } from '../services/google-errors';
import { SpreadsheetProvider } from '../services/spreadsheet.provider';

/**
 * New sheets go into the teacher's own Drive, but the server still does the work, so creating them is limited
 * per teacher: ATTENDANCE_SHEETS_PER_HOUR, default 30. Every phone shares the one access key of the app, so the key
 * says nothing about WHO is asking; the teacher's own Google permission (a hash of it, never the value) does.
 * A second, wider limit per address (5x) stops one caller from rotating made-up tokens. Kept in memory.
 */
const createLog = new Map<string, number[]>();
const HOUR = 3_600_000;
const LOG_PRUNE_AT = 2000; // entries; older-than-an-hour ones are dropped once the log grows past this

function attendanceSheetLimit(): number {
  const n = parseInt(process.env.ATTENDANCE_SHEETS_PER_HOUR ?? '', 10);
  return Number.isFinite(n) && n > 0 ? Math.min(n, 1000) : 30;
}
function pruneLog(now: number): void {
  for (const [key, times] of createLog) {
    if (times.length === 0 || now - times[times.length - 1] >= HOUR) createLog.delete(key);
  }
}
function allowCreate(key: string, limit: number, now = Date.now()): boolean {
  if (createLog.size > LOG_PRUNE_AT) pruneLog(now);
  const recent = (createLog.get(key) ?? []).filter(t => now - t < HOUR);
  if (recent.length >= limit) {
    createLog.set(key, recent);
    return false;
  }
  recent.push(now);
  createLog.set(key, recent);
  return true;
}
/** The two buckets a "create a sheet" request counts against (see above). */
export function attendanceLimitKeys(token: string, ip: string | undefined): { teacher: string; address: string } {
  return {
    teacher: `t:${createHash('sha256').update(token).digest('hex').slice(0, 32)}`,
    address: `ip:${ip || 'unknown'}`,
  };
}
/** True when this caller may create one more sheet (and counts it). */
export function allowAttendanceCreate(token: string, ip: string | undefined, now = Date.now()): boolean {
  const limit = attendanceSheetLimit();
  const keys = attendanceLimitKeys(token, ip);
  // check both before counting either, so a refused request does not use up the other bucket
  const recentOf = (k: string) => (createLog.get(k) ?? []).filter(t => now - t < HOUR).length;
  if (recentOf(keys.teacher) >= limit || recentOf(keys.address) >= limit * 5) return false;
  return allowCreate(keys.teacher, limit, now) && allowCreate(keys.address, limit * 5, now);
}
/** Number of callers the limiter currently remembers (test hook). */
export function attendanceRateLimitSize(): number {
  return createLog.size;
}
/** Test hook. */
export function resetAttendanceRateLimit(): void {
  createLog.clear();
}

/** A spreadsheet id from the URL or the body: plain id characters only, so it can never alter the Google request path. */
function spreadsheetIdFrom(...candidates: unknown[]): string | null {
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '') return /^[\w-]{1,200}$/.test(c) ? c : null;
  }
  return null;
}

const DRIVE_PERMISSION_MESSAGE = 'GradeScan does not have your permission to create the sheet in your Google Drive. Sign out in Settings, sign in with Google again and keep the Google Drive box ticked. Or save the list in the app and export it to Excel.';

/** The teacher's own Google Drive permission (kept on the phone, sent only when a new sheet is created). */
function driveTokenFrom(req: Request): string | null {
  const raw = req.header('x-google-refresh-token');
  const token = typeof raw === 'string' ? raw.trim() : '';
  return token.length >= 10 && token.length <= 2048 ? token : null;
}

export class SpreadsheetController {
  private getProvider(): SpreadsheetProvider {
    // createGoogleAuth() throws a ready-to-show message when the server has no service account yet
    return new GoogleSheetsProvider(createGoogleAuth());
  }

  /** Teacher-readable message + a status the app can tell apart from "wrong access key" (401). */
  private fail(res: Response, label: string, error: any) {
    console.error(`${label} error:`, error?.message || error);
    if (error instanceof ServiceAccountMissingError) {
      return res.status(503).json({ error: describeGoogleError(error), notConfigured: true });
    }
    const email = getServiceAccountEmail();
    const code = Number(error?.code ?? error?.response?.status);
    const status = [403, 404, 429].includes(code) ? code : 502;
    return res.status(status).json({
      error: describeGoogleError(error, email),
      // lets the app tell the teacher exactly which address to share the sheet with
      ...(isShareProblem(error) && email ? { serviceAccountEmail: email } : {}),
    });
  }

  /** Attendance endpoints: bad input is the caller's problem (400/409); Google failures go through fail(). */
  private failAttendance(res: Response, label: string, error: any, creating = false) {
    if (error instanceof AttendanceInputError) {
      console.warn(`${label}: ${error.message}`);
      return res.status(error.status).json({ error: error.message, code: error.code, ...error.extra });
    }
    if (!creating) return this.fail(res, label, error);
    // creating a sheet in the teacher's Drive: "share the sheet with the robot" advice makes no sense here
    console.error(`${label} error:`, error?.message || error);
    if (error instanceof ServiceAccountMissingError) {
      return res.status(503).json({ error: describeGoogleError(error), notConfigured: true });
    }
    if (isUserTokenProblem(error)) {
      return res.status(403).json({ error: DRIVE_PERMISSION_MESSAGE, code: 'drive_permission_needed' });
    }
    const code = Number(error?.code ?? error?.response?.status);
    return res.status(code === 429 ? 429 : 502).json({ error: describeGoogleError(error, getServiceAccountEmail(), 'create') });
  }

  /** POST /api/spreadsheet/:id/attendance — tick the students who were present. */
  async markAttendance(req: Request, res: Response) {
    try {
      const spreadsheetId = spreadsheetIdFrom(req.params.id, req.body?.spreadsheetId);
      const { worksheetName, headerRow, column, newHeader, rows, mark } = req.body ?? {};
      if (!spreadsheetId) return res.status(400).json({ error: 'Spreadsheet ID required' });
      if (!Array.isArray(rows)) return res.status(400).json({ error: 'rows must be a list of sheet row numbers' });
      const provider = this.getProvider() as GoogleSheetsProvider;
      const result = await provider.markAttendance(spreadsheetId, { worksheetName, headerRow, column, newHeader, rows, mark });
      return res.json({ success: true, ...result });
    } catch (error: any) {
      return this.failAttendance(res, 'markAttendance', error);
    }
  }

  /**
   * POST /api/spreadsheet/create-attendance — make a new sheet in the TEACHER's own Google Drive (the phone
   * sends the teacher's Drive permission in x-google-refresh-token), then add the robot as Editor.
   */
  async createAttendanceSheet(req: Request, res: Response) {
    try {
      const body = req.body ?? {};
      if (!isGoogleSignInConfigured()) {
        return res.status(503).json({ error: 'This server is not set up for Google sign-in yet. Ask whoever runs the server to finish the Google setup (DEPLOY.md, Part 3).', code: 'oauth_not_configured' });
      }
      const token = driveTokenFrom(req);
      if (!token) return res.status(403).json({ error: DRIVE_PERMISSION_MESSAGE, code: 'drive_permission_needed' });
      if (!allowAttendanceCreate(token, req.ip)) {
        const limit = attendanceSheetLimit();
        return res.status(429).json({ error: `Too many new sheets were created in the last hour (limit ${limit}). Try again later or use a sheet you already have.`, code: 'rate_limited' });
      }
      // the teacher's own Drive credentials create the sheet; the robot is only added to it afterwards
      const provider = new GoogleSheetsProvider(createUserAuthClient(token));
      const robot = getServiceAccountEmail();
      const result = await provider.createAttendanceSheet({
        title: body.title,
        worksheetName: body.worksheetName,
        nameHeader: body.nameHeader,
        dateHeader: body.dateHeader,
        names: body.names,
        present: body.present,
        shareWithRobot: robot,
      });
      return res.json({ success: true, ...result, ...(robot ? { serviceAccountEmail: robot } : {}) });
    } catch (error: any) {
      return this.failAttendance(res, 'createAttendanceSheet', error, true);
    }
  }

  async getWorksheets(req: Request, res: Response) {
    try {
      const spreadsheetId = spreadsheetIdFrom(req.params.id, req.query.spreadsheetId);
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider();
      const worksheets = await provider.getWorksheets(spreadsheetId);
      return res.json({ worksheets, title: 'Google Spreadsheet' });
    } catch (error: any) {
      return this.fail(res, 'getWorksheets', error);
    }
  }

  async getColumns(req: Request, res: Response) {
    try {
      const spreadsheetId = spreadsheetIdFrom(req.params.id, req.query.spreadsheetId);
      const worksheetName = typeof req.query.worksheetName === 'string' && req.query.worksheetName ? req.query.worksheetName.slice(0, 200) : 'Sheet1';
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider();
      const columns = await provider.getColumns(spreadsheetId, worksheetName);
      return res.json({ columns });
    } catch (error: any) {
      return this.fail(res, 'getColumns', error);
    }
  }

  async getStudents(req: Request, res: Response) {
    try {
      const spreadsheetId = spreadsheetIdFrom(req.params.id, req.query.spreadsheetId);
      const worksheetName = typeof req.query.worksheetName === 'string' && req.query.worksheetName ? req.query.worksheetName.slice(0, 200) : 'Sheet1';
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider();
      const students = await provider.getStudents(spreadsheetId, worksheetName);
      return res.json({ students });
    } catch (error: any) {
      return this.fail(res, 'getStudents', error);
    }
  }

  /** All worksheets with their cell values — lets the app import a private sheet. */
  async getWorkbook(req: Request, res: Response) {
    try {
      const spreadsheetId = spreadsheetIdFrom(req.params.id, req.query.spreadsheetId);
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider() as GoogleSheetsProvider;
      return res.json(await provider.getWorkbook(spreadsheetId));
    } catch (error: any) {
      return this.fail(res, 'getWorkbook', error);
    }
  }

  async updateGrade(req: Request, res: Response) {
    try {
      const body = req.body ?? {};
      const spreadsheetId = spreadsheetIdFrom(req.params.id, body.spreadsheetId, req.query.spreadsheetId);
      const { worksheetName, row, column, value } = body;
      if (!spreadsheetId || row === undefined || row === null || !column) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      if (worksheetName !== undefined && worksheetName !== null && (typeof worksheetName !== 'string' || worksheetName.length > 200)) {
        return res.status(400).json({ error: 'The worksheet name is not valid.' });
      }
      // row, column and value are checked (and the value made safe) inside updateGrade: a bad one is a 400
      const provider = this.getProvider();
      await provider.updateGrade(spreadsheetId, worksheetName || 'Sheet1', row, column, value);
      return res.json({ success: true });
    } catch (error: any) {
      return this.failAttendance(res, 'updateGrade', error);
    }
  }
}
