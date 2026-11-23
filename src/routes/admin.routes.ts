import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { getDB } from '../lib/db';
import bcrypt from 'bcryptjs';

const router = Router();
router.use(authenticate);
router.use(authorize('Admin'));

// ─── Dashboard Overview ───────────────────────────────────────────────────────
router.get('/dashboard', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDB();
    const usersCol = db.collection('users');
    const accountsCol = db.collection('bank_accounts');
    const transactionsCol = db.collection('transactions');
    const loansCol = db.collection('loans');
    const depositWithdrawCol = db.collection('deposit_withdraw_requests');

    const [
      totalCustomers,
      totalAccounts,
      allAccounts,
      totalTransactions,
      pendingLoans,
      pendingRequests,
    ] = await Promise.all([
      usersCol.countDocuments({ role: 'Customer' }),
      accountsCol.countDocuments(),
      accountsCol.find().toArray(),
      transactionsCol.countDocuments(),
      loansCol.countDocuments({ status: { $in: ['Pending', 'Under Review'] } }),
      depositWithdrawCol.countDocuments({ status: 'Pending' }),
    ]);

    const totalBalance = allAccounts.reduce((s, a) => s + (a.balance || 0), 0);

    // Totals from transactions
    const depositPipeline = [
      { $match: { type: 'Deposit', status: 'Completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ];
    const withdrawPipeline = [
      { $match: { type: 'Withdrawal', status: 'Completed' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ];

    const [depositRes, withdrawRes] = await Promise.all([
      transactionsCol.aggregate(depositPipeline).toArray(),
      transactionsCol.aggregate(withdrawPipeline).toArray(),
    ]);

    res.json({
      totalCustomers,
      totalAccounts,
      totalBalance: parseFloat(totalBalance.toFixed(2)),
      totalTransactions,
      pendingLoans,
      pendingRequests,
      totalDeposits: depositRes[0]?.total ?? 0,
      totalWithdrawals: withdrawRes[0]?.total ?? 0,
    });
  } catch (err) {
    console.error('[Admin/Dashboard]', err);
    res.status(500).json({ error: 'Failed to load dashboard.' });
  }
});

// ─── Customer Management ──────────────────────────────────────────────────────
router.get('/customers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { search = '', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = { role: 'Customer' };
    if (search.trim()) {
      const r = new RegExp(search.trim(), 'i');
      query.$or = [{ name: r }, { email: r }, { phone: r }];
    }

    const [total, customers] = await Promise.all([
      db.collection('users').countDocuments(query),
      db.collection('users')
        .find(query, { projection: { password: 0, transactionPin: 0 } })
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({ customers, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('[Admin/Customers]', err);
    res.status(500).json({ error: 'Failed to list customers.' });
  }
});

router.patch('/customers/:email/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const { status } = req.body;
    const validStatuses = ['Active', 'Suspended', 'Blocked'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid status.' });
      return;
    }
    const db = await getDB();
    await db.collection('users').updateOne(
      { email: email.toLowerCase() },
      { $set: { status, updatedAt: new Date() } }
    );
    res.json({ success: true, message: `Customer status updated to ${status}.` });
  } catch (err) {
    console.error('[Admin/Customers/Status]', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// ─── Bank Account Management ──────────────────────────────────────────────────
router.get('/accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { search = '', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (search.trim()) {
      const r = new RegExp(search.trim(), 'i');
      query.$or = [{ accountNumber: r }, { userName: r }, { userEmail: r }];
    }

    const [total, accounts] = await Promise.all([
      db.collection('bank_accounts').countDocuments(query),
      db.collection('bank_accounts')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({ accounts, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('[Admin/Accounts]', err);
    res.status(500).json({ error: 'Failed to list accounts.' });
  }
});

router.patch('/accounts/:accountNumber', async (req: Request, res: Response): Promise<void> => {
  try {
    const { accountNumber } = req.params;
    const { status, dailyLimit, maxSingleTransaction, minBalance } = req.body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateFields: any = { updatedAt: new Date() };
    if (status) updateFields.status = status;
    if (dailyLimit != null) updateFields.dailyLimit = Number(dailyLimit);
    if (maxSingleTransaction != null) updateFields.maxSingleTransaction = Number(maxSingleTransaction);
    if (minBalance != null) updateFields.minBalance = Number(minBalance);

    const db = await getDB();
    await db.collection('bank_accounts').updateOne({ accountNumber }, { $set: updateFields });
    res.json({ success: true, message: 'Account updated.' });
  } catch (err) {
    console.error('[Admin/Accounts/PATCH]', err);
    res.status(500).json({ error: 'Failed to update account.' });
  }
});

// ─── Transaction Management ───────────────────────────────────────────────────
router.get('/transactions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { search = '', type = 'All', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (type !== 'All') query.type = type;
    if (search.trim()) {
      const r = new RegExp(search.trim(), 'i');
      query.$or = [
        { transactionId: r }, { senderName: r }, { receiverName: r },
        { senderAccount: r }, { receiverAccount: r }, { description: r },
      ];
    }

    const [total, transactions] = await Promise.all([
      db.collection('transactions').countDocuments(query),
      db.collection('transactions')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({ transactions, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('[Admin/Transactions]', err);
    res.status(500).json({ error: 'Failed to list transactions.' });
  }
});

// ─── Loan Management ─────────────────────────────────────────────────────────
router.get('/loans', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status = 'All', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (status !== 'All') query.status = status;

    const [total, loans] = await Promise.all([
      db.collection('loans').countDocuments(query),
      db.collection('loans')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({ loans, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('[Admin/Loans]', err);
    res.status(500).json({ error: 'Failed to list loans.' });
  }
});

router.patch('/loans/:loanId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { loanId } = req.params;
    const { status, adminNote } = req.body;
    const validStatuses = ['Pending', 'Under Review', 'Approved', 'Rejected', 'Active', 'Completed'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid loan status.' });
      return;
    }

    const db = await getDB();
    await db.collection('loans').updateOne(
      { loanId },
      { $set: { status, adminNote: adminNote || '', updatedAt: new Date() } }
    );
    res.json({ success: true, message: `Loan status updated to ${status}.` });
  } catch (err) {
    console.error('[Admin/Loans/PATCH]', err);
    res.status(500).json({ error: 'Failed to update loan.' });
  }
});

// ─── Deposit/Withdrawal Approval ─────────────────────────────────────────────
router.get('/requests', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status = 'All', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (status !== 'All') query.status = status;

    const [total, requests] = await Promise.all([
      db.collection('deposit_withdraw_requests').countDocuments(query),
      db.collection('deposit_withdraw_requests')
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({ requests, total, page: pageNum, totalPages: Math.ceil(total / limitNum) });
  } catch (err) {
    console.error('[Admin/Requests]', err);
    res.status(500).json({ error: 'Failed to list requests.' });
  }
});

router.patch('/requests/:requestId', async (req: Request, res: Response): Promise<void> => {
  try {
    const { requestId } = req.params;
    const { status } = req.body;

    if (!['Approved', 'Rejected'].includes(status)) {
      res.status(400).json({ error: 'Status must be Approved or Rejected.' });
      return;
    }

    const db = await getDB();
    const reqDoc = await db.collection('deposit_withdraw_requests').findOne({ requestId });
    if (!reqDoc) {
      res.status(404).json({ error: 'Request not found.' });
      return;
    }
    if (reqDoc.status !== 'Pending') {
      res.status(400).json({ error: 'Only Pending requests can be updated.' });
      return;
    }

    const now = new Date();
    await db.collection('deposit_withdraw_requests').updateOne(
      { requestId },
      { $set: { status, updatedAt: now } }
    );

    if (status === 'Approved') {
      const balanceDelta = reqDoc.type === 'Deposit' ? reqDoc.amount : -reqDoc.amount;
      await db.collection('bank_accounts').updateOne(
        { accountNumber: reqDoc.accountNumber },
        { $inc: { balance: balanceDelta }, $set: { updatedAt: now } }
      );

      const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
      const user = await db.collection('users').findOne({ email: reqDoc.userEmail });
      await db.collection('transactions').insertOne({
        transactionId: txnId,
        senderAccount: reqDoc.type === 'Deposit' ? 'SYSTEM' : reqDoc.accountNumber,
        senderName: reqDoc.type === 'Deposit' ? 'Vaultly Central Reserve' : user?.name || 'Customer',
        senderEmail: reqDoc.type === 'Deposit' ? 'system@vaultly.bank' : reqDoc.userEmail,
        receiverAccount: reqDoc.type === 'Deposit' ? reqDoc.accountNumber : 'SYSTEM',
        receiverName: reqDoc.type === 'Deposit' ? user?.name || 'Customer' : 'Vaultly Processing',
        receiverEmail: reqDoc.type === 'Deposit' ? reqDoc.userEmail : 'system@vaultly.bank',
        type: reqDoc.type,
        amount: reqDoc.amount,
        fee: 0,
        status: 'Completed',
        description: `Admin Approved — ${reqDoc.type} Request ${requestId}`,
        relatedRequestId: requestId,
        createdAt: now,
        updatedAt: now,
      });
    }

    res.json({ success: true, message: `Request ${status}.` });
  } catch (err) {
    console.error('[Admin/Requests/PATCH]', err);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// ─── Staff Management ─────────────────────────────────────────────────────────
router.get('/staff', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDB();
    const staff = await db.collection('users')
      .find({ role: 'Bank Staff' }, { projection: { password: 0, transactionPin: 0 } })
      .sort({ createdAt: -1 })
      .toArray();
    res.json({ staff });
  } catch (err) {
    console.error('[Admin/Staff]', err);
    res.status(500).json({ error: 'Failed to list staff.' });
  }
});

router.post('/staff', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, employeeId, branchCode } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: 'name, email, and password are required.' });
      return;
    }
    const db = await getDB();
    const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (existing) {
      res.status(409).json({ error: 'Email already in use.' });
      return;
    }
    const hashed = await bcrypt.hash(password, 10);
    await db.collection('users').insertOne({
      name,
      email: email.toLowerCase(),
      password: hashed,
      role: 'Bank Staff',
      status: 'Active',
      phone: phone || null,
      employeeId: employeeId || null,
      branchCode: branchCode || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    res.status(201).json({ success: true, message: 'Staff created.' });
  } catch (err) {
    console.error('[Admin/Staff/POST]', err);
    res.status(500).json({ error: 'Failed to create staff.' });
  }
});

export default router;
