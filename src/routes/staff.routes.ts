import { Router, Request, Response } from 'express';
import { authenticate, authorize } from '../middleware/auth.middleware';
import { getDB } from '../lib/db';

const router = Router();
router.use(authenticate);
router.use(authorize('Bank Staff', 'Admin'));

// ─── GET /api/staff/customers ─────────────────────────────────────────────────
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

// ─── GET /api/staff/customers/:email ─────────────────────────────────────────
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

// ─── GET /api/staff/transactions ─────────────────────────────────────────────
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
        { senderAccount: r }, { receiverAccount: r },
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

// ─── GET /api/staff/loans ─────────────────────────────────────────────────────
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

// ─── PATCH /api/staff/loans/:loanId/note ─────────────────────────────────────
// Add internal staff note (staff cannot approve)
router.patch('/loans/:loanId/note', async (req: Request, res: Response): Promise<void> => {
  try {
    const { loanId } = req.params;
    const { note } = req.body;

    if (!note?.trim()) {
      res.status(400).json({ error: 'Note is required.' });
      return;
    }

    const db = await getDB();
    await db.collection('loans').updateOne(
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

    res.json({ success: true, message: 'Note added.' });
  } catch (err) {
    console.error('[Staff/Loans/Note]', err);
    res.status(500).json({ error: 'Failed to add note.' });
  }
});

// ─── POST /api/staff/customers ─────────────────────────────────────────────────
// Register a new customer (staff privilege)
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

export default router;
