import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { getDB, getClient } from '../lib/db';

const router = Router();
router.use(authenticate);
router.use(authorize('Admin'));

// ─── 1. Dashboard Overview & Real Analytics ──────────────────────────────────
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
    res.status(500).json({ error: 'Failed to load dashboard overview.' });
  }
});

// ─── Analytics Endpoint (Real Visualizations) ────────────────────────────────
router.get('/analytics', async (_req: Request, res: Response): Promise<void> => {
  try {
    const db = await getDB();
    const accountsCol = db.collection('bank_accounts');
    const transactionsCol = db.collection('transactions');
    const loansCol = db.collection('loans');

    // 1. Account Distribution by Type
    const accountDistribution = await accountsCol
      .aggregate([
        { $group: { _id: '$accountType', count: { $sum: 1 }, totalBalance: { $sum: '$balance' } } },
        { $project: { type: '$_id', count: 1, totalBalance: 1, _id: 0 } },
      ])
      .toArray();

    // 2. Loan Approval Statistics
    const loanStatistics = await loansCol
      .aggregate([
        { $group: { _id: '$status', count: { $sum: 1 }, totalAmount: { $sum: '$requestedAmount' } } },
        { $project: { status: '$_id', count: 1, totalAmount: 1, _id: 0 } },
      ])
      .toArray();

    // 3. Monthly Transaction Volume (last 6 months)
    const sixMonthsAgo = new Date();
    sixMonthsAgo.setMonth(sixMonthsAgo.getMonth() - 5);
    sixMonthsAgo.setDate(1);
    sixMonthsAgo.setHours(0, 0, 0, 0);

    const monthlyActivity = await transactionsCol
      .aggregate([
        { $match: { createdAt: { $gte: sixMonthsAgo } } },
        {
          $group: {
            _id: {
              year: { $year: '$createdAt' },
              month: { $month: '$createdAt' },
              type: '$type',
            },
            totalAmount: { $sum: '$amount' },
            count: { $sum: 1 },
          },
        },
        { $sort: { '_id.year': 1, '_id.month': 1 } },
      ])
      .toArray();

    // 4. Deposit vs Withdrawal Summary
    const flowComparison = await transactionsCol
      .aggregate([
        { $match: { type: { $in: ['Deposit', 'Withdrawal', 'Transfer'] } } },
        { $group: { _id: '$type', total: { $sum: '$amount' }, count: { $sum: 1 } } },
      ])
      .toArray();

    res.json({
      accountDistribution,
      loanStatistics,
      monthlyActivity,
      flowComparison,
    });
  } catch (err) {
    console.error('[Admin/Analytics]', err);
    res.status(500).json({ error: 'Failed to compute analytics.' });
  }
});

// ─── 2. Customer Management ──────────────────────────────────────────────────
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

// View specific customer details with their bank accounts & loans
router.get('/customers/:email', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const db = await getDB();

    const customer = await db.collection('users').findOne(
      { email: email.toLowerCase() },
      { projection: { password: 0, transactionPin: 0 } }
    );

    if (!customer) {
      res.status(404).json({ error: 'Customer not found.' });
      return;
    }

    const [accounts, loans, recentTxns] = await Promise.all([
      db.collection('bank_accounts').find({ userEmail: customer.email }).toArray(),
      db.collection('loans').find({ userEmail: customer.email }).toArray(),
      db.collection('transactions')
        .find({
          $or: [{ senderEmail: customer.email }, { receiverEmail: customer.email }],
        })
        .sort({ createdAt: -1 })
        .limit(10)
        .toArray(),
    ]);

    res.json({
      customer,
      accounts,
      loans,
      recentTransactions: recentTxns,
    });
  } catch (err) {
    console.error('[Admin/Customers/:email]', err);
    res.status(500).json({ error: 'Failed to fetch customer details.' });
  }
});

// View specific customer's transaction history
router.get('/customers/:email/transactions', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const { page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    const query = {
      $or: [{ senderEmail: email.toLowerCase() }, { receiverEmail: email.toLowerCase() }],
    };

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
    console.error('[Admin/Customers/:email/transactions]', err);
    res.status(500).json({ error: 'Failed to fetch customer transactions.' });
  }
});

// Activate, deactivate, or block customer account
router.patch('/customers/:email/status', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email } = req.params;
    const { status } = req.body;
    const validStatuses = ['Active', 'Suspended', 'Blocked'];
    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid status. Must be Active, Suspended, or Blocked.' });
      return;
    }
    const db = await getDB();
    await db.collection('users').updateOne(
      { email: email.toLowerCase() },
      { $set: { status, updatedAt: new Date() } }
    );

    // If blocked or suspended, also freeze their bank accounts
    if (status === 'Blocked' || status === 'Suspended') {
      await db.collection('bank_accounts').updateMany(
        { userEmail: email.toLowerCase() },
        { $set: { status: 'Frozen', updatedAt: new Date() } }
      );
    } else if (status === 'Active') {
      await db.collection('bank_accounts').updateMany(
        { userEmail: email.toLowerCase(), status: 'Frozen' },
        { $set: { status: 'Active', updatedAt: new Date() } }
      );
    }

    res.json({ success: true, message: `Customer status updated to ${status}.` });
  } catch (err) {
    console.error('[Admin/Customers/Status]', err);
    res.status(500).json({ error: 'Failed to update status.' });
  }
});

// ─── 3. Bank Account Management ──────────────────────────────────────────────
router.get('/accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { search = '', status = 'All', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (status !== 'All') query.status = status;
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

// Admin creates a bank account for a customer
router.post('/accounts', async (req: Request, res: Response): Promise<void> => {
  try {
    const { userEmail, accountType, initialDeposit, dailyLimit, maxSingleTransaction, minBalance } = req.body;

    if (!userEmail || !accountType) {
      res.status(400).json({ error: 'userEmail and accountType are required.' });
      return;
    }

    const db = await getDB();
    const customer = await db.collection('users').findOne({ email: userEmail.toLowerCase() });
    if (!customer) {
      res.status(404).json({ error: 'Target customer user does not exist.' });
      return;
    }

    const accountNumber = '10' + Math.floor(10000000 + Math.random() * 90000000);
    const depositAmount = Number(initialDeposit) || 0;

    const newAccount = {
      userId: customer._id.toString(),
      userEmail: customer.email,
      userName: customer.name,
      accountNumber,
      accountType,
      balance: depositAmount,
      status: 'Active',
      dailyLimit: Number(dailyLimit) || (accountType === 'Business Account' ? 25000 : 5000),
      maxSingleTransaction: Number(maxSingleTransaction) || (accountType === 'Business Account' ? 10000 : 2000),
      minBalance: Number(minBalance) || (accountType === 'Business Account' ? 500 : 50),
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
        description: `Admin Provisioning Initial Deposit for ${accountType}`,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }

    res.status(201).json({
      success: true,
      message: 'Bank account provisioned successfully.',
      account: { ...newAccount, _id: insertResult.insertedId },
    });
  } catch (err) {
    console.error('[Admin/Accounts/POST]', err);
    res.status(500).json({ error: 'Failed to create bank account.' });
  }
});

// Update account information (limits, freeze/unfreeze status)
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
    const result = await db.collection('bank_accounts').updateOne({ accountNumber }, { $set: updateFields });

    if (result.matchedCount === 0) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    res.json({ success: true, message: 'Account updated successfully.' });
  } catch (err) {
    console.error('[Admin/Accounts/PATCH]', err);
    res.status(500).json({ error: 'Failed to update account.' });
  }
});

// ─── 4. Transaction Management & Suspicious Review ───────────────────────────
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
        { description: r },
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

// Admin review / resolve flagged suspicious transaction
router.patch('/transactions/:txnId/review', async (req: Request, res: Response): Promise<void> => {
  try {
    const { txnId } = req.params;
    const { action, note } = req.body; // action: 'Dismiss' | 'Reverse'

    const db = await getDB();
    const txn = await db.collection('transactions').findOne({ transactionId: txnId });

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found.' });
      return;
    }

    const now = new Date();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updates: any = {
      adminReviewNote: note || '',
      adminReviewedAt: now,
      updatedAt: now,
    };

    if (action === 'Dismiss') {
      updates.isSuspicious = false;
      updates.flagStatus = 'Resolved - Normal';
    } else if (action === 'Reverse' && txn.status === 'Completed') {
      if (txn.type === 'Transfer') {
        await db.collection('bank_accounts').updateOne(
          { accountNumber: txn.senderAccount },
          { $inc: { balance: txn.amount }, $set: { updatedAt: now } }
        );
        await db.collection('bank_accounts').updateOne(
          { accountNumber: txn.receiverAccount },
          { $inc: { balance: -txn.amount }, $set: { updatedAt: now } }
        );
      }
      updates.status = 'Reversed';
      updates.flagStatus = 'Resolved - Reversed';
    }

    await db.collection('transactions').updateOne({ transactionId: txnId }, { $set: updates });
    res.json({ success: true, message: `Transaction review recorded: ${action}.` });
  } catch (err) {
    console.error('[Admin/Transactions/Review]', err);
    res.status(500).json({ error: 'Failed to review transaction.' });
  }
});

// ─── 5. Loan Management & Automatic Disbursement ─────────────────────────────
router.get('/loans', async (req: Request, res: Response): Promise<void> => {
  try {
    const { status = 'All', search = '', page = '1', limit = '20' } = req.query as Record<string, string>;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (status !== 'All') query.status = status;
    if (search.trim()) {
      const r = new RegExp(search.trim(), 'i');
      query.$or = [{ loanId: r }, { userName: r }, { userEmail: r }, { accountNumber: r }];
    }

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

// Approve or reject loan application (With recorded banking transaction disbursement)
router.patch('/loans/:loanId', async (req: Request, res: Response): Promise<void> => {
  const mongoClient = getClient();
  const session = mongoClient ? mongoClient.startSession() : null;

  try {
    const { loanId } = req.params;
    const { status, adminNote } = req.body;
    const validStatuses = ['Pending', 'Under Review', 'Approved', 'Rejected', 'Active', 'Completed'];

    if (!validStatuses.includes(status)) {
      res.status(400).json({ error: 'Invalid loan status.' });
      return;
    }

    const db = await getDB();
    const loan = await db.collection('loans').findOne({ loanId });

    if (!loan) {
      res.status(404).json({ error: 'Loan not found.' });
      return;
    }

    const now = new Date();

    // If approving a pending or under-review loan, disburse funds atomically
    if (status === 'Approved' && (loan.status === 'Pending' || loan.status === 'Under Review')) {
      const disburseAmount = Number(loan.requestedAmount);
      const targetAccount = loan.accountNumber;

      const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();

      if (session) {
        await session.withTransaction(async () => {
          await db.collection('loans').updateOne(
            { loanId },
            {
              $set: {
                status: 'Active',
                adminNote: adminNote || 'Approved and disbursed by System Admin',
                remainingBalance: disburseAmount,
                paidAmount: 0,
                approvedAt: now,
                disbursedAt: now,
                updatedAt: now,
              },
            },
            { session }
          );

          await db.collection('bank_accounts').updateOne(
            { accountNumber: targetAccount },
            { $inc: { balance: disburseAmount }, $set: { updatedAt: now } },
            { session }
          );

          await db.collection('transactions').insertOne(
            {
              transactionId: txnId,
              senderAccount: 'SYSTEM',
              senderName: 'Vaultly Loan Department',
              senderEmail: 'loans@vaultly.bank',
              receiverAccount: targetAccount,
              receiverName: loan.userName,
              receiverEmail: loan.userEmail,
              type: 'Loan Disbursement',
              amount: disburseAmount,
              fee: 0,
              status: 'Completed',
              description: `${loan.loanType} Disbursement — Approved Loan ID: ${loanId}`,
              relatedLoanId: loanId,
              createdAt: now,
              updatedAt: now,
            },
            { session }
          );

          await db.collection('notifications').insertOne(
            {
              userEmail: loan.userEmail,
              title: 'Loan Approved & Disbursed',
              message: `Your ${loan.loanType} application (${loanId}) of $${disburseAmount} was approved and disbursed into account ${targetAccount}.`,
              type: 'Loan',
              read: false,
              createdAt: now,
            },
            { session }
          );
        });
        await session.endSession();
      } else {
        await db.collection('loans').updateOne({ loanId }, {
          $set: {
            status: 'Active',
            adminNote: adminNote || 'Approved and disbursed by System Admin',
            remainingBalance: disburseAmount,
            paidAmount: 0,
            approvedAt: now,
            disbursedAt: now,
            updatedAt: now,
          },
        });
        await db.collection('bank_accounts').updateOne(
          { accountNumber: targetAccount },
          { $inc: { balance: disburseAmount }, $set: { updatedAt: now } }
        );
        await db.collection('transactions').insertOne({
          transactionId: txnId,
          senderAccount: 'SYSTEM',
          senderName: 'Vaultly Loan Department',
          senderEmail: 'loans@vaultly.bank',
          receiverAccount: targetAccount,
          receiverName: loan.userName,
          receiverEmail: loan.userEmail,
          type: 'Loan Disbursement',
          amount: disburseAmount,
          fee: 0,
          status: 'Completed',
          description: `${loan.loanType} Disbursement — Approved Loan ID: ${loanId}`,
          relatedLoanId: loanId,
          createdAt: now,
          updatedAt: now,
        });
        await db.collection('notifications').insertOne({
          userEmail: loan.userEmail,
          title: 'Loan Approved & Disbursed',
          message: `Your ${loan.loanType} application (${loanId}) of $${disburseAmount} was approved and disbursed into account ${targetAccount}.`,
          type: 'Loan',
          read: false,
          createdAt: now,
        });
      }

      res.json({
        success: true,
        message: `Loan ${loanId} approved and $${disburseAmount} disbursed to account ${targetAccount}.`,
      });
      return;
    }

    // Otherwise update status
    await db.collection('loans').updateOne(
      { loanId },
      { $set: { status, adminNote: adminNote || '', updatedAt: now } }
    );

    if (status === 'Rejected') {
      await db.collection('notifications').insertOne({
        userEmail: loan.userEmail,
        title: 'Loan Application Rejected',
        message: `Your ${loan.loanType} application (${loanId}) was not approved. Note: ${adminNote || 'Does not meet current credit requirements.'}`,
        type: 'Loan',
        read: false,
        createdAt: now,
      });
    }

    res.json({ success: true, message: `Loan status updated to ${status}.` });
  } catch (err) {
    if (session) await session.endSession();
    console.error('[Admin/Loans/PATCH]', err);
    res.status(500).json({ error: 'Failed to update loan.' });
  }
});

// ─── 6. Deposit/Withdrawal Approval ──────────────────────────────────────────
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

      await db.collection('notifications').insertOne({
        userEmail: reqDoc.userEmail,
        title: `${reqDoc.type} Approved`,
        message: `Your ${reqDoc.type} request of $${reqDoc.amount} on account ${reqDoc.accountNumber} has been approved.`,
        type: 'Transaction',
        read: false,
        createdAt: now,
      });
    } else {
      await db.collection('notifications').insertOne({
        userEmail: reqDoc.userEmail,
        title: `${reqDoc.type} Request Rejected`,
        message: `Your ${reqDoc.type} request of $${reqDoc.amount} on account ${reqDoc.accountNumber} was rejected by bank administration.`,
        type: 'Transaction',
        read: false,
        createdAt: now,
      });
    }

    res.json({ success: true, message: `Request ${status}.` });
  } catch (err) {
    console.error('[Admin/Requests/PATCH]', err);
    res.status(500).json({ error: 'Failed to process request.' });
  }
});

// ─── 7. Staff Management ─────────────────────────────────────────────────────
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
    const bcrypt = await import('bcryptjs');
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
    res.status(201).json({ success: true, message: 'Staff created successfully.' });
  } catch (err) {
    console.error('[Admin/Staff/POST]', err);
    res.status(500).json({ error: 'Failed to create staff.' });
  }
});

export default router;
