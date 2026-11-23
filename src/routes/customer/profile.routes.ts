import { Router, Request, Response } from 'express';
import bcrypt from 'bcryptjs';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/profile ────────────────────────────────────────────────
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();

    const user = await db.collection('users').findOne({ email });
    if (!user) {
      res.status(404).json({ error: 'User not found.' });
      return;
    }

    res.json({
      id: user._id.toString(),
      name: user.name,
      email: user.email,
      phone: user.phone || null,
      image: user.image || null,
      role: user.role,
      status: user.status,
      createdAt: user.createdAt,
    });
  } catch (err) {
    console.error('[Profile/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve profile.' });
  }
});

// ─── PATCH /api/customer/profile ─────────────────────────────────────────────
// Update profile fields: name, phone, image
router.patch('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { name, phone, image } = req.body;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const updateFields: any = { updatedAt: new Date() };
    if (name) updateFields.name = name.trim();
    if (phone) updateFields.phone = phone.trim();
    if (image !== undefined) updateFields.image = image;

    const db = await getDB();
    await db.collection('users').updateOne({ email }, { $set: updateFields });

    // Also sync name in bank_accounts if name changed
    if (name) {
      await db
        .collection('bank_accounts')
        .updateMany({ userEmail: email }, { $set: { userName: name.trim() } });
    }

    res.json({ success: true, message: 'Profile updated successfully.' });
  } catch (err) {
    console.error('[Profile/PATCH]', err);
    res.status(500).json({ error: 'Failed to update profile.' });
  }
});

// ─── PATCH /api/customer/profile/change-pin ───────────────────────────────────
// Change transaction PIN
router.patch('/change-pin', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { currentPin, newPin } = req.body;

    if (!currentPin || !newPin) {
      res.status(400).json({ error: 'currentPin and newPin are required.' });
      return;
    }
    if (String(newPin).length < 4) {
      res.status(400).json({ error: 'PIN must be at least 4 digits.' });
      return;
    }

    const db = await getDB();
    const user = await db.collection('users').findOne({ email });

    if (!user?.transactionPin) {
      res.status(400).json({ error: 'No PIN set. Please set a PIN first.' });
      return;
    }

    const match = await bcrypt.compare(String(currentPin), user.transactionPin);
    if (!match) {
      res.status(401).json({ error: 'Current PIN is incorrect.' });
      return;
    }

    const hashed = await bcrypt.hash(String(newPin), 10);
    await db
      .collection('users')
      .updateOne({ email }, { $set: { transactionPin: hashed, updatedAt: new Date() } });

    res.json({ success: true, message: 'Transaction PIN changed successfully.' });
  } catch (err) {
    console.error('[Profile/change-pin]', err);
    res.status(500).json({ error: 'Failed to change PIN.' });
  }
});

// ─── PATCH /api/customer/profile/change-password ─────────────────────────────
router.patch('/change-password', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { currentPassword, newPassword } = req.body;

    if (!currentPassword || !newPassword) {
      res.status(400).json({ error: 'currentPassword and newPassword are required.' });
      return;
    }
    if (newPassword.length < 8) {
      res.status(400).json({ error: 'New password must be at least 8 characters.' });
      return;
    }

    const db = await getDB();
    const user = await db.collection('users').findOne({ email });

    if (!user?.password) {
      res.status(400).json({ error: 'Password not set for this account.' });
      return;
    }

    const match = await bcrypt.compare(currentPassword, user.password);
    if (!match) {
      res.status(401).json({ error: 'Current password is incorrect.' });
      return;
    }

    const hashed = await bcrypt.hash(newPassword, 10);
    await db
      .collection('users')
      .updateOne({ email }, { $set: { password: hashed, updatedAt: new Date() } });

    res.json({ success: true, message: 'Password changed successfully.' });
  } catch (err) {
    console.error('[Profile/change-password]', err);
    res.status(500).json({ error: 'Failed to change password.' });
  }
});

export default router;
