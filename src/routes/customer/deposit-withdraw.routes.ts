import { Router, Request, Response } from 'express';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/deposit-withdraw ──────────────────────────────────────
// Get all deposit/withdrawal requests for this customer
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();

    const requests = await db
      .collection('deposit_withdraw_requests')
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ requests });
  } catch (err) {
    console.error('[DepositWithdraw/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve requests.' });
  }
});

// ─── POST /api/customer/deposit-withdraw ─────────────────────────────────────
// Submit deposit or withdrawal request (simulated approval workflow)
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { accountNumber, type, amount, description } = req.body;

    if (!accountNumber || !type || !amount) {
      res.status(400).json({ error: 'accountNumber, type, and amount are required.' });
      return;
    }

    if (!['Deposit', 'Withdrawal'].includes(type)) {
      res.status(400).json({ error: 'Type must be Deposit or Withdrawal.' });
      return;
    }

    const reqAmount = Number(amount);
    if (isNaN(reqAmount) || reqAmount <= 0) {
      res.status(400).json({ error: 'Invalid amount. Must be greater than 0.' });
      return;
    }

    const db = await getDB();
    const bankAccountsCol = db.collection('bank_accounts');
    const account = await bankAccountsCol.findOne({
      accountNumber,
      userEmail: email,
    });

    if (!account) {
      res.status(404).json({ error: 'Account not found or unauthorized.' });
      return;
    }
    if (account.status !== 'Active') {
      res.status(400).json({ error: `Account is ${account.status}. Transactions cannot be processed.` });
      return;
    }

    // For withdrawal: pre-check balance
    if (type === 'Withdrawal') {
      const minBalance = account.minBalance ?? 50;
      if (account.balance - reqAmount < minBalance) {
        res.status(400).json({
          error: `Insufficient balance. A minimum reserve balance of $${minBalance.toFixed(2)} must be maintained. Available: $${account.balance.toFixed(2)}.`,
        });
        return;
      }
    }

    const requestId = 'REQ-' + Math.random().toString(36).substring(2, 8).toUpperCase();
    const now = new Date();

    // Auto-approve amounts <= $500 for smooth simulation testing; larger amounts require Admin approval
    const autoApprove = reqAmount <= 500;
    const status = autoApprove ? 'Approved' : 'Pending';

    const requestDoc = {
      requestId,
      userEmail: email,
      accountNumber,
      accountType: account.accountType,
      type,
      amount: reqAmount,
      description: description || `${type} Request`,
      status,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('deposit_withdraw_requests').insertOne(requestDoc);

    if (autoApprove) {
      const balanceDelta = type === 'Deposit' ? reqAmount : -reqAmount;
      await bankAccountsCol.updateOne(
        { accountNumber },
        { $inc: { balance: balanceDelta }, $set: { updatedAt: now } }
      );

      const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
      const user = await db.collection('users').findOne({ email });

      await db.collection('transactions').insertOne({
        transactionId: txnId,
        senderAccount: type === 'Deposit' ? 'SYSTEM' : accountNumber,
        senderName: type === 'Deposit' ? 'Vaultly Central Reserve' : user?.name || 'Customer',
        senderEmail: type === 'Deposit' ? 'system@vaultly.bank' : email,
        receiverAccount: type === 'Deposit' ? accountNumber : 'SYSTEM',
        receiverName: type === 'Deposit' ? user?.name || 'Customer' : 'Vaultly Processing',
        receiverEmail: type === 'Deposit' ? email : 'system@vaultly.bank',
        type,
        amount: reqAmount,
        fee: 0,
        status: 'Completed',
        description: description || `${type} - Instant Simulated Approval`,
        relatedRequestId: requestId,
        createdAt: now,
        updatedAt: now,
      });

      await db.collection('notifications').insertOne({
        userEmail: email,
        title: `${type} Approved`,
        message: `Your ${type} of $${reqAmount.toFixed(2)} for account ${accountNumber} has been instantly cleared and updated.`,
        type: 'Transaction',
        read: false,
        createdAt: now,
      });
    } else {
      await db.collection('notifications').insertOne({
        userEmail: email,
        title: `${type} Request Under Review`,
        message: `Your ${type} request of $${reqAmount.toFixed(2)} on account ${accountNumber} has been submitted (ID: ${requestId}). Awaiting staff/admin approval.`,
        type: 'Transaction',
        read: false,
        createdAt: now,
      });
    }

    res.status(201).json({
      success: true,
      requestId,
      status,
      message: autoApprove
        ? `${type} of $${reqAmount.toFixed(2)} approved instantly.`
        : `${type} request of $${reqAmount.toFixed(2)} submitted. Awaiting bank staff/admin review.`,
    });
  } catch (err) {
    console.error('[DepositWithdraw/POST]', err);
    res.status(500).json({ error: 'Failed to submit request.' });
  }
});

// ─── GET /api/customer/deposit-withdraw/:requestId ───────────────────────────
router.get('/:requestId', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { requestId } = req.params;

    const db = await getDB();
    const request = await db.collection('deposit_withdraw_requests').findOne({
      requestId,
      userEmail: email,
    });

    if (!request) {
      res.status(404).json({ error: 'Request not found.' });
      return;
    }

    res.json({ request });
  } catch (err) {
    console.error('[DepositWithdraw/GET/:id]', err);
    res.status(500).json({ error: 'Failed to retrieve request.' });
  }
});

export default router;
