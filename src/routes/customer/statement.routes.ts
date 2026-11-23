import { Router, Request, Response } from 'express';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/statement ─────────────────────────────────────────────
// Export account statement as CSV
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { account } = req.query as { account?: string };

    const db = await getDB();
    const bankAccountsCol = db.collection('bank_accounts');
    const transactionsCol = db.collection('transactions');

    if (account) {
      const acc = await bankAccountsCol.findOne({ accountNumber: account, userEmail: email });
      if (!acc) {
        res.status(404).json({ error: 'Account not found or unauthorized.' });
        return;
      }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const query: any = {};
    if (account) {
      query.$or = [{ senderAccount: account }, { receiverAccount: account }];
    } else {
      const userAccounts = await bankAccountsCol.find({ userEmail: email }).toArray();
      const numbers = userAccounts.map((a) => a.accountNumber);
      query.$or = [
        { senderAccount: { $in: numbers } },
        { receiverAccount: { $in: numbers } },
      ];
    }

    const transactions = await transactionsCol
      .find(query)
      .sort({ createdAt: -1 })
      .toArray();

    const headers = [
      'Transaction ID',
      'Date',
      'Type',
      'Amount ($)',
      'Fee ($)',
      'Status',
      'Sender Account',
      'Sender Name',
      'Receiver Account',
      'Receiver Name',
      'Description',
    ];

    const rows = transactions.map((t) => [
      `"${t.transactionId}"`,
      `"${new Date(t.createdAt).toISOString()}"`,
      `"${t.type}"`,
      t.amount,
      t.fee ?? 0,
      `"${t.status}"`,
      `"${t.senderAccount}"`,
      `"${(t.senderName || '').replace(/"/g, '""')}"`,
      `"${t.receiverAccount}"`,
      `"${(t.receiverName || '').replace(/"/g, '""')}"`,
      `"${(t.description || '').replace(/"/g, '""')}"`,
    ]);

    const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="vaultly-statement-${account || 'all'}-${Date.now()}.csv"`
    );
    res.send(csv);
  } catch (err) {
    console.error('[Statement/GET]', err);
    res.status(500).json({ error: 'Failed to generate statement.' });
  }
});

export default router;
