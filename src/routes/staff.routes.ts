import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { getDB } from '../lib/db';

const router = Router();
router.use(authenticate);
router.use(authorize('Bank Staff', 'Admin'));

// ─── 0. Staff Dashboard Overview ──────────────────────────────────────────────
router.get('/dashboard-overview', async (req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDB();
    const [
      totalCustomers,
      totalAccounts,
      pendingLoans,
      pendingTransactions,
      flaggedTransactions,
      unverifiedCustomers,
    ] = await Promise.all([
      db.collection('users').countDocuments({ role: 'Customer' }),
      db.collection('bank_accounts').countDocuments({ status: 'Active' }),
      db.collection('loans').countDocuments({ status: { $in: ['Pending', 'Under Review'] } }),
      db.collection('transactions').countDocuments({ status: 'Pending' }),
      db.collection('transactions').countDocuments({ isSuspicious: true }),
      db.collection('users').countDocuments({ role: 'Customer', kycVerified: { $ne: true } }),
    ]);

    const recentTransactions = await db
      .collection('transactions')
      .find({})
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    const pendingLoanList = await db
      .collection('loans')
      .find({ status: { $in: ['Pending', 'Under Review'] } })
      .sort({ createdAt: -1 })
      .limit(6)
      .toArray();

    res.json({
      metrics: {
        totalCustomers,
        totalAccounts,
        pendingLoans,
        pendingTransactions,
        flaggedTransactions,
        unverifiedCustomers,
        branchCode: 'VLT-NYC-01',
        branchName: 'New York Metro Branch',
      },
      recentTransactions,
      pendingLoanList,
    });
  } catch (err) {
    console.error('[Staff/DashboardOverview]', err);
    res.status(500).json({ error: 'Failed to retrieve staff dashboard overview.' });
  }
});

// ─── 1. Customer Operations ──────────────────────────────────────────────────
// List all customers
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
    console.error('[Staff/Customers]', err);
    res.status(500).json({ error: 'Failed to list customers.' });
  }
});

// View customer details and associated bank accounts
router.get('/customers/:email', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const db = await getDB();

    const user = await db.collection('users').findOne(
      { email: email.toLowerCase(), role: 'Customer' },
      { projection: { password: 0, transactionPin: 0 } }
    );

    if (!user) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }

    const accounts = await db
      .collection('bank_accounts')
      .find({ userEmail: email.toLowerCase() })
      .toArray();

    res.json({ customer: user, accounts });
  } catch (err) {
    console.error('[Staff/Customers/:email]', err);
    res.status(500).json({ error: 'Failed to retrieve customer.' });
  }
});

// Register a new customer
router.post('/customers', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, transactionPin } = req.body;
    if (!name || !email || !password) {
      res.status(400).json({ error: 'name, email, password are required.' });
      return;
    }

    const db = await getDB();
    const existing = await db.collection('users').findOne({ email: email.toLowerCase() });
    if (existing) {
      res.status(409).json({ error: 'Email already registered.' });
      return;
    }

    const bcrypt = await import('bcryptjs');
    const hashedPass = await bcrypt.hash(password, 10);
    const hashedPin = await bcrypt.hash(transactionPin || '0000', 10);

    const result = await db.collection('users').insertOne({
      name,
      email: email.toLowerCase(),
      password: hashedPass,
      transactionPin: hashedPin,
      role: 'Customer',
      status: 'Active',
      phone: phone || null,
      kycVerified: false,
      registeredBy: req.user!.email,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      userId: result.insertedId.toString(),
      message: 'Customer registered successfully.',
    });
  } catch (err) {
    console.error('[Staff/Customers/POST]', err);
    res.status(500).json({ error: 'Failed to register customer.' });
  }
});

// Verify customer information / KYC
router.patch('/customers/:email/verify', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const { verified = true, verificationNotes = '' } = req.body;

    const db = await getDB();
    const result = await db.collection('users').updateOne(
      { email: email.toLowerCase(), role: 'Customer' },
      {
        $set: {
          kycVerified: Boolean(verified),
          verifiedBy: req.user!.email,
          verifiedAt: new Date(),
          verificationNotes,
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }

    res.json({ success: true, message: `Customer verification set to: ${verified}` });
  } catch (err) {
    console.error('[Staff/Customers/Verify]', err);
    res.status(500).json({ error: 'Failed to verify customer.' });
  }
});

// Staff creates a customer bank account
router.post('/accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userEmail, accountType, initialDeposit } = req.body;
    if (!userEmail || !accountType) {
      res.status(400).json({ error: 'userEmail and accountType are required.' });
      return;
    }

    const validTypes = ['Savings Account', 'Current Account', 'Business Account'];
    if (!validTypes.includes(accountType)) {
      res.status(400).json({ error: 'Invalid account type.' });
      return;
    }

    const db = await getDB();
    const customer = await db.collection('users').findOne({ email: userEmail.toLowerCase() });
    if (!customer) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }

    const accountNumber = '10' + Math.floor(10000000 + Math.random() * 90000000);
    const depositAmount = Number(initialDeposit) || 100;

    const newAccount = {
      userId: customer._id.toString(),
      userEmail: customer.email,
      userName: customer.name,
      accountNumber,
      accountType,
      balance: depositAmount,
      status: 'Active',
      dailyLimit: accountType === 'Business Account' ? 25000 : 5000,
      maxSingleTransaction: accountType === 'Business Account' ? 10000 : 2000,
      minBalance: accountType === 'Business Account' ? 500 : 50,
      openedByStaff: req.user!.email,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insertResult = await db.collection('bank_accounts').insertOne(newAccount);

    if (depositAmount > 0) {
      const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
      await db.collection('transactions').insertOne({
        transactionId: txnId,
        senderAccount: 'SYSTEM',
        senderName: 'Vaultly Central Reserve',
        senderEmail: 'system@vaultly.bank',
        receiverAccount: accountNumber,
        receiverName: customer.name,
        receiverEmail: customer.email,
        type: 'Deposit',
        amount: depositAmount,
        fee: 0,
        status: 'Completed',
        description: `Staff Opened ${accountType} with Initial Deposit`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    res.status(201).json({
      success: true,
      message: 'Bank account created for customer successfully.',
      account: { ...newAccount, _id: insertResult.insertedId },
    });
  } catch (err) {
    console.error('[Staff/Accounts/POST]', err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// ─── 2. Transaction Management & Suspicious Flagging ─────────────────────────
router.get('/transactions', async (req: Request, res: Response): Promise<void> => {
  try {
    const {
      search = '',
      type = 'All',
      status = 'All',
      startDate,
      endDate,
      flaggedOnly,
      page = '1',
      limit = '20',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (type !== 'All') query.type = type;
    if (status !== 'All') query.status = status;
    if (flaggedOnly === 'true') query.isSuspicious = true;

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search.trim()) {
      const r = new RegExp(search.trim(), 'i');
      query.$or = [
        { transactionId: r },
        { senderName: r },
        { receiverName: r },
        { senderAccount: r },
        { receiverAccount: r },
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
    console.error('[Staff/Transactions]', err);
    res.status(500).json({ error: 'Failed to list transactions.' });
  }
});

// Flag suspicious transaction for admin review
router.patch('/transactions/:txnId/flag', async (req: Request, res: Response): Promise<void> => {
  try {
    const { txnId } = req.params;
    const { reason } = req.body;

    if (!reason?.trim()) {
      res.status(400).json({ error: 'Flagging reason is required.' });
      return;
    }

    const db = await getDB();
    const result = await db.collection('transactions').updateOne(
      { transactionId: txnId },
      {
        $set: {
          isSuspicious: true,
          flaggedReason: reason.trim(),
          flaggedBy: req.user!.email,
          flaggedAt: new Date(),
          flagStatus: 'Pending Admin Review',
          updatedAt: new Date(),
        },
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }

    res.json({ success: true, message: 'Transaction flagged for admin review.' });
  } catch (err) {
    console.error('[Staff/Transactions/Flag]', err);
    res.status(500).json({ error: 'Failed to flag transaction.' });
  }
});

// ─── 3. Loan Assistance ──────────────────────────────────────────────────────
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
    console.error('[Staff/Loans]', err);
    res.status(500).json({ error: 'Failed to list loans.' });
  }
});

// Add internal staff note to a loan
router.patch('/loans/:loanId/note', async (req: Request, res: Response): Promise<void> => {
  try {
    const { loanId } = req.params;
    const { note } = req.body;

    if (!note?.trim()) {
      res.status(400).json({ error: 'Note is required.' });
      return;
    }

    const db = await getDB();
    const result = await db.collection('loans').updateOne(
      { loanId },
      {
        $push: {
          staffNotes: {
            note: note.trim(),
            addedBy: req.user!.email,
            addedAt: new Date(),
          } as never,
        },
        $set: { updatedAt: new Date() },
      }
    );

    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Loan not found.' });
      return;
    }

    res.json({ success: true, message: 'Internal staff note added successfully.' });
  } catch (err) {
    console.error('[Staff/Loans/Note]', err);
    res.status(500).json({ error: 'Failed to add note.' });
  }
});

// Forward loan application for admin approval
router.patch('/loans/:loanId/forward', async (req: Request, res: Response): Promise<void> => {
  try {
    const { loanId } = req.params;
    const { recommendation = '' } = req.body;

    const db = await getDB();
    const loan = await db.collection('loans').findOne({ loanId });

    if (!loan) {
      res.status(404).json({ error: 'Loan not found.' });
      return;
    }

    // Security requirement: Staff cannot approve their own loan or approve loans directly
    if (loan.userEmail === req.user!.email) {
      res.status(403).json({ error: 'Staff cannot forward or process their own loan applications.' });
      return;
    }

    await db.collection('loans').updateOne(
      { loanId },
      {
        $set: {
          status: 'Under Review',
          forwardedByStaff: req.user!.email,
          forwardedAt: new Date(),
          staffRecommendation: recommendation || 'Recommended for Admin approval',
          updatedAt: new Date(),
        },
      }
    );

    res.json({ success: true, message: 'Loan application forwarded for Admin approval.' });
  } catch (err) {
    console.error('[Staff/Loans/Forward]', err);
    res.status(500).json({ error: 'Failed to forward loan application.' });
  }
});

export default router;
