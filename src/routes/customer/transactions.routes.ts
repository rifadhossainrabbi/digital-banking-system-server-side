import { Router, Request, Response } from 'express';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/transactions ──────────────────────────────────────────
// Paginated, searchable, date-filterable transaction history for current customer
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const {
      account = 'All',
      type = 'All',
      status = 'All',
      startDate,
      endDate,
      search = '',
      page = '1',
      limit = '10',
    } = req.query as Record<string, string>;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const db = await getDB();
    const bankAccountsCol = db.collection('bank_accounts');
    const transactionsCol = db.collection('transactions');

    // Get all account numbers belonging to this customer
    const userAccounts = await bankAccountsCol.find({ userEmail: email }).toArray();
    const accountNumbers = userAccounts.map((a) => a.accountNumber);

    if (accountNumbers.length === 0) {
      res.json({ transactions: [], total: 0, page: pageNum, totalPages: 0 });
      return;
    }

    // Build query
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};

    if (account !== 'All') {
      query.$or = [
        { senderAccount: account },
        { receiverAccount: account },
      ];
    } else {
      query.$or = [
        { senderAccount: { $in: accountNumbers } },
        { receiverAccount: { $in: accountNumbers } },
      ];
    }

    if (type !== 'All') {
      query.type = type;
    }

    if (status !== 'All') {
      query.status = status;
    }

    if (startDate || endDate) {
      query.createdAt = {};
      if (startDate) query.createdAt.$gte = new Date(startDate);
      if (endDate) query.createdAt.$lte = new Date(endDate);
    }

    if (search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      query.$and = [
        ...(query.$and || []),
        {
          $or: [
            { transactionId: regex },
            { description: regex },
            { senderName: regex },
            { receiverName: regex },
            { senderAccount: regex },
            { receiverAccount: regex },
          ],
        },
      ];
    }

    const [total, transactions] = await Promise.all([
      transactionsCol.countDocuments(query),
      transactionsCol
        .find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .toArray(),
    ]);

    res.json({
      transactions,
      total,
      page: pageNum,
      totalPages: Math.ceil(total / limitNum),
    });
  } catch (err) {
    console.error('[Transactions/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve transactions.' });
  }
});

// ─── GET /api/customer/transactions/:txnId ────────────────────────────────────
// Get a single transaction detail (ownership enforced)
router.get('/:txnId', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { txnId } = req.params;

    const db = await getDB();
    const userAccounts = await db
      .collection('bank_accounts')
      .find({ userEmail: email })
      .toArray();
    const accountNumbers = userAccounts.map((a) => a.accountNumber);

    const txn = await db.collection('transactions').findOne({
      transactionId: txnId,
      $or: [
        { senderAccount: { $in: accountNumbers } },
        { receiverAccount: { $in: accountNumbers } },
      ],
    });

    if (!txn) {
      res.status(404).json({ error: 'Transaction not found or unauthorized.' });
      return;
    }

    res.json({ transaction: txn });
  } catch (err) {
    console.error('[Transactions/GET/:txnId]', err);
    res.status(500).json({ error: 'Failed to retrieve transaction.' });
  }
});

export default router;
