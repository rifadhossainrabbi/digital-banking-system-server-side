import { Router } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';

// Lazy-load individual sub-routers
import accountsRouter from './customer/accounts.routes';
import transferRouter from './customer/transfer.routes';
import transactionsRouter from './customer/transactions.routes';
import depositWithdrawRouter from './customer/deposit-withdraw.routes';
import loansRouter from './customer/loans.routes';
import statementRouter from './customer/statement.routes';
import profileRouter from './customer/profile.routes';

const router = Router();

// All customer routes require authentication + Customer role
router.use(authenticate);
router.use(authorize('Customer'));

// ─── Mount Sub-Routers (lazy-loaded modules) ────────────────────────────────
router.use('/accounts', accountsRouter);
router.use('/transfer', transferRouter);
router.use('/transactions', transactionsRouter);
router.use('/deposit-withdraw', depositWithdrawRouter);
router.use('/loans', loansRouter);
router.use('/statement', statementRouter);
router.use('/profile', profileRouter);

export default router;
