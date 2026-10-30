import { Request, Response } from 'express';
import { MAX_SYNC_BATCH, SyncService } from '../services/sync.service';

export class SyncController {
  private syncService = new SyncService();

  async processBatch(req: Request, res: Response) {
    try {
      // Express 5 leaves req.body undefined when the request has no JSON body
      const { operations } = req.body ?? {};
      if (!operations || !Array.isArray(operations)) {
        return res.status(400).json({ error: 'Invalid payload' });
      }
      if (operations.length > MAX_SYNC_BATCH) {
        return res.status(413).json({ error: `Too many grades in one request (limit ${MAX_SYNC_BATCH}). Send them in smaller groups.` });
      }
      // every entry needs an id, otherwise the app cannot tell which grade a result belongs to
      if (operations.some(op => !op || typeof op !== 'object' || typeof op.id !== 'string' || op.id === '' || op.id.length > 200)) {
        return res.status(400).json({ error: 'Invalid payload: every operation needs an id.' });
      }

      const results = await this.syncService.processOperations(operations);
      return res.json({ success: true, results });
    } catch (error: any) {
      console.error('Batch error:', error);
      return res.status(500).json({ error: error.message || 'Internal server error' });
    }
  }

  async checkStatus(req: Request, res: Response) {
    res.json({ status: 'UNKNOWN', operationId: req.params.operationId });
  }
}
