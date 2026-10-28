import { google, sheets_v4 } from 'googleapis';
import { SpreadsheetProvider, SpreadsheetColumn, SpreadsheetStudent } from './spreadsheet.provider';
import { createGoogleAuth } from './google-auth';
import type { Auth } from 'googleapis';

export class GoogleSheetsProvider implements SpreadsheetProvider {
  private sheets: sheets_v4.Sheets;

  constructor(authOrToken?: string | Auth.GoogleAuth | Auth.OAuth2Client) {
    const auth =
      typeof authOrToken === 'string' || authOrToken === undefined
        ? createGoogleAuth(authOrToken)
        : authOrToken;
    this.sheets = google.sheets({ version: 'v4', auth });
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
  async getWorkbook(documentId: string, maxSheets = 20): Promise<{ title: string; sheets: { name: string; rows: string[][] }[] }> {
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
      sheets: titles.map((name, i) => ({
        name,
        rows: (ranges[i]?.values ?? []).map(r => (r ?? []).map(c => String(c ?? ''))),
      })),
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
    const sheet = this.formatSheetName(worksheetName);
    const range = `${sheet}!${column}${row}`;

    await this.sheets.spreadsheets.values.update({
      spreadsheetId: documentId,
      range,
      valueInputOption: 'USER_ENTERED',
      requestBody: {
        values: [[value]],
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
    const range = `${sheet}!${column}${row}`;
    const response = await this.sheets.spreadsheets.values.get({
      spreadsheetId: documentId,
      range,
    });

    const raw = response.data.values?.[0]?.[0];
    if (raw === undefined || raw === null || raw === '') return null;
    const asNum = Number(raw);
    return Number.isFinite(asNum) && String(raw).trim() !== '' ? asNum : raw;
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
