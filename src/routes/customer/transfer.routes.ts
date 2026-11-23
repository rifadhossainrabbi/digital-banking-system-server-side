import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDB, getClient } from '../../lib/db';

const router = Router();

// ─── POST /api/customer/transfer ─────────────────────────────────────────────
// Atomic fund transfer with PIN verification, balance & limit checks
router.post('/', async (req: Request, res: Response): Promise<void> => {
  const mongoClient = getClient();

  // Try to use a MongoDB session for atomicity (Atlas supports transactions)
  const session = mongoClient ? mongoClient.startSession() : null;

  try {
    const senderEmail = req.user!.email.toLowerCase();
    const { senderAccountNumber, receiverAccountNumber, amount, description, transactionPin } =
      req.body;

    if (!senderAccountNumber || !receiverAccountNumber || !amount || !transactionPin) {
      res.status(400).json({ error: 'Missing required fields.' });
      return;
    }

    const transferAmount = Number(amount);
    if (isNaN(transferAmount) || transferAmount <= 0) {
      res.status(400).json({ error: 'Invalid transfer amount.' });
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

    // 1. Validate sender account ownership
    const senderAccount = await bankAccountsCol.findOne({
      accountNumber: senderAccountNumber,
      userEmail: senderEmail,
    });
    if (!senderAccount) {
      res.status(403).json({ error: 'Sender account not found or unauthorized.' });
      return;
    }
    if (senderAccount.status !== 'Active') {
      res.status(400).json({ error: `Sender account is ${senderAccount.status}.` });
      return;
    }

    // 2. PIN verification
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

    // 3. Validate receiver account
    const receiverAccount = await bankAccountsCol.findOne({
      accountNumber: receiverAccountNumber,
    });
    if (!receiverAccount) {
      res.status(404).json({ error: 'Recipient account not found.' });
      return;
    }
    if (receiverAccount.status !== 'Active') {
      res.status(400).json({ error: 'Recipient account is not active.' });
      return;
    }

    // 4. Balance checks
    const minBalance = senderAccount.minBalance ?? 50;
    if (senderAccount.balance - transferAmount < minBalance) {
      res.status(400).json({
        error: `Insufficient balance. Minimum balance of $${minBalance} must be maintained.`,
      });
      return;
    }

    // 5. Transaction limit checks
    if (transferAmount > senderAccount.maxSingleTransaction) {
      res.status(400).json({
        error: `Amount exceeds single-transaction limit of $${senderAccount.maxSingleTransaction}.`,
      });
      return;
    }

    // 6. Daily limit check (sum of today's completed transfers from sender)
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
        error: `Daily transfer limit of $${senderAccount.dailyLimit} would be exceeded.`,
      });
      return;
    }

    // 7. Atomic update
    const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const fee = 0;
    const now = new Date();

    if (session) {
      await session.withTransaction(async () => {
        await bankAccountsCol.updateOne(
          { accountNumber: senderAccountNumber },
          { $inc: { balance: -(transferAmount + fee) }, $set: { updatedAt: now } },
          { session }
        );
        await bankAccountsCol.updateOne(
          { accountNumber: receiverAccountNumber },
          { $inc: { balance: transferAmount }, $set: { updatedAt: now } },
          { session }
        );
        await transactionsCol.insertOne(
          {
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
            createdAt: now,
            updatedAt: now,
          },
          { session }
        );
      });
      await session.endSession();
    } else {
      // Fallback: sequential updates (no Atlas replica set available)
      await bankAccountsCol.updateOne(
        { accountNumber: senderAccountNumber },
        { $inc: { balance: -(transferAmount + fee) }, $set: { updatedAt: now } }
      );
      await bankAccountsCol.updateOne(
        { accountNumber: receiverAccountNumber },
        { $inc: { balance: transferAmount }, $set: { updatedAt: now } }
      );
      await transactionsCol.insertOne({
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
        createdAt: now,
        updatedAt: now,
      });
    }

    res.json({
      success: true,
      transactionId: txnId,
      amount: transferAmount,
      fee,
      receiverName: receiverAccount.userName,
      receiverAccount: receiverAccountNumber,
      timestamp: now.toISOString(),
    });
  } catch (err) {
    if (session) await session.endSession();
    console.error('[Transfer/POST]', err);
    res.status(500).json({ error: 'Transfer failed. Please try again.' });
  }
});

export default router;
