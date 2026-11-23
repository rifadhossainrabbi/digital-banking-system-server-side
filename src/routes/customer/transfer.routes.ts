import { Router, Request, Response } from 'express';
import { getDB, getClient } from '../../lib/db';

const router = Router();

// ─── POST /api/customer/transfer ─────────────────────────────────────────────
// Atomic fund transfer with PIN verification, balance & limit checks,
// rule-based suspicious detection, and notification dispatch.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const mongoClient = getClient();
  const session = mongoClient ? mongoClient.startSession() : null;

  try {
    const senderEmail = req.user!.email.toLowerCase();
    const { senderAccountNumber, receiverAccountNumber, amount, description, transactionPin } =
      req.body;

    if (!senderAccountNumber || !receiverAccountNumber || !amount || !transactionPin) {
      res.status(400).json({ error: 'Missing required fields (senderAccount, receiverAccount, amount, transactionPin).' });
      return;
    }

    const transferAmount = Number(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      res.status(400).json({ error: 'Invalid transfer amount. Must be greater than 0.' });
      return;
    }
    if (senderAccountNumber === receiverAccountNumber) {
      res.status(400).json({ error: 'Cannot transfer to the same account.' });
      return;
    }

    const db = await getDB();
    const bankAccountsCol = db.collection('bank_accounts');
    const transactionsCol = db.collection('transactions');
    const usersCol = db.collection('users');
    const notificationsCol = db.collection('notifications');

    // 1. Validate sender account ownership & status
    const senderAccount = await bankAccountsCol.findOne({
      accountNumber: senderAccountNumber,
      userEmail: senderEmail,
    });
    if (!senderAccount) {
      res.status(403).json({ error: 'Sender account not found or unauthorized.' });
      return;
    }
    if (senderAccount.status !== 'Active') {
      res.status(400).json({ error: `Sender account is ${senderAccount.status}. Cannot perform transactions.` });
      return;
    }

    // 2. PIN verification with bcrypt (lazy-loaded)
    const bcrypt = await import('bcryptjs');
    const senderUser = await usersCol.findOne({ email: senderEmail });
    if (!senderUser?.transactionPin) {
      res.status(400).json({ error: 'Transaction PIN not set for your account.' });
      return;
    }
    const pinMatch = await bcrypt.compare(String(transactionPin), senderUser.transactionPin);
    if (!pinMatch) {
      res.status(401).json({ error: 'Invalid transaction PIN.' });
      return;
    }

    // 3. Validate receiver account & status
    const receiverAccount = await bankAccountsCol.findOne({
      accountNumber: receiverAccountNumber,
    });
    if (!receiverAccount) {
      res.status(404).json({ error: 'Recipient bank account not found in system.' });
      return;
    }
    if (receiverAccount.status !== 'Active') {
      res.status(400).json({ error: 'Recipient account is not in Active status.' });
      return;
    }

    // 4. Minimum balance validation
    const minBalance = senderAccount.minBalance ?? 50;
    if (senderAccount.balance - transferAmount < minBalance) {
      res.status(400).json({
        error: `Insufficient balance. A minimum reserve balance of $${minBalance.toFixed(2)} must be maintained.`,
      });
      return;
    }

    // 5. Single transaction limit check
    if (transferAmount > senderAccount.maxSingleTransaction) {
      res.status(400).json({
        error: `Transfer amount ($${transferAmount}) exceeds your single-transaction limit of $${senderAccount.maxSingleTransaction.toFixed(2)}.`,
      });
      return;
    }

    // 6. Daily limit check (today's cumulative transfers)
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);
    const todayTotal = await transactionsCol
      .aggregate([
        {
          $match: {
            senderAccount: senderAccountNumber,
            type: 'Transfer',
            status: 'Completed',
            createdAt: { $gte: startOfDay },
          },
        },
        { $group: { _id: null, total: { $sum: '$amount' } } },
      ])
      .toArray();

    const usedToday = todayTotal[0]?.total ?? 0;
    if (usedToday + transferAmount > senderAccount.dailyLimit) {
      res.status(400).json({
        error: `Daily transfer limit of $${senderAccount.dailyLimit.toFixed(2)} would be exceeded. Used today: $${usedToday.toFixed(2)}.`,
      });
      return;
    }

    // 7. Rule-based Suspicious Transaction Detection
    // Flag if amount >= $10,000 or exceeds 80% of daily limit
    const isSuspicious =
      transferAmount >= 10000 || transferAmount >= senderAccount.dailyLimit * 0.8;
    const flaggedReason = isSuspicious
      ? transferAmount >= 10000
        ? 'High-value transaction exceeding $10,000 regulatory threshold'
        : 'Transaction consumes over 80% of account daily limit'
      : undefined;

    const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const fee = 0;
    const now = new Date();

    const txnDoc = {
      transactionId: txnId,
      senderAccount: senderAccountNumber,
      senderName: senderAccount.userName,
      senderEmail,
      receiverAccount: receiverAccountNumber,
      receiverName: receiverAccount.userName,
      receiverEmail: receiverAccount.userEmail,
      type: 'Transfer',
      amount: transferAmount,
      fee,
      status: 'Completed',
      description: description || 'Fund Transfer',
      isSuspicious: Boolean(isSuspicious),
      flaggedReason: flaggedReason || null,
      flagStatus: isSuspicious ? 'Flagged by Security Rule' : null,
      createdAt: now,
      updatedAt: now,
    };

    if (session) {
      await session.withTransaction(async () => {
        // Deduct from sender
        await bankAccountsCol.updateOne(
          { accountNumber: senderAccountNumber },
          { $inc: { balance: -(transferAmount + fee) }, $set: { updatedAt: now } },
          { session }
        );
        // Credit receiver
        await bankAccountsCol.updateOne(
          { accountNumber: receiverAccountNumber },
          { $inc: { balance: transferAmount }, $set: { updatedAt: now } },
          { session }
        );
        // Record transaction
        await transactionsCol.insertOne(txnDoc, { session });

        // Dispatch notifications
        await notificationsCol.insertMany(
          [
            {
              userEmail: senderEmail,
              title: 'Fund Transfer Sent',
              message: `You successfully transferred $${transferAmount.toFixed(2)} to ${receiverAccount.userName} (${receiverAccountNumber}). Reference: ${txnId}`,
              type: 'Transfer',
              read: false,
              createdAt: now,
            },
            {
              userEmail: receiverAccount.userEmail,
              title: 'Money Received',
              message: `You received $${transferAmount.toFixed(2)} from ${senderAccount.userName} into account ${receiverAccountNumber}. Reference: ${txnId}`,
              type: 'Transfer',
              read: false,
              createdAt: now,
            },
          ],
          { session }
        );
      });
      await session.endSession();
    } else {
      // Direct sequential updates
      await bankAccountsCol.updateOne(
        { accountNumber: senderAccountNumber },
        { $inc: { balance: -(transferAmount + fee) }, $set: { updatedAt: now } }
      );
      await bankAccountsCol.updateOne(
        { accountNumber: receiverAccountNumber },
        { $inc: { balance: transferAmount }, $set: { updatedAt: now } }
      );
      await transactionsCol.insertOne(txnDoc);

      await notificationsCol.insertMany([
        {
          userEmail: senderEmail,
          title: 'Fund Transfer Sent',
          message: `You successfully transferred $${transferAmount.toFixed(2)} to ${receiverAccount.userName} (${receiverAccountNumber}). Reference: ${txnId}`,
          type: 'Transfer',
          read: false,
          createdAt: now,
        },
        {
          userEmail: receiverAccount.userEmail,
          title: 'Money Received',
          message: `You received $${transferAmount.toFixed(2)} from ${senderAccount.userName} into account ${receiverAccountNumber}. Reference: ${txnId}`,
          type: 'Transfer',
          read: false,
          createdAt: now,
        },
      ]);
    }

    res.json({
      success: true,
      transactionId: txnId,
      amount: transferAmount,
      fee,
      senderAccount: senderAccountNumber,
      receiverName: receiverAccount.userName,
      receiverAccount: receiverAccountNumber,
      isSuspicious,
      timestamp: now.toISOString(),
      message: 'Transfer completed successfully.',
    });
  } catch (err) {
    if (session) await session.endSession();
    console.error('[Transfer/POST]', err);
    res.status(500).json({ error: 'Transfer failed. Transaction rolled back.' });
  }
});

export default router;
