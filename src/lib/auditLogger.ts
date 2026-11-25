import { getDB } from './db';

export interface AuditLogEntry {
  actorEmail: string;
  actorRole: 'Admin' | 'Bank Staff' | 'Customer' | 'System';
  action: string;
  targetResource: string;
  targetId?: string;
  details?: Record<string, any>;
  ipAddress?: string;
  timestamp: Date;
}

/**
 * Persists an immutable security & compliance audit log in MongoDB.
 */
export async function logAuditEvent(entry: Omit<AuditLogEntry, 'timestamp'>): Promise<void> {
  try {
    const db = await getDB();
    const auditLogsCol = db.collection('audit_logs');
    await auditLogsCol.insertOne({
      ...entry,
      timestamp: new Date(),
    });
  } catch (err) {
    console.error('[AuditLogger] Failed to write audit log:', err);
  }
}
