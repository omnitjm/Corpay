import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import { config } from '../config';
import { SCHEMA_SQL } from './schema';
import { logger } from '../logger';
import type { SyncedBill, SyncedPayment, SyncedVendor, SyncStatus } from '../types/sync';

let db: Database.Database | null = null;

export function getDatabase(): Database.Database {
  if (!db) {
    const dbDir = path.dirname(config.database.path);
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }

    db = new Database(config.database.path);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    logger.info({ path: config.database.path }, 'Database initialized');
  }
  return db;
}

export function closeDatabase(): void {
  if (db) {
    db.close();
    db = null;
  }
}

// --- Vendor operations ---

export function upsertSyncedVendor(
  corpayone_vendor_id: string,
  vendor_name: string,
  netsuite_vendor_id: string | null,
  status: SyncStatus,
  error_message: string | null = null,
): SyncedVendor {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO synced_vendors (corpayone_vendor_id, vendor_name, netsuite_vendor_id, status, last_synced_at, error_message, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(corpayone_vendor_id) DO UPDATE SET
      netsuite_vendor_id = COALESCE(excluded.netsuite_vendor_id, synced_vendors.netsuite_vendor_id),
      vendor_name = excluded.vendor_name,
      status = excluded.status,
      last_synced_at = datetime('now'),
      error_message = excluded.error_message,
      updated_at = datetime('now')
  `);
  stmt.run(corpayone_vendor_id, vendor_name, netsuite_vendor_id, status, error_message);

  return getSyncedVendorByCorpayId(corpayone_vendor_id)!;
}

export function getSyncedVendorByCorpayId(corpayone_vendor_id: string): SyncedVendor | undefined {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM synced_vendors WHERE corpayone_vendor_id = ?')
    .get(corpayone_vendor_id) as SyncedVendor | undefined;
}

// --- Bill operations ---

export function upsertSyncedBill(
  corpayone_invoice_id: string,
  netsuite_vendor_bill_id: string | null,
  netsuite_vendor_id: string | null,
  status: SyncStatus,
  corpayone_status: string,
  corpayone_updated_at: string,
  error_message: string | null = null,
): SyncedBill {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO synced_bills (corpayone_invoice_id, netsuite_vendor_bill_id, netsuite_vendor_id, status, corpayone_status, corpayone_updated_at, last_synced_at, error_message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(corpayone_invoice_id) DO UPDATE SET
      netsuite_vendor_bill_id = COALESCE(excluded.netsuite_vendor_bill_id, synced_bills.netsuite_vendor_bill_id),
      netsuite_vendor_id = COALESCE(excluded.netsuite_vendor_id, synced_bills.netsuite_vendor_id),
      status = excluded.status,
      corpayone_status = excluded.corpayone_status,
      corpayone_updated_at = excluded.corpayone_updated_at,
      last_synced_at = datetime('now'),
      error_message = excluded.error_message,
      updated_at = datetime('now')
  `);
  stmt.run(
    corpayone_invoice_id,
    netsuite_vendor_bill_id,
    netsuite_vendor_id,
    status,
    corpayone_status,
    corpayone_updated_at,
    error_message,
  );

  return getSyncedBillByCorpayId(corpayone_invoice_id)!;
}

export function getSyncedBillByCorpayId(corpayone_invoice_id: string): SyncedBill | undefined {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM synced_bills WHERE corpayone_invoice_id = ?')
    .get(corpayone_invoice_id) as SyncedBill | undefined;
}

export function getSyncedBillByNetSuiteId(
  netsuite_vendor_bill_id: string,
): SyncedBill | undefined {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM synced_bills WHERE netsuite_vendor_bill_id = ?')
    .get(netsuite_vendor_bill_id) as SyncedBill | undefined;
}

export function getFailedBills(): SyncedBill[] {
  const database = getDatabase();
  return database
    .prepare("SELECT * FROM synced_bills WHERE status = 'failed'")
    .all() as SyncedBill[];
}

// --- Payment operations ---

export function upsertSyncedPayment(
  corpayone_payment_id: string,
  corpayone_invoice_id: string,
  netsuite_payment_id: string | null,
  netsuite_vendor_bill_id: string | null,
  status: SyncStatus,
  corpayone_status: string,
  error_message: string | null = null,
): SyncedPayment {
  const database = getDatabase();
  const stmt = database.prepare(`
    INSERT INTO synced_payments (corpayone_payment_id, corpayone_invoice_id, netsuite_payment_id, netsuite_vendor_bill_id, status, corpayone_status, last_synced_at, error_message, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'), ?, datetime('now'))
    ON CONFLICT(corpayone_payment_id) DO UPDATE SET
      netsuite_payment_id = COALESCE(excluded.netsuite_payment_id, synced_payments.netsuite_payment_id),
      netsuite_vendor_bill_id = COALESCE(excluded.netsuite_vendor_bill_id, synced_payments.netsuite_vendor_bill_id),
      status = excluded.status,
      corpayone_status = excluded.corpayone_status,
      last_synced_at = datetime('now'),
      error_message = excluded.error_message,
      updated_at = datetime('now')
  `);
  stmt.run(
    corpayone_payment_id,
    corpayone_invoice_id,
    netsuite_payment_id,
    netsuite_vendor_bill_id,
    status,
    corpayone_status,
    error_message,
  );

  return getSyncedPaymentByCorpayId(corpayone_payment_id)!;
}

export function getSyncedPaymentByCorpayId(
  corpayone_payment_id: string,
): SyncedPayment | undefined {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM synced_payments WHERE corpayone_payment_id = ?')
    .get(corpayone_payment_id) as SyncedPayment | undefined;
}

export function getPaymentsForInvoice(corpayone_invoice_id: string): SyncedPayment[] {
  const database = getDatabase();
  return database
    .prepare('SELECT * FROM synced_payments WHERE corpayone_invoice_id = ?')
    .all(corpayone_invoice_id) as SyncedPayment[];
}

// --- Sync run operations ---

export function createSyncRun(sync_type: 'full' | 'incremental' | 'webhook'): number {
  const database = getDatabase();
  const result = database
    .prepare("INSERT INTO sync_runs (sync_type, started_at) VALUES (?, datetime('now'))")
    .run(sync_type);
  return Number(result.lastInsertRowid);
}

export function completeSyncRun(
  id: number,
  stats: {
    bills_processed: number;
    bills_synced: number;
    bills_failed: number;
    payments_processed: number;
    payments_synced: number;
    payments_failed: number;
  },
  error_message: string | null = null,
): void {
  const database = getDatabase();
  database
    .prepare(
      `UPDATE sync_runs SET
        completed_at = datetime('now'),
        bills_processed = ?,
        bills_synced = ?,
        bills_failed = ?,
        payments_processed = ?,
        payments_synced = ?,
        payments_failed = ?,
        error_message = ?
      WHERE id = ?`,
    )
    .run(
      stats.bills_processed,
      stats.bills_synced,
      stats.bills_failed,
      stats.payments_processed,
      stats.payments_synced,
      stats.payments_failed,
      error_message,
      id,
    );
}
