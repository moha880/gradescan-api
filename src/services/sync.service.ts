import { GoogleSheetsProvider, columnIndexToLetter } from './google-sheets.service';
import { createGoogleAuth, getServiceAccountEmail } from './google-auth';
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

/** Most grades one batch may carry (the app sends them in small groups; this only stops a runaway caller). */
export const MAX_SYNC_BATCH = 500;

/** Why an operation cannot be written, or null when its fields are sane. Never throws. */
export function describeInvalidOperation(op: any): string | null {
  if (typeof op.spreadsheetId !== 'string') return 'The operation has no spreadsheet.';
  if (op.worksheetId !== undefined && op.worksheetId !== null && (typeof op.worksheetId !== 'string' || op.worksheetId.length > 200)) {
    return 'The worksheet name is not valid.';
  }
  if (typeof op.newValue !== 'number' || !Number.isFinite(op.newValue)) return 'The grade must be a finite number.';
  if (op.oldValue !== undefined && op.oldValue !== null && (typeof op.oldValue !== 'number' || !Number.isFinite(op.oldValue))) {
    return 'The previous grade must be a number.';
  }
  return null;
}

export class SyncService {
  private resolveColumnLetter(op: SyncOperation): string {
    // 1-3 letters (A..ZZZ) only: anything longer or odd could turn the cell address into a different range
    if (typeof op.targetColumn === 'string' && /^[A-Za-z]{1,3}$/.test(op.targetColumn.trim())) {
      return op.targetColumn.trim().toUpperCase();
    }
    if (Number.isInteger(op.targetColumnIndex) && op.targetColumnIndex >= 0 && op.targetColumnIndex < 18278) {
      return columnIndexToLetter(op.targetColumnIndex);
    }
    throw new Error(`Cannot resolve sheet column for operation ${op.id}`);
  }

  private isGoogleSpreadsheetId(id: unknown): boolean {
    if (typeof id !== 'string' || !id) return false;
    if (id.startsWith('excel-roster-')) return false;
    // Google spreadsheet IDs are typically 40+ chars of alphanumerics/hyphens/underscores
    return /^[a-zA-Z0-9_-]{20,}$/.test(id);
  }

  async processOperations(operations: SyncOperation[]) {
    const serviceEmail = getServiceAccountEmail();
    let provider: GoogleSheetsProvider;
    try {
      provider = new GoogleSheetsProvider(createGoogleAuth());
    } catch (err: any) {
      // The server has no Google account for sheets: say so per grade instead of failing the whole request with a 500
      const error = describeGoogleError(err, serviceEmail);
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

        const invalid = describeInvalidOperation(op);
        if (invalid) {
          results.push({ id: op.id, status: 'FAILED', error: invalid });
          continue;
        }

        const worksheetName = op.worksheetId || 'Sheet1';
        const column = this.resolveColumnLetter(op);
        const row = op.targetRow;

        if (!Number.isInteger(row) || row < 2 || row > 1_000_000) {
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
          error: describeGoogleError(err, serviceEmail),
        });
      }
    }

    return results;
  }
}
