import { Request, Response } from 'express';
import { SyncService } from '../services/sync.service';

export class SyncController {
  private syncService = new SyncService();

  async processBatch(req: Request, res: Response) {
    try {
      const { operations } = req.body;
      if (!operations || !Array.isArray(operations)) {
        return res.status(400).json({ error: 'Invalid payload' });
      }

      let accessToken: string | undefined;
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith('Bearer ')) {
        const token = authHeader.substring(7).trim();
        if (token && token !== 'mock_token') accessToken = token;
      }

      // "Continue with Google" sign-in from the app (see services/google-oauth.service.ts)
      const refreshHeader = req.headers['x-google-refresh-token'];
      const refreshToken = (Array.isArray(refreshHeader) ? refreshHeader[0] : refreshHeader)?.trim() || undefined;

      const results = await this.syncService.processOperations(operations, accessToken, refreshToken);
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
