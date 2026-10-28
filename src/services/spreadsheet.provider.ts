export interface SpreadsheetColumn {
  index: number;
  header: string;
}

export interface SpreadsheetStudent {
  row: number;
  data: Record<string, any>;
}

export interface SpreadsheetProvider {
  /**
   * Returns a list of worksheets available in the given document
   */
  getWorksheets(documentId: string): Promise<{ id: string; name: string }[]>;

  /**
   * Retrieves the column headers for a specific worksheet
   */
  getColumns(documentId: string, worksheetName: string): Promise<SpreadsheetColumn[]>;

  /**
   * Downloads all students from the sheet
   */
  getStudents(documentId: string, worksheetName: string): Promise<SpreadsheetStudent[]>;

  /**
   * Updates a specific cell with a new grade
   */
  updateGrade(documentId: string, worksheetName: string, row: number, column: string, value: string | number): Promise<void>;

  /**
   * Fetches the current value of a cell (useful for conflict detection)
   */
  getCurrentValue(documentId: string, worksheetName: string, row: number, column: string): Promise<string | number | null>;
}
