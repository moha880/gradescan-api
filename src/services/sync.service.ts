import { GoogleSheetsProvider, columnIndexToLetter } from './google-sheets.service';
import { createGoogleAuth, credentialMode } from './google-auth';
import { describeGoogleError } from './google-errors';

export interface SyncOperation {
  id: string;
  classId: string;
  studentId: string;
  spreadsheetId: string;
  worksheetId: string;
  targetColumn: string;
  targetColumnIndex: number;
  targetRow: number;
  oldValue: number | null;
  newValue: number;
}

export class SyncService {
  private resolveColumnLetter(op: SyncOperation): string {
    if (op.targetColumn && /^[A-Za-z]+$/.test(op.targetColumn.trim())) {
      return op.targetColumn.trim().toUpperCase();
    }
    if (typeof op.targetColumnIndex === 'number' && op.targetColumnIndex >= 0) {
      return columnIndexToLetter(op.targetColumnIndex);
    }
    throw new Error(`Cannot resolve sheet column for operation ${op.id}`);
  }

  private isGoogleSpreadsheetId(id: string): boolean {
    if (!id) return false;
    if (id.startsWith('excel-roster-')) return false;
    // Google spreadsheet IDs are typically 40+ chars of alphanumerics/hyphens/underscores
    return /^[a-zA-Z0-9_-]{20,}$/.test(id);
  }

  async processOperations(operations: SyncOperation[], accessToken?: string, refreshToken?: string) {
    const mode = credentialMode(accessToken, refreshToken);
    let provider: GoogleSheetsProvider;
    try {
      provider = new GoogleSheetsProvider(createGoogleAuth(accessToken, refreshToken));
    } catch (err: any) {
      // No usable Google identity: say so per grade instead of failing the whole request with a 500
      const error = err?.message || 'Google Sheets is not set up';
      return operations.map(op => ({ id: op.id, status: 'FAILED', error }));
    }
    const results = [];

    for (const op of operations) {
      try {
        if (!this.isGoogleSpreadsheetId(op.spreadsheetId)) {
          results.push({
            id: op.id,
            status: 'FAILED',
            error:
              'This class is not linked to a real Google Spreadsheet. Re-connect via Google Sheets to sync grades.',
          });
          continue;
        }

        const worksheetName = op.worksheetId || 'Sheet1';
        const column = this.resolveColumnLetter(op);
        const row = op.targetRow;

        if (!row || row < 2) {
          results.push({
            id: op.id,
            status: 'FAILED',
            error: 'Missing or invalid spreadsheet row for this student.',
          });
          continue;
        }

        const currentCloudValue = await provider.getCurrentValue(
          op.spreadsheetId,
          worksheetName,
          row,
          column
        );

        const cloudNum =
          currentCloudValue === null || currentCloudValue === undefined
            ? null
            : Number(currentCloudValue);
        const cloudComparable =
          cloudNum !== null && Number.isFinite(cloudNum) ? cloudNum : currentCloudValue;

        if (
          cloudComparable !== null &&
          cloudComparable !== undefined &&
          op.oldValue !== null &&
          op.oldValue !== undefined &&
          cloudComparable !== op.oldValue &&
          cloudComparable !== op.newValue
        ) {
          results.push({
            id: op.id,
            status: 'CONFLICT',
            cloudValue: cloudComparable,
            localValue: op.newValue,
          });
          continue;
        }

        await provider.updateGrade(op.spreadsheetId, worksheetName, row, column, op.newValue);
        results.push({ id: op.id, status: 'SYNCED' });
      } catch (err: any) {
        console.error(`[SyncService] Failed op ${op.id}:`, err?.message || err);
        results.push({
          id: op.id,
          status: 'FAILED',
          error: describeGoogleError(err, mode),
        });
      }
    }

    return results;
  }
}
