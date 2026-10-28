import { Request, Response } from 'express';
import { GoogleSheetsProvider } from '../services/google-sheets.service';
import { createGoogleAuth, credentialMode } from '../services/google-auth';
import { describeGoogleError } from '../services/google-errors';
import { SpreadsheetProvider } from '../services/spreadsheet.provider';

export class SpreadsheetController {
  private credentials(req: Request): { accessToken?: string; refreshToken?: string } {
    let accessToken: string | undefined;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith('Bearer ')) {
      accessToken = authHeader.substring(7).trim();
    }
    const refreshHeader = req.headers['x-google-refresh-token'];
    const refreshToken = (Array.isArray(refreshHeader) ? refreshHeader[0] : refreshHeader)?.trim() || undefined;
    return { accessToken, refreshToken };
  }

  private getProvider(req: Request): SpreadsheetProvider {
    const { accessToken, refreshToken } = this.credentials(req);
    // createGoogleAuth() throws a ready-to-show message when no Google identity is available
    return new GoogleSheetsProvider(createGoogleAuth(accessToken, refreshToken));
  }

  /** Teacher-readable message + a status the app can tell apart from "wrong access key" (401). */
  private fail(req: Request, res: Response, label: string, error: any) {
    console.error(`${label} error:`, error?.message || error);
    const { accessToken, refreshToken } = this.credentials(req);
    const code = Number(error?.code ?? error?.response?.status);
    const status = [403, 404, 429].includes(code) ? code : 502;
    return res.status(status).json({ error: describeGoogleError(error, credentialMode(accessToken, refreshToken)) });
  }

  async getWorksheets(req: Request, res: Response) {
    try {
      const spreadsheetId = (req.params.id || req.query.spreadsheetId) as string;
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider(req);
      const worksheets = await provider.getWorksheets(spreadsheetId);
      return res.json({ worksheets, title: 'Google Spreadsheet' });
    } catch (error: any) {
      return this.fail(req, res, 'getWorksheets', error);
    }
  }

  async getColumns(req: Request, res: Response) {
    try {
      const spreadsheetId = (req.params.id || req.query.spreadsheetId) as string;
      const worksheetName = (req.query.worksheetName || 'Sheet1') as string;
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider(req);
      const columns = await provider.getColumns(spreadsheetId, worksheetName);
      return res.json({ columns });
    } catch (error: any) {
      return this.fail(req, res, 'getColumns', error);
    }
  }

  async getStudents(req: Request, res: Response) {
    try {
      const spreadsheetId = (req.params.id || req.query.spreadsheetId) as string;
      const worksheetName = (req.query.worksheetName || 'Sheet1') as string;
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider(req);
      const students = await provider.getStudents(spreadsheetId, worksheetName);
      return res.json({ students });
    } catch (error: any) {
      return this.fail(req, res, 'getStudents', error);
    }
  }

  /** All worksheets with their cell values — lets the app import a private sheet. */
  async getWorkbook(req: Request, res: Response) {
    try {
      const spreadsheetId = (req.params.id || req.query.spreadsheetId) as string;
      if (!spreadsheetId) {
        return res.status(400).json({ error: 'Spreadsheet ID required' });
      }
      const provider = this.getProvider(req) as GoogleSheetsProvider;
      return res.json(await provider.getWorkbook(spreadsheetId));
    } catch (error: any) {
      return this.fail(req, res, 'getWorkbook', error);
    }
  }

  async updateGrade(req: Request, res: Response) {
    try {
      const spreadsheetId = (req.params.id || req.body.spreadsheetId || req.query.spreadsheetId) as string;
      const { worksheetName, row, column, value } = req.body;
      if (!spreadsheetId || row === undefined || row === null || !column) {
        return res.status(400).json({ error: 'Missing required parameters' });
      }
      const provider = this.getProvider(req);
      await provider.updateGrade(spreadsheetId, worksheetName || 'Sheet1', Number(row), column, value);
      return res.json({ success: true });
    } catch (error: any) {
      return this.fail(req, res, 'updateGrade', error);
    }
  }
}
