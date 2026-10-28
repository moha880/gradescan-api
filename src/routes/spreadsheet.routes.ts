import { Router } from 'express';
import { SpreadsheetController } from '../controllers/spreadsheet.controller';

const router = Router();
const ctrl = new SpreadsheetController();

router.get('/:id/workbook', (req, res) => ctrl.getWorkbook(req, res));
router.get('/:id/worksheets', (req, res) => ctrl.getWorksheets(req, res));
router.get('/:id/columns', (req, res) => ctrl.getColumns(req, res));
router.get('/:id/students', (req, res) => ctrl.getStudents(req, res));
router.post('/:id/grade', (req, res) => ctrl.updateGrade(req, res));

// Query parameter aliases:
router.get('/worksheets', (req, res) => ctrl.getWorksheets(req, res));
router.get('/columns', (req, res) => ctrl.getColumns(req, res));
router.get('/students', (req, res) => ctrl.getStudents(req, res));
router.post('/grade', (req, res) => ctrl.updateGrade(req, res));

export default router;
