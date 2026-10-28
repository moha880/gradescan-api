import { Router } from 'express';
import { SyncController } from '../controllers/sync.controller';

const router = Router();
const ctrl = new SyncController();

router.post('/batch', (req, res) => ctrl.processBatch(req, res));
router.get('/status/:operationId', (req, res) => ctrl.checkStatus(req, res));

export default router;
