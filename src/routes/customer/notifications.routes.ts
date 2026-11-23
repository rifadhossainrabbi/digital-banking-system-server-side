import { Router, Request, Response } from 'express';
import { ObjectId } from 'mongodb';
import { getDB } from '../../lib/db';

const router = Router();

// ─── GET /api/customer/notifications ─────────────────────────────────────────
// Fetch recent notifications for logged in customer
router.get('/', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();

    const notifications = await db
      .collection('notifications')
      .find({ userEmail: email })
      .sort({ createdAt: -1 })
      .limit(30)
      .toArray();

    const unreadCount = await db
      .collection('notifications')
      .countDocuments({ userEmail: email, read: false });

    res.json({ notifications, unreadCount });
  } catch (err) {
    console.error('[Notifications/GET]', err);
    res.status(500).json({ error: 'Failed to retrieve notifications.' });
  }
});

// ─── PATCH /api/customer/notifications/:id/read ───────────────────────────────
// Mark single notification as read
router.patch('/:id/read', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const { id } = req.params;

    const db = await getDB();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let filter: any = { _id: id, userEmail: email };
    if (ObjectId.isValid(id)) {
      filter = { _id: new ObjectId(id), userEmail: email };
    }

    await db.collection('notifications').updateOne(filter, { $set: { read: true } });
    res.json({ success: true });
  } catch (err) {
    console.error('[Notifications/Read]', err);
    res.status(500).json({ error: 'Failed to mark notification as read.' });
  }
});

// ─── PATCH /api/customer/notifications/read-all ──────────────────────────────
// Mark all notifications as read
router.patch('/read-all', async (req: Request, res: Response): Promise<void> => {
  try {
    const email = req.user!.email.toLowerCase();
    const db = await getDB();

    await db
      .collection('notifications')
      .updateMany({ userEmail: email, read: false }, { $set: { read: true } });

    res.json({ success: true, message: 'All notifications marked as read.' });
  } catch (err) {
    console.error('[Notifications/ReadAll]', err);
    res.status(500).json({ error: 'Failed to mark notifications as read.' });
  }
});

export default router;
