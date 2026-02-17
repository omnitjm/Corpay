/**
 * Database schema for the NetSuite mapping configuration.
 *
 * These tables store the user-configured mappings between CorpayOne
 * categories/tax rates and NetSuite accounts/tax codes, similar to
 * how Pleo's NetSuite integration lets admins map accounts, tax codes,
 * bank accounts, and subsidiaries from within NetSuite.
 */
export const MAPPING_SCHEMA_SQL = `
  -- Maps CorpayOne account codes / categories to NetSuite GL accounts
  CREATE TABLE IF NOT EXISTS account_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_account_code TEXT NOT NULL,
    corpayone_label TEXT,
    netsuite_account_id TEXT NOT NULL,
    netsuite_account_name TEXT,
    subsidiary_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(corpayone_account_code, subsidiary_id)
  );

  -- Maps CorpayOne VAT rates to NetSuite tax codes
  CREATE TABLE IF NOT EXISTS tax_code_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_vat_rate REAL NOT NULL,
    corpayone_label TEXT,
    netsuite_tax_code_id TEXT NOT NULL,
    netsuite_tax_code_name TEXT,
    subsidiary_id TEXT,
    country_code TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(corpayone_vat_rate, subsidiary_id, country_code)
  );

  -- Configures which NetSuite bank account to use for CorpayOne payments
  CREATE TABLE IF NOT EXISTS bank_account_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    netsuite_bank_account_id TEXT NOT NULL,
    netsuite_bank_account_name TEXT,
    currency TEXT,
    subsidiary_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(currency, subsidiary_id)
  );

  -- Configures which NetSuite subsidiary CorpayOne transactions book into
  CREATE TABLE IF NOT EXISTS subsidiary_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    netsuite_subsidiary_id TEXT NOT NULL,
    netsuite_subsidiary_name TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    corpayone_entity_id TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(corpayone_entity_id)
  );

  -- General integration settings (key-value store)
  CREATE TABLE IF NOT EXISTS integration_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_account_mappings_code ON account_mappings(corpayone_account_code);
  CREATE INDEX IF NOT EXISTS idx_tax_code_mappings_rate ON tax_code_mappings(corpayone_vat_rate);
  CREATE INDEX IF NOT EXISTS idx_bank_account_config_currency ON bank_account_config(currency);
`;
