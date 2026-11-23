import { Router, Request, Response } from 'express';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/loans ─────────────────────────────────────────────────
// All loans for this customer
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();

    const loans = await db
      .collection('loans')
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .toArray();

    res.json({ loans });
  } catch (err) {
    console.error('[Loans/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve loans.' });
  }
});

// ─── POST /api/customer/loans ─────────────────────────────────────────────────
// Apply for a loan:
// - Micro-loans (<= $1,000) are auto-approved & disbursed immediately.
// - Larger loans (> $1,000) enter 'Pending' state for Staff/Admin review and approval.
router.post('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const {
      accountNumber,
      loanType,
      requestedAmount,
      durationMonths,
      monthlyIncome,
      employmentStatus,
      description,
    } = req.body;

    if (!accountNumber || !loanType || !requestedAmount || !durationMonths) {
      res.status(400).json({ error: 'Missing required loan fields (accountNumber, loanType, requestedAmount, durationMonths).' });
      return;
    }

    const amount = Number(requestedAmount);
    const months = Number(durationMonths);
    const income = Number(monthlyIncome) || 0;

    if (isNaN(amount) || amount <= 0) {
      res.status(400).json({ error: 'Invalid loan amount. Must be greater than 0.' });
      return;
    }
    if (isNaN(months) || months < 3 || months > 60) {
      res.status(400).json({ error: 'Duration must be between 3 and 60 months.' });
      return;
    }

    const db = await getDB();
    const account = await db
      .collection('bank_accounts')
      .findOne({ accountNumber, userEmail: email });

    if (!account) {
      res.status(404).json({ error: 'Target account not found or unauthorized.' });
      return;
    }
    if (account.status !== 'Active') {
      res.status(400).json({ error: `Account is ${account.status}. Cannot receive loan disbursements.` });
      return;
    }

    // Check no duplicate active/pending loan for this customer
    const activeLoan = await db.collection('loans').findOne({
      userEmail: email,
      status: { $in: ['Active', 'Pending', 'Under Review'] },
    });
    if (activeLoan) {
      res
        .status(400)
        .json({ error: `You already have an existing ${activeLoan.status.toLowerCase()} loan (${activeLoan.loanId}). Multiple concurrent applications are restricted.` });
      return;
    }

    // EMI Calculation (5.5% APR fixed)
    const ANNUAL_RATE = 5.5;
    const monthlyRate = ANNUAL_RATE / 100 / 12;
    const monthlyInstallment =
      monthlyRate === 0
        ? amount / months
        : (amount * monthlyRate * Math.pow(1 + monthlyRate, months)) /
          (Math.pow(1 + monthlyRate, months) - 1);

    const loanId = 'LN-' + Math.floor(10000 + Math.random() * 90000);
    const user = await db.collection('users').findOne({ email });
    const now = new Date();

    // Auto-approve micro loans (<= $1,000) for instant simulation; larger loans require Admin approval
    const isAutoApproved = amount <= 1000;
    const initialStatus = isAutoApproved ? 'Active' : 'Pending';

    const loanDoc = {
      loanId,
      userId: req.user!.userId,
      userEmail: email,
      userName: user?.name || 'Customer',
      accountNumber,
      loanType,
      requestedAmount: amount,
      interestRate: ANNUAL_RATE,
      durationMonths: months,
      monthlyInstallment: parseFloat(monthlyInstallment.toFixed(2)),
      monthlyIncome: income,
      employmentStatus: employmentStatus || 'Employed',
      description: description || '',
      status: initialStatus,
      remainingBalance: isAutoApproved ? amount : 0,
      paidAmount: 0,
      repayments: [],
      approvedAt: isAutoApproved ? now : null,
      disbursedAt: isAutoApproved ? now : null,
      createdAt: now,
      updatedAt: now,
    };

    await db.collection('loans').insertOne(loanDoc);

    if (isAutoApproved) {
      // Disburse loan amount to account immediately
      await db.collection('bank_accounts').updateOne(
        { accountNumber },
        { $inc: { balance: amount }, $set: { updatedAt: now } }
      );

      // Record disbursement transaction
      const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
      await db.collection('transactions').insertOne({
        transactionId: txnId,
        senderAccount: 'SYSTEM',
        senderName: 'Vaultly Loan Department',
        senderEmail: 'loans@vaultly.bank',
        receiverAccount: accountNumber,
        receiverName: user?.name || 'Customer',
        receiverEmail: email,
        type: 'Loan Disbursement',
        amount,
        fee: 0,
        status: 'Completed',
        description: `${loanType} Instant Micro-Disbursement — Loan ID: ${loanId}`,
        relatedLoanId: loanId,
        createdAt: now,
        updatedAt: now,
      });

      await db.collection('notifications').insertOne({
        userEmail: email,
        title: 'Micro-Loan Approved & Disbursed',
        message: `Your micro-loan of $${amount} was approved and disbursed into account ${accountNumber}.`,
        type: 'Loan',
        read: false,
        createdAt: now,
      });
    } else {
      await db.collection('notifications').insertOne({
        userEmail: email,
        title: 'Loan Application Submitted',
        message: `Your application for a ${loanType} of $${amount} has been received (Loan ID: ${loanId}). It is under staff & admin review.`,
        type: 'Loan',
        read: false,
        createdAt: now,
      });
    }

    res.status(201).json({
      success: true,
      loanId,
      status: initialStatus,
      monthlyInstallment: parseFloat(monthlyInstallment.toFixed(2)),
      message: isAutoApproved
        ? `Instant loan of $${amount} approved and credited to account ${accountNumber}.`
        : `Loan application for $${amount} submitted successfully. Status: Pending Admin Review.`,
    });
  } catch (err) {
    console.error('[Loans/POST]', err);
    res.status(500).json({ error: 'Failed to process loan application.' });
  }
});

// ─── GET /api/customer/loans/:loanId ─────────────────────────────────────────
router.get('/:loanId', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { loanId } = req.params;

    const db = await getDB();
    const loan = await db.collection('loans').findOne({ loanId, userEmail: email });

    if (!loan) {
      res.status(404).json({ error: 'Loan not found.' });
      return;
    }

    res.json({ loan });
  } catch (err) {
    console.error('[Loans/GET/:id]', err);
    res.status(500).json({ error: 'Failed to retrieve loan.' });
  }
});

// ─── POST /api/customer/loans/:loanId/repay ───────────────────────────────────
// Pay installment from account balance
router.post('/:loanId/repay', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { loanId } = req.params;
    const { accountNumber, amount } = req.body;

    if (!accountNumber || !amount) {
      res.status(400).json({ error: 'accountNumber and amount are required.' });
      return;
    }

    const repayAmount = Number(amount);
    if (isNaN(repayAmount) || repayAmount <= 0) {
      res.status(400).json({ error: 'Invalid repayment amount.' });
      return;
    }

    const db = await getDB();
    const bankAccountsCol = db.collection('bank_accounts');
    const loansCol = db.collection('loans');

    const loan = await loansCol.findOne({ loanId, userEmail: email });
    if (!loan) {
      res.status(404).json({ error: 'Loan not found.' });
      return;
    }
    if (loan.status !== 'Active') {
      res.status(400).json({ error: `Loan is ${loan.status}. Only Active loans can be repaid.` });
      return;
    }

    const account = await bankAccountsCol.findOne({ accountNumber, userEmail: email });
    if (!account) {
      res.status(404).json({ error: 'Account not found or unauthorized.' });
      return;
    }

    const minBalance = account.minBalance ?? 50;
    if (account.balance - repayAmount < minBalance) {
      res.status(400).json({
        error: `Insufficient balance. A minimum reserve balance of $${minBalance.toFixed(2)} must remain.`,
      });
      return;
    }

    const now = new Date();
    const paymentId = 'PAY-' + Math.random().toString(36).substring(2, 6).toUpperCase();
    const newRemaining = Math.max(0, loan.remainingBalance - repayAmount);
    const newPaid = (loan.paidAmount || 0) + repayAmount;
    const newStatus = newRemaining === 0 ? 'Completed' : 'Active';

    const repaymentEntry = {
      paymentId,
      amount: repayAmount,
      paymentDate: now,
      accountNumber,
      remainingAfter: newRemaining,
    };

    // Update loan
    await loansCol.updateOne(
      { loanId },
      {
        $set: {
          remainingBalance: newRemaining,
          paidAmount: newPaid,
          status: newStatus,
          updatedAt: now,
        },
        $push: { repayments: repaymentEntry as never },
      }
    );

    // Deduct from account
    await bankAccountsCol.updateOne(
      { accountNumber },
      { $inc: { balance: -repayAmount }, $set: { updatedAt: now } }
    );

    // Record repayment transaction
    const txnId = 'TXN-' + Math.random().toString(36).substring(2, 9).toUpperCase();
    const user = await db.collection('users').findOne({ email });
    await db.collection('transactions').insertOne({
      transactionId: txnId,
      senderAccount: accountNumber,
      senderName: user?.name || 'Customer',
      senderEmail: email,
      receiverAccount: 'SYSTEM',
      receiverName: 'Vaultly Loan Department',
      receiverEmail: 'loans@vaultly.bank',
      type: 'Loan Repayment',
      amount: repayAmount,
      fee: 0,
      status: 'Completed',
      description: `Loan Repayment — ID: ${loanId} | Payment: ${paymentId}`,
      relatedLoanId: loanId,
      createdAt: now,
      updatedAt: now,
    });

    // Notify customer
    await db.collection('notifications').insertOne({
      userEmail: email,
      title: newStatus === 'Completed' ? 'Loan Fully Paid Off!' : 'Loan Payment Recorded',
      message:
        newStatus === 'Completed'
          ? `Congratulations! Loan ${loanId} has been paid in full.`
          : `Payment of $${repayAmount.toFixed(2)} recorded for Loan ${loanId}. Remaining balance: $${newRemaining.toFixed(2)}.`,
      type: 'Loan',
      read: false,
      createdAt: now,
    });

    res.json({
      success: true,
      paymentId,
      remainingBalance: newRemaining,
      paidAmount: newPaid,
      loanStatus: newStatus,
      message:
        newStatus === 'Completed'
          ? `🎉 Loan ${loanId} fully repaid!`
          : `Payment of $${repayAmount.toFixed(2)} recorded. Remaining: $${newRemaining.toFixed(2)}.`,
    });
  } catch (err) {
    console.error('[Loans/Repay]', err);
    res.status(500).json({ error: 'Failed to process repayment.' });
  }
});

export default router;
