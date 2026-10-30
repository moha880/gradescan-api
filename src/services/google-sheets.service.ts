import { google, sheets_v4 } from 'googleapis';
import { SpreadsheetProvider, SpreadsheetColumn, SpreadsheetStudent } from './spreadsheet.provider';
import { createGoogleAuth } from './google-auth';
import type { Auth } from 'googleapis';

/** The request itself is wrong (not a Google failure): the controller answers 400 / 409 with this message. */
export class AttendanceInputError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'bad_request', readonly extra: Record<string, unknown> = {}) {
    super(message);
    this.name = 'AttendanceInputError';
  }
}

export const ATTENDANCE_MARK = '✓';
const TICK_VARIANTS = new Set(['✓', '✔', '☑', '√', 'true', 'TRUE', 'yes', 'YES']);
const MAX_ATTENDANCE_ROWS = 2000;

/** Cell text that Google must keep as text: a title such as 2026-10-29 or a name starting with "=" is not parsed. */
export function asLiteralText(value: string): string {
  return /^[=+\-@\d]/.test(value) ? `'${value}` : value;
}

/** Longest text a single grade cell may receive through the API (a grade is a number, or a short note). */
const MAX_GRADE_TEXT = 200;
/** Largest row number / sheet size the server will address (Google's own limit is 10 million cells). */
const MAX_SHEET_ROW = 1_000_000;
/** The most rows (and columns) of one worksheet that getWorkbook hands to the app. */
export const MAX_WORKBOOK_ROWS = 5000;
export const MAX_WORKBOOK_COLUMNS = 100;

/**
 * What may be written into a grade cell. The sheet is written with USER_ENTERED so numbers stay numbers,
 * which also means text such as =IMPORTXML(...) or =HYPERLINK(...) would run as a formula in the teacher's
 * sheet. So: finite numbers and plain numeric strings are written as numbers, any other text is stored as
 * literal text (leading apostrophe), and anything else is refused.
 */
export function gradeCellValue(value: unknown): string | number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new AttendanceInputError('The grade must be a finite number.');
    return value;
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (text.length === 0) throw new AttendanceInputError('The grade is empty.');
    if (text.length > MAX_GRADE_TEXT) throw new AttendanceInputError(`The grade text is too long (limit ${MAX_GRADE_TEXT} characters).`);
    if (/^-?\d+(?:\.\d+)?$/.test(text)) return Number(text);
    return asLiteralText(text);
  }
  throw new AttendanceInputError('The grade must be a number.');
}

/** A1 column letters (A..ZZZ), upper-cased; throws for anything that could change the meaning of the range. */
export function assertColumnLetters(column: unknown): string {
  const letters = typeof column === 'string' ? column.trim().toUpperCase() : '';
  if (!/^[A-Z]{1,3}$/.test(letters)) throw new AttendanceInputError('The column is not valid (use letters such as C or AB).');
  return letters;
}

/** A 1-based sheet row number. */
export function assertRowNumber(row: unknown): number {
  const n = typeof row === 'string' && /^\d+$/.test(row.trim()) ? Number(row.trim()) : row;
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > MAX_SHEET_ROW) {
    throw new AttendanceInputError('The row number is not valid.');
  }
  return n;
}

export interface MarkAttendanceInput {
  worksheetName: string;
  /** 1-based sheet row that holds the column titles. */
  headerRow: number;
  /** A1 letters of the column that receives the ticks (it may not exist yet). */
  column: string;
  /** Set when the column is a NEW one: this title is written into its header cell. */
  newHeader?: string;
  /** 1-based sheet rows of the students who were present. */
  rows: number[];
  mark?: string;
}

export interface MarkAttendanceResult {
  written: number;
  alreadyMarked: number;
  skipped: { row: number; value: string }[];
  style: 'tick' | 'checkbox';
  column: string;
  headerWritten: boolean;
}

export interface CreateAttendanceInput {
  title?: string;
  worksheetName?: string;
  nameHeader?: string;
  dateHeader: string;
  names: string[];
  present?: boolean[];
  /** The server's robot e-mail: the new sheet is shared with it as Editor so later days can be ticked. Skipped when empty. */
  shareWithRobot?: string | null;
}

export interface CreateAttendanceResult {
  spreadsheetId: string;
  url: string;
  worksheetName: string;
  headerRow: number;
  firstRow: number;
  nameColumn: string;
  dateColumn: string;
  /** False when the robot could not be added as Editor (the sheet exists anyway; `shareWarning` says why). */
  sharedWithRobot: boolean;
  shareWarning?: string;
}

/** A1 letters → 0-based index (A→0, AA→26). */
export function letterToColumnIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

const EMAIL_RE = /^[^\s@<>(),;:"\\]+@[^\s@<>(),;:"\\]+\.[^\s@<>(),;:"\\]{2,}$/;

export class GoogleSheetsProvider implements SpreadsheetProvider {
  private sheets: sheets_v4.Sheets;
  private auth: Auth.GoogleAuth | Auth.OAuth2Client;

  constructor(auth?: Auth.GoogleAuth | Auth.OAuth2Client) {
    this.auth = auth ?? createGoogleAuth();
    this.sheets = google.sheets({ version: 'v4', auth: this.auth });
  }

  async getWorksheets(documentId: string) {
    const response = await this.sheets.spreadsheets.get({
      spreadsheetId: documentId,
    });
    return (
      response.data.sheets?.map((s) => ({
        id: s.properties?.sheetId?.toString() || '',
        name: s.properties?.title || '',
      })) || []
    );
  }

  /** Always quoted: a bare name such as 2024 or A1 would be read as a cell range. */
  private formatSheetName(name: string): string {
    if (!name) return "'Sheet1'";
    return `'${name.replace(/'/g, "''")}'`;
  }

  /**
   * Every worksheet's cell values in one go, so the app can read a PRIVATE sheet with the
   * teacher's own Google account (the public "anyone with the link" download cannot).
   */
  async getWorkbook(documentId: string, maxSheets = 20): Promise<{ title: string; sheets: { name: string; rows: string[][]; truncated?: boolean }[] }> {
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: documentId,
      fields: 'properties.title,sheets.properties.title',
    });
    const titles = (meta.data.sheets ?? [])
      .map(s => s.properties?.title)
      .filter((t): t is string => !!t)
      .slice(0, maxSheets);
    const title = meta.data.properties?.title ?? 'Google Spreadsheet';
    if (titles.length === 0) return { title, sheets: [] };

    const res = await this.sheets.spreadsheets.values.batchGet({
      spreadsheetId: documentId,
      ranges: titles.map(t => this.formatSheetName(t)),
      valueRenderOption: 'FORMATTED_VALUE',
    });
    const ranges = res.data.valueRanges ?? [];
    return {
      title,
      sheets: titles.map((name, i) => {
        const all = ranges[i]?.values ?? [];
        // a roster never needs more than this; the cap keeps one huge sheet from becoming one huge response
        const tooLong = all.length > MAX_WORKBOOK_ROWS;
        const rows = all.slice(0, MAX_WORKBOOK_ROWS).map(r => (r ?? []).slice(0, MAX_WORKBOOK_COLUMNS).map(c => String(c ?? '')));
        return tooLong ? { name, rows, truncated: true } : { name, rows };
      }),
    };
  }

  async getColumns(documentId: string, worksheetName: string): Promise<SpreadsheetColumn[]> {
    const sheet = this.formatSheetName(worksheetName);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: documentId,
      range: `${sheet}!1:1`,
    });

    const headers = response.data.values?.[0] || [];
    return headers.map((header: string, index: number) => ({
      index,
      header: String(header ?? ''),
    }));
  }

  async getStudents(documentId: string, worksheetName: string): Promise<SpreadsheetStudent[]> {
    const sheet = this.formatSheetName(worksheetName);
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: documentId,
      range: `${sheet}`,
    });

    const rows = response.data.values || [];
    if (rows.length < 2) return [];

    const headers = rows[0].map((h) => String(h ?? ''));
    const students: SpreadsheetStudent[] = [];

    for (let i = 1; i < rows.length; i++) {
      const rowData = rows[i];
      const data: Record<string, any> = {};

      headers.forEach((header: string, colIndex: number) => {
        if (!header) return;
        data[header] = rowData[colIndex] ?? null;
        data[header.toLowerCase()] = rowData[colIndex] ?? null;
      });

      const hasContent = Object.values(data).some((v) => v !== null && v !== '');
      if (!hasContent) continue;

      students.push({
        row: i + 1,
        data,
      });
    }

    return students;
  }

  async updateGrade(
    documentId: string,
    worksheetName: string,
    row: number,
    column: string,
    value: string | number
  ) {
    // validated here (not only in the controllers) so every caller, sync batches included, gets the same rules
    const letters = assertColumnLetters(column);
    const rowNumber = assertRowNumber(row);
    const cell = gradeCellValue(value);
    const sheet = this.formatSheetName(worksheetName);
    const range = `${sheet}!${letters}${rowNumber}`;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: documentId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[cell]],
      },
    });
  }

  async getCurrentValue(
    documentId: string,
    worksheetName: string,
    row: number,
    column: string
  ) {
    const sheet = this.formatSheetName(worksheetName);
    const range = `${sheet}!${assertColumnLetters(column)}${assertRowNumber(row)}`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: documentId,
      range,
    });

    const raw = response.data.values?.[0]?.[0];
    if (raw === undefined || raw === null || raw === '') return null;
    const asNum = Number(raw);
    return Number.isFinite(asNum) && String(raw).trim() !== '' ? asNum : raw;
  }

  /**
   * Attendance: put a tick in one column in front of the students who were present.
   *  - the column may be an existing one or a NEW one (its title is then written into the header row);
   *  - only EMPTY cells are written: a cell that already holds something (another mark, a note) is left
   *    alone and reported back, so a second scan never overwrites the teacher's data;
   *  - a column of check boxes (TRUE/FALSE) gets a ticked box instead of "✓".
   */
  async markAttendance(documentId: string, input: MarkAttendanceInput): Promise<MarkAttendanceResult> {
    const column = String(input.column ?? '').trim().toUpperCase();
    if (!/^[A-Z]{1,3}$/.test(column)) throw new AttendanceInputError('The tick column is not valid.');
    const headerRow = Number(input.headerRow);
    if (!Number.isInteger(headerRow) || headerRow < 1 || headerRow > 1000) throw new AttendanceInputError('The header row is not valid.');
    const rows = [...new Set((Array.isArray(input.rows) ? input.rows : []).map(Number))].sort((a, b) => a - b);
    if (rows.length > MAX_ATTENDANCE_ROWS) throw new AttendanceInputError(`Too many students at once (limit ${MAX_ATTENDANCE_ROWS}).`);
    if (rows.some(r => !Number.isInteger(r) || r <= headerRow || r > 100000)) {
      throw new AttendanceInputError('A student row is not valid (it must be below the header row).');
    }
    const newHeader = input.newHeader === undefined || input.newHeader === null ? undefined : String(input.newHeader).trim();
    if (newHeader !== undefined && (newHeader.length === 0 || newHeader.length > 100)) {
      throw new AttendanceInputError('The new column needs a title (up to 100 characters).');
    }
    const mark = String(input.mark ?? ATTENDANCE_MARK).trim() || ATTENDANCE_MARK;
    if (mark.length > 5) throw new AttendanceInputError('The mark is too long.');
    if (rows.length === 0 && newHeader === undefined) {
      return { written: 0, alreadyMarked: 0, skipped: [], style: 'tick', column, headerWritten: false };
    }

    // 1. find the worksheet (and grow its grid when the new column lies beyond the last one)
    const meta = await this.sheets.spreadsheets.get({
      spreadsheetId: documentId,
      fields: 'sheets.properties(sheetId,title,gridProperties)',
    });
    const wanted = String(input.worksheetName ?? '').trim();
    const tabs = (meta.data.sheets ?? []).map(s => s.properties).filter(Boolean);
    const tab = wanted ? tabs.find(p => p?.title === wanted) : tabs[0];
    if (!tab || tab.sheetId === undefined || tab.sheetId === null) {
      throw new AttendanceInputError(`The worksheet "${wanted}" was not found in that spreadsheet.`, 404, 'worksheet_not_found');
    }
    const colIndex = letterToColumnIndex(column);
    const lastRow = rows.length ? rows[rows.length - 1] : headerRow;
    const grow: sheets_v4.Schema$Request[] = [];
    const colCount = tab.gridProperties?.columnCount ?? 26;
    const rowCount = tab.gridProperties?.rowCount ?? 1000;
    if (colIndex >= colCount) {
      grow.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: colIndex + 1 - colCount } });
    }
    if (lastRow > rowCount) {
      grow.push({ appendDimension: { sheetId: tab.sheetId, dimension: 'ROWS', length: lastRow - rowCount } });
    }

    // 2. what is in the column right now (header cell + student cells)
    const sheet = this.formatSheetName(tab.title ?? wanted);
    const read = await this.sheets.spreadsheets.values.get({
      spreadsheetId: documentId,
      range: `${sheet}!${column}${headerRow}:${column}${lastRow}`,
      valueRenderOption: 'UNFORMATTED_VALUE',
    });
    const cells = read.data.values ?? [];
    const cellAt = (row: number): unknown => cells[row - headerRow]?.[0];
    const isEmpty = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

    const existingHeader = cellAt(headerRow);
    let headerWritten = false;
    if (newHeader !== undefined) {
      if (!isEmpty(existingHeader) && String(existingHeader).trim() !== newHeader) {
        throw new AttendanceInputError(
          `Column ${column} already has the title "${String(existingHeader).trim()}". Choose that column from the list, or pick another new column.`,
          409,
          'header_conflict',
          { existingHeader: String(existingHeader).trim() }
        );
      }
      headerWritten = isEmpty(existingHeader);
    }

    // 3. decide per student: write / already ticked / leave alone
    const style: 'tick' | 'checkbox' = rows.some(r => typeof cellAt(r) === 'boolean') ? 'checkbox' : 'tick';
    const toWrite: number[] = [];
    const skipped: { row: number; value: string }[] = [];
    let alreadyMarked = 0;
    for (const row of rows) {
      const v = cellAt(row);
      if (isEmpty(v) || v === false) toWrite.push(row);
      else if (v === true || TICK_VARIANTS.has(String(v).trim()) || String(v).trim() === mark) alreadyMarked++;
      else skipped.push({ row, value: String(v).slice(0, 40) });
    }

    // 4. write everything in one request (consecutive rows share one range)
    const data: sheets_v4.Schema$ValueRange[] = [];
    if (headerWritten) data.push({ range: `${sheet}!${column}${headerRow}`, values: [[asLiteralText(newHeader as string)]] });
    for (let i = 0; i < toWrite.length; ) {
      let j = i;
      while (j + 1 < toWrite.length && toWrite[j + 1] === toWrite[j] + 1) j++;
      const count = j - i + 1;
      // the mark is the caller's text: stored as literal text so a mark such as "=1+1" never becomes a formula
      const value = style === 'checkbox' ? true : asLiteralText(mark);
      data.push({
        range: `${sheet}!${column}${toWrite[i]}${count > 1 ? `:${column}${toWrite[j]}` : ''}`,
        values: Array.from({ length: count }, () => [value]),
      });
      i = j + 1;
    }
    if (data.length > 0) {
      if (grow.length) await this.sheets.spreadsheets.batchUpdate({ spreadsheetId: documentId, requestBody: { requests: grow } });
      await this.sheets.spreadsheets.values.batchUpdate({
        spreadsheetId: documentId,
        requestBody: { valueInputOption: 'USER_ENTERED', data },
      });
    }
    return { written: toWrite.length, alreadyMarked, skipped, style, column, headerWritten };
  }

  /**
   * Makes an empty spreadsheet owned by whoever the provider's credentials belong to (the TEACHER, when it is
   * built with their Drive token).
   * Google often answers 403 "The caller does not have permission" when a service account calls the Sheets
   * API's spreadsheets.create, even with every API enabled; creating the file through the Drive API (as a
   * Google Sheets file) and then renaming its first tab with the Sheets API is the route that works there.
   * So the Drive API is tried first and the Sheets API's own create is kept as the second try. If both fail,
   * the FIRST error is the one reported (both are logged for whoever runs the server).
   */
  private async createBlankSheet(
    title: string,
    worksheetName: string,
    rtl: boolean
  ): Promise<{ spreadsheetId: string; sheetId: number; url: string }> {
    const drive = google.drive({ version: 'v3', auth: this.auth });
    try {
      const file = await drive.files.create({
        requestBody: { name: title, mimeType: 'application/vnd.google-apps.spreadsheet' },
        fields: 'id,webViewLink',
      });
      const id = file.data.id;
      if (!id) throw new Error('Google did not return the new sheet.');
      try {
        const meta = await this.sheets.spreadsheets.get({ spreadsheetId: id, fields: 'sheets.properties.sheetId' });
        const sheetId = meta.data.sheets?.[0]?.properties?.sheetId ?? 0;
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId: id,
          requestBody: {
            requests: [{ updateSheetProperties: { properties: { sheetId, title: worksheetName, rightToLeft: rtl }, fields: 'title,rightToLeft' } }],
          },
        });
        return { spreadsheetId: id, sheetId, url: file.data.webViewLink || `https://docs.google.com/spreadsheets/d/${id}/edit` };
      } catch (e) {
        try { await drive.files.delete({ fileId: id }); } catch { /* best effort */ }
        throw e;
      }
    } catch (driveErr: any) {
      console.warn('createAttendanceSheet: creating through the Drive API failed, trying the Sheets API:', driveErr?.message ?? driveErr);
      try {
        const created = await this.sheets.spreadsheets.create({
          requestBody: {
            properties: { title },
            sheets: [{ properties: { title: worksheetName, rightToLeft: rtl } }],
          },
          fields: 'spreadsheetId,spreadsheetUrl,sheets.properties.sheetId',
        });
        const id = created.data.spreadsheetId;
        if (!id) throw new Error('Google did not return the new sheet.');
        return {
          spreadsheetId: id,
          sheetId: created.data.sheets?.[0]?.properties?.sheetId ?? 0,
          url: created.data.spreadsheetUrl || `https://docs.google.com/spreadsheets/d/${id}/edit`,
        };
      } catch (sheetsErr: any) {
        console.error('createAttendanceSheet: the Sheets API could not create it either:', sheetsErr?.message ?? sheetsErr);
        throw driveErr;
      }
    }
  }

  /**
   * Attendance, first time: create a new sheet (names in column A, today's column B with a tick for the
   * present students). The provider must be built with the TEACHER's Drive credentials, so the sheet is
   * created in, and owned by, the teacher's own Google Drive; the robot is then added as Editor (non-fatal).
   */
  async createAttendanceSheet(input: CreateAttendanceInput): Promise<CreateAttendanceResult> {
    const clean = (v: unknown, max: number) => String(v ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
    const title = clean(input.title, 100) || 'Attendance';
    const worksheetName = clean(String(input.worksheetName ?? '').replace(/[\[\]*?:/\\]/g, ' '), 80) || 'Attendance';
    const nameHeader = clean(input.nameHeader, 40) || 'Name';
    const dateHeader = clean(input.dateHeader, 40);
    if (!dateHeader) throw new AttendanceInputError('The first column needs a title (for example today\'s date).');
    const robot = clean(input.shareWithRobot, 254);
    if (!Array.isArray(input.names) || input.names.length === 0) throw new AttendanceInputError('There are no names to put in the sheet.');
    if (input.names.length > 500) throw new AttendanceInputError('Too many names for one sheet (limit 500).');
    const names = input.names.map(n => clean(n, 120));
    if (names.some(n => n.length === 0)) throw new AttendanceInputError('A name is empty.');
    const present = names.map((_, i) => input.present?.[i] === true);

    const rtl = names.filter(n => /[\u0600-\u06FF]/.test(n)).length > names.length / 2;
    const { spreadsheetId, sheetId, url } = await this.createBlankSheet(title, worksheetName, rtl);

    const drive = google.drive({ version: 'v3', auth: this.auth });
    const discard = async () => {
      try {
        await drive.files.delete({ fileId: spreadsheetId });
      } catch {
        /* best effort */
      }
    };

    try {
      const sheet = this.formatSheetName(worksheetName);
      await this.sheets.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheet}!A1`,
        valueInputOption: 'USER_ENTERED',
        requestBody: {
          values: [
            [asLiteralText(nameHeader), asLiteralText(dateHeader)],
            ...names.map((n, i) => [asLiteralText(n), present[i] ? ATTENDANCE_MARK : '']),
          ],
        },
      });
      // cosmetics (bold titles, frozen header row, column widths): never worth failing the whole thing for
      try {
        await this.sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          requestBody: {
            requests: [
              { repeatCell: { range: { sheetId, startRowIndex: 0, endRowIndex: 1 }, cell: { userEnteredFormat: { textFormat: { bold: true } } }, fields: 'userEnteredFormat.textFormat.bold' } },
              { updateSheetProperties: { properties: { sheetId, gridProperties: { frozenRowCount: 1 } }, fields: 'gridProperties.frozenRowCount' } },
              { autoResizeDimensions: { dimensions: { sheetId, dimension: 'COLUMNS', startIndex: 0, endIndex: 2 } } },
            ],
          },
        });
      } catch (e: any) {
        console.warn('createAttendanceSheet: formatting skipped:', e?.message ?? e);
      }
    } catch (err: any) {
      // the teacher must not be left with a half-filled sheet in their Drive
      await discard();
      throw err;
    }

    // The sheet is the teacher's. Adding the server's robot as Editor lets the next days be ticked without any
    // sharing by hand; if that fails the sheet still exists, and the app shows the robot's address to add.
    let sharedWithRobot = false;
    let shareWarning: string | undefined;
    if (!robot || !EMAIL_RE.test(robot)) {
      shareWarning = 'The server has no Google robot account set up, so it cannot tick this sheet later.';
    } else {
      try {
        await drive.permissions.create({
          fileId: spreadsheetId,
          sendNotificationEmail: false,
          requestBody: { type: 'user', role: 'writer', emailAddress: robot },
        });
        sharedWithRobot = true;
      } catch (e: any) {
        console.warn('createAttendanceSheet: could not add the robot as Editor:', e?.message ?? e);
        shareWarning = String(e?.message ?? e).replace(/\s+/g, ' ').slice(0, 160);
      }
    }

    return { spreadsheetId, url, worksheetName, headerRow: 1, firstRow: 2, nameColumn: 'A', dateColumn: 'B', sharedWithRobot, ...(shareWarning ? { shareWarning } : {}) };
  }
}

/** Column index (0-based) → A1 letter(s), e.g. 0→A, 3→D */
export function columnIndexToLetter(index: number): string {
  let letter = '';
  let n = index + 1;
  while (n > 0) {
    const rem = (n - 1) % 26;
    letter = String.fromCharCode(65 + rem) + letter;
    n = Math.floor((n - 1) / 26);
  }
  return letter;
}
