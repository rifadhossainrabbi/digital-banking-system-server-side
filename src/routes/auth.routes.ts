import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { getDB } from '../lib/db';

const router = Router();

// ─── POST /api/auth/login ────────────────────────────────────────────────────
router.post('/login', async (req: Request, res: Response): Promise<void> => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      res.status(400).json({ error: 'Email and password are required.' });
      return;
    }

    const db = await getDB();
    const user = await db
      .collection('users')
      .findOne({ email: email.toLowerCase().trim() });

    if (!user) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      res.status(401).json({ error: 'Invalid credentials.' });
      return;
    }

    if (user.status !== 'Active') {
      res
        .status(403)
        .json({ error: `Account is ${user.status}. Contact support.` });
      return;
    }

    const secret = process.env.JWT_SECRET!;
    const token = jwt.sign(
      {
        userId: user._id.toString(),
        email: user.email,
        role: user.role,
      },
      secret,
      { expiresIn: (process.env.JWT_EXPIRES_IN as jwt.SignOptions['expiresIn']) || '7d' }
    );

    res.json({
      token,
      user: {
        id: user._id.toString(),
        name: user.name,
        email: user.email,
        role: user.role,
        image: user.image || null,
        phone: user.phone || null,
      },
    });
  } catch (err) {
    console.error('[Auth/Login]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─── POST /api/auth/register ─────────────────────────────────────────────────
router.post('/register', async (req: Request, res: Response): Promise<void> => {
  try {
    const { name, email, password, phone, transactionPin, accountType = 'Savings Account' } = req.body;

    if (!name || !email || !password) {
      res.status(400).json({ error: 'Name, email, and password are required.' });
      return;
    }

    const validAccountTypes = ['Savings Account', 'Current Account', 'Business Account'];
    const chosenType = validAccountTypes.includes(accountType) ? accountType : 'Savings Account';

    const db = await getDB();
    const existing = await db
      .collection('users')
      .findOne({ email: email.toLowerCase().trim() });

    if (existing) {
      res.status(409).json({ error: 'Email already registered.' });
      return;
    }

    if (password.length < 8) {
      res
        .status(400)
        .json({ error: 'Password must be at least 8 characters.' });
      return;
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const hashedPin = transactionPin
      ? await bcrypt.hash(transactionPin, 10)
      : await bcrypt.hash('0000', 10);

    const result = await db.collection('users').insertOne({
      name: name.trim(),
      email: email.toLowerCase().trim(),
      password: hashedPassword,
      transactionPin: hashedPin,
      role: 'Customer',
      accountType: chosenType,
      status: 'Active',
      phone: phone || null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    const newUserId = result.insertedId.toString();
    const accountNumber = '10' + Math.floor(10000000 + Math.random() * 90000000);
    const limits =
      chosenType === 'Business Account'
        ? { dailyLimit: 50000, maxSingleTransaction: 20000, minBalance: 500 }
        : chosenType === 'Current Account'
        ? { dailyLimit: 15000, maxSingleTransaction: 5000, minBalance: 100 }
        : { dailyLimit: 5000, maxSingleTransaction: 2000, minBalance: 50 };

    await db.collection('bank_accounts').insertOne({
      userId: newUserId,
      userEmail: email.toLowerCase().trim(),
      userName: name.trim(),
      accountNumber,
      accountType: chosenType,
      balance: 1000.0,
      status: 'Active',
      ...limits,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    res.status(201).json({
      success: true,
      message: 'Registration successful.',
      userId: newUserId,
      accountNumber,
      accountType: chosenType,
    });
  } catch (err) {
    console.error('[Auth/Register]', err);
    res.status(500).json({ error: 'Internal Server Error' });
  }
});

// ─── GET /api/auth/me ─────────────────────────────────────────────────────────
router.get('/me', async (req: Request, res: Response): Promise<void> => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Unauthorized.' });
      return;
    }

    const token = authHeader.split(' ')[1];
    const secret = process.env.JWT_SECRET!;
    const payload = jwt.verify(token, secret) as { email: string };

    const db = await getDB();
    const user = await db
      .collection('users')
      .findOne({ email: payload.email.toLowerCase() });

    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    res.json({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      role: user.role,
      image: user.image || null,
      phone: user.phone || null,
      status: user.status,
    });
  } catch {
    res.status(401).json({ error: 'Invalid or expired token.' });
  }
});

export default router;
