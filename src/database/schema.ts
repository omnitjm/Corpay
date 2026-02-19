/** SQL statements to create the sync tracking database schema */
export const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS synced_vendors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_vendor_id TEXT NOT NULL UNIQUE,
    netsuite_vendor_id TEXT,
    vendor_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    error_message TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS synced_bills (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_invoice_id TEXT NOT NULL UNIQUE,
    netsuite_vendor_bill_id TEXT,
    netsuite_vendor_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    error_message TEXT,
    corpayone_status TEXT NOT NULL,
    corpayone_updated_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS synced_payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_payment_id TEXT NOT NULL UNIQUE,
    corpayone_invoice_id TEXT NOT NULL,
    netsuite_payment_id TEXT,
    netsuite_vendor_bill_id TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    last_synced_at TEXT,
    error_message TEXT,
    corpayone_status TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sync_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    sync_type TEXT NOT NULL,
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    bills_processed INTEGER NOT NULL DEFAULT 0,
    bills_synced INTEGER NOT NULL DEFAULT 0,
    bills_failed INTEGER NOT NULL DEFAULT 0,
    payments_processed INTEGER NOT NULL DEFAULT 0,
    payments_synced INTEGER NOT NULL DEFAULT 0,
    payments_failed INTEGER NOT NULL DEFAULT 0,
    error_message TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_synced_bills_status ON synced_bills(status);
  CREATE INDEX IF NOT EXISTS idx_synced_bills_corpayone_status ON synced_bills(corpayone_status);
  CREATE INDEX IF NOT EXISTS idx_synced_payments_status ON synced_payments(status);
  CREATE INDEX IF NOT EXISTS idx_synced_payments_invoice ON synced_payments(corpayone_invoice_id);
  CREATE INDEX IF NOT EXISTS idx_synced_vendors_status ON synced_vendors(status);
`;
