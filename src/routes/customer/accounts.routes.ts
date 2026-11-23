import { Router, Request, Response } from 'express';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/accounts ─────────────────────────────────────────────
// Fetch all accounts for logged-in customer; auto-create if none exist
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();
    const col = db.collection('bank_accounts');

    let accounts = await col.find({ userEmail: email }).toArray();

    // Auto-create default Savings Account if no accounts exist
    if (accounts.length === 0) {
      const accountNumber = '10' + Math.floor(10000000 + Math.random() * 90000000);
      const defaultAccount = {
        userId: req.user!.userId,
        userEmail: email,
        userName: (await db.collection('users').findOne({ email }))?.name || 'Customer',
        accountNumber,
        accountType: 'Savings Account',
        balance: 1000.0,
        status: 'Active',
        dailyLimit: 5000,
        maxSingleTransaction: 2000,
        minBalance: 50,
        createdAt: new Date(),
        updatedAt: new Date(),
      };
      const result = await col.insertOne(defaultAccount);
      accounts = [{ ...defaultAccount, _id: result.insertedId }];
    }

    res.json({ accounts });
  } catch (err) {
    console.error('[Accounts/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve accounts.' });
  }
});

// ─── POST /api/customer/accounts ─────────────────────────────────────────────
// Open a new bank account
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { accountType, initialDeposit } = req.body;

    const validTypes = ['Savings Account', 'Current Account', 'Business Account'];
    if (!validTypes.includes(accountType)) {
      res.status(400).json({ error: 'Invalid account type.' });
      return;
    }

    const depositAmount = Number(initialDeposit) || 500.0;
    if (depositAmount < 50) {
      res.status(400).json({ error: 'Minimum opening deposit is $50.' });
      return;
    }

    const db = await getDB();
    const col = db.collection('bank_accounts');

    const count = await col.countDocuments({ userEmail: email });
    if (count >= 5) {
      res.status(400).json({ error: 'Maximum of 5 accounts allowed per customer.' });
      return;
    }

    const user = await db.collection('users').findOne({ email });
    const accountNumber = '10' + Math.floor(10000000 + Math.random() * 90000000);

    const newAccount = {
      userId: req.user!.userId,
      userEmail: email,
      userName: user?.name || 'Customer',
      accountNumber,
      accountType,
      balance: depositAmount,
      status: 'Active',
      dailyLimit: accountType === 'Business Account' ? 25000 : 5000,
      maxSingleTransaction: accountType === 'Business Account' ? 10000 : 2000,
      minBalance: accountType === 'Business Account' ? 500 : 50,
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    const insertResult = await col.insertOne(newAccount);

    // Record opening deposit transaction
    const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    await db.collection('transactions').insertOne({
      transactionId: txnId,
      senderAccount: 'SYSTEM',
      senderName: 'Vaultly Central Reserve',
      senderEmail: 'system@vaultly.bank',
      receiverAccount: accountNumber,
      receiverName: user?.name || 'Customer',
      receiverEmail: email,
      type: 'Deposit',
      amount: depositAmount,
      fee: 0,
      status: 'Completed',
      description: `New ${accountType} Opening Deposit`,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Account created successfully.',
      account: { ...newAccount, _id: insertResult.insertedId },
    });
  } catch (err) {
    console.error('[Accounts/POST]', err);
    res.status(500).json({ error: 'Failed to create account.' });
  }
});

// ─── GET /api/customer/accounts/:accountNumber ───────────────────────────────
// Get a single account detail
router.get('/:accountNumber', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { accountNumber } = req.params;

    const db = await getDB();
    const account = await db.collection('bank_accounts').findOne({
      accountNumber,
      userEmail: email,
    });

    if (!account) {
      res.status(404).json({ error: 'Account not found.' });
      return;
    }

    res.json({ account });
  } catch (err) {
    console.error('[Accounts/GET/:id]', err);
    res.status(500).json({ error: 'Failed to retrieve account.' });
  }
});

export default router;
