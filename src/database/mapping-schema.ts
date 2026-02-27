/**
 * Database schema for the NetSuite mapping configuration.
 *
 * All configuration is managed from NetSuite (via the Suitelet dashboard
 * or the REST API). Nothing is pushed back to CorpayOne — it is read-only.
 *
 * The mapping tables translate data that arrives from CorpayOne
 * (categories, VAT rates, currencies) into the correct NetSuite
 * GL accounts, tax codes, bank accounts, and subsidiaries.
 */
export const MAPPING_SCHEMA_SQL = `
  -- Maps CorpayOne expense categories to NetSuite GL accounts.
  -- When an expense is booked in CorpayOne under a category (e.g. "IT Equipment"),
  -- this table determines which NetSuite GL account it should post to.
  -- Also supports matching by account_code for backwards compatibility.
  CREATE TABLE IF NOT EXISTS account_mappings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    corpayone_category TEXT NOT NULL,
    corpayone_account_code TEXT,
    netsuite_account_id TEXT NOT NULL,
    netsuite_account_name TEXT,
    subsidiary_id TEXT,
    is_default INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(corpayone_category, subsidiary_id)
  );

  -- Maps CorpayOne VAT rates to NetSuite tax codes.
  -- When an invoice line has e.g. 25% VAT from a Danish vendor,
  -- this table resolves it to the correct NetSuite tax code.
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

  -- Configures which NetSuite bank account to use per currency.
  -- When a payment comes through in EUR, this determines the bank account.
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

  -- Configures which NetSuite subsidiary CorpayOne transactions book into.
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

  CREATE INDEX IF NOT EXISTS idx_account_mappings_category ON account_mappings(corpayone_category);
  CREATE INDEX IF NOT EXISTS idx_account_mappings_code ON account_mappings(corpayone_account_code);
  CREATE INDEX IF NOT EXISTS idx_tax_code_mappings_rate ON tax_code_mappings(corpayone_vat_rate);
  CREATE INDEX IF NOT EXISTS idx_bank_account_config_currency ON bank_account_config(currency);
`;
