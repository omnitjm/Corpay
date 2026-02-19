import { getDatabase } from './db';
import { MAPPING_SCHEMA_SQL } from './mapping-schema';
import { logger } from '../logger';

let mappingSchemaInitialized = false;

/** Ensure the mapping tables exist */
function ensureMappingSchema(): void {
  if (mappingSchemaInitialized) return;
  const db = getDatabase();
  db.exec(MAPPING_SCHEMA_SQL);
  mappingSchemaInitialized = true;
  logger.debug('Mapping schema initialized');
}

// --- Account Mappings ---
// The primary key for account mapping is the CorpayOne **category**
// (what the user sees in CorpayOne, e.g. "IT Equipment", "Office Supplies").
// The account_code field is stored for reference but the category drives the lookup.

export interface AccountMapping {
  id: number;
  corpayone_category: string;
  corpayone_account_code: string | null;
  netsuite_account_id: string;
  netsuite_account_name: string | null;
  subsidiary_id: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

/**
 * Resolve which NetSuite GL account to use for a CorpayOne line item.
 *
 * Lookup order:
 *   1. Match by category + subsidiary
 *   2. Match by category (no subsidiary)
 *   3. Match by account_code + subsidiary
 *   4. Match by account_code (no subsidiary)
 *   5. Default mapping (is_default = 1)
 */
export function getAccountMapping(
  category?: string,
  accountCode?: string,
  subsidiaryId?: string,
): AccountMapping | undefined {
  ensureMappingSchema();
  const db = getDatabase();

  // 1. Try category + subsidiary
  if (category && subsidiaryId) {
    const exact = db
      .prepare(
        'SELECT * FROM account_mappings WHERE corpayone_category = ? AND subsidiary_id = ?',
      )
      .get(category, subsidiaryId) as AccountMapping | undefined;
    if (exact) return exact;
  }

  // 2. Try category only
  if (category) {
    const byCat = db
      .prepare(
        'SELECT * FROM account_mappings WHERE corpayone_category = ? AND subsidiary_id IS NULL',
      )
      .get(category) as AccountMapping | undefined;
    if (byCat) return byCat;
  }

  // 3. Try account_code + subsidiary
  if (accountCode && subsidiaryId) {
    const byCode = db
      .prepare(
        'SELECT * FROM account_mappings WHERE corpayone_account_code = ? AND subsidiary_id = ?',
      )
      .get(accountCode, subsidiaryId) as AccountMapping | undefined;
    if (byCode) return byCode;
  }

  // 4. Try account_code only
  if (accountCode) {
    const byCode = db
      .prepare(
        'SELECT * FROM account_mappings WHERE corpayone_account_code = ? AND subsidiary_id IS NULL',
      )
      .get(accountCode) as AccountMapping | undefined;
    if (byCode) return byCode;
  }

  // 5. Fall back to default
  return db
    .prepare('SELECT * FROM account_mappings WHERE is_default = 1 LIMIT 1')
    .get() as AccountMapping | undefined;
}

export function getAllAccountMappings(): AccountMapping[] {
  ensureMappingSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM account_mappings ORDER BY is_default DESC, corpayone_category')
    .all() as AccountMapping[];
}

export function upsertAccountMapping(mapping: {
  corpayone_category: string;
  corpayone_account_code?: string;
  netsuite_account_id: string;
  netsuite_account_name?: string;
  subsidiary_id?: string;
  is_default?: boolean;
}): AccountMapping {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO account_mappings (corpayone_category, corpayone_account_code, netsuite_account_id, netsuite_account_name, subsidiary_id, is_default, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(corpayone_category, subsidiary_id) DO UPDATE SET
      corpayone_account_code = excluded.corpayone_account_code,
      netsuite_account_id = excluded.netsuite_account_id,
      netsuite_account_name = excluded.netsuite_account_name,
      is_default = excluded.is_default,
      updated_at = datetime('now')
  `).run(
    mapping.corpayone_category,
    mapping.corpayone_account_code || null,
    mapping.netsuite_account_id,
    mapping.netsuite_account_name || null,
    mapping.subsidiary_id || null,
    mapping.is_default ? 1 : 0,
  );

  return getAccountMapping(mapping.corpayone_category, mapping.corpayone_account_code, mapping.subsidiary_id)!;
}

export function deleteAccountMapping(id: number): void {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare('DELETE FROM account_mappings WHERE id = ?').run(id);
}

// --- Tax Code Mappings ---

export interface TaxCodeMapping {
  id: number;
  corpayone_vat_rate: number;
  corpayone_label: string | null;
  netsuite_tax_code_id: string;
  netsuite_tax_code_name: string | null;
  subsidiary_id: string | null;
  country_code: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export function getTaxCodeMapping(
  vatRate: number,
  subsidiaryId?: string,
  countryCode?: string,
): TaxCodeMapping | undefined {
  ensureMappingSchema();
  const db = getDatabase();

  if (subsidiaryId && countryCode) {
    const exact = db
      .prepare(
        'SELECT * FROM tax_code_mappings WHERE corpayone_vat_rate = ? AND subsidiary_id = ? AND country_code = ?',
      )
      .get(vatRate, subsidiaryId, countryCode) as TaxCodeMapping | undefined;
    if (exact) return exact;
  }

  if (countryCode) {
    const byCountry = db
      .prepare(
        'SELECT * FROM tax_code_mappings WHERE corpayone_vat_rate = ? AND country_code = ? AND subsidiary_id IS NULL',
      )
      .get(vatRate, countryCode) as TaxCodeMapping | undefined;
    if (byCountry) return byCountry;
  }

  const byRate = db
    .prepare(
      'SELECT * FROM tax_code_mappings WHERE corpayone_vat_rate = ? AND subsidiary_id IS NULL AND country_code IS NULL',
    )
    .get(vatRate) as TaxCodeMapping | undefined;
  if (byRate) return byRate;

  return db
    .prepare('SELECT * FROM tax_code_mappings WHERE is_default = 1 LIMIT 1')
    .get() as TaxCodeMapping | undefined;
}

export function getAllTaxCodeMappings(): TaxCodeMapping[] {
  ensureMappingSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM tax_code_mappings ORDER BY is_default DESC, corpayone_vat_rate')
    .all() as TaxCodeMapping[];
}

export function upsertTaxCodeMapping(mapping: {
  corpayone_vat_rate: number;
  corpayone_label?: string;
  netsuite_tax_code_id: string;
  netsuite_tax_code_name?: string;
  subsidiary_id?: string;
  country_code?: string;
  is_default?: boolean;
}): TaxCodeMapping {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO tax_code_mappings (corpayone_vat_rate, corpayone_label, netsuite_tax_code_id, netsuite_tax_code_name, subsidiary_id, country_code, is_default, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(corpayone_vat_rate, subsidiary_id, country_code) DO UPDATE SET
      corpayone_label = excluded.corpayone_label,
      netsuite_tax_code_id = excluded.netsuite_tax_code_id,
      netsuite_tax_code_name = excluded.netsuite_tax_code_name,
      is_default = excluded.is_default,
      updated_at = datetime('now')
  `).run(
    mapping.corpayone_vat_rate,
    mapping.corpayone_label || null,
    mapping.netsuite_tax_code_id,
    mapping.netsuite_tax_code_name || null,
    mapping.subsidiary_id || null,
    mapping.country_code || null,
    mapping.is_default ? 1 : 0,
  );

  return getTaxCodeMapping(mapping.corpayone_vat_rate, mapping.subsidiary_id, mapping.country_code)!;
}

export function deleteTaxCodeMapping(id: number): void {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare('DELETE FROM tax_code_mappings WHERE id = ?').run(id);
}

// --- Bank Account Config ---

export interface BankAccountConfig {
  id: number;
  netsuite_bank_account_id: string;
  netsuite_bank_account_name: string | null;
  currency: string | null;
  subsidiary_id: string | null;
  is_default: number;
  created_at: string;
  updated_at: string;
}

export function getBankAccountConfig(
  currency?: string,
  subsidiaryId?: string,
): BankAccountConfig | undefined {
  ensureMappingSchema();
  const db = getDatabase();

  if (currency && subsidiaryId) {
    const exact = db
      .prepare(
        'SELECT * FROM bank_account_config WHERE currency = ? AND subsidiary_id = ?',
      )
      .get(currency, subsidiaryId) as BankAccountConfig | undefined;
    if (exact) return exact;
  }

  if (currency) {
    const byCurrency = db
      .prepare(
        'SELECT * FROM bank_account_config WHERE currency = ? AND subsidiary_id IS NULL',
      )
      .get(currency) as BankAccountConfig | undefined;
    if (byCurrency) return byCurrency;
  }

  return db
    .prepare('SELECT * FROM bank_account_config WHERE is_default = 1 LIMIT 1')
    .get() as BankAccountConfig | undefined;
}

export function getAllBankAccountConfigs(): BankAccountConfig[] {
  ensureMappingSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM bank_account_config ORDER BY is_default DESC, currency')
    .all() as BankAccountConfig[];
}

export function upsertBankAccountConfig(config: {
  netsuite_bank_account_id: string;
  netsuite_bank_account_name?: string;
  currency?: string;
  subsidiary_id?: string;
  is_default?: boolean;
}): BankAccountConfig {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO bank_account_config (netsuite_bank_account_id, netsuite_bank_account_name, currency, subsidiary_id, is_default, updated_at)
    VALUES (?, ?, ?, ?, ?, datetime('now'))
    ON CONFLICT(currency, subsidiary_id) DO UPDATE SET
      netsuite_bank_account_id = excluded.netsuite_bank_account_id,
      netsuite_bank_account_name = excluded.netsuite_bank_account_name,
      is_default = excluded.is_default,
      updated_at = datetime('now')
  `).run(
    config.netsuite_bank_account_id,
    config.netsuite_bank_account_name || null,
    config.currency || null,
    config.subsidiary_id || null,
    config.is_default ? 1 : 0,
  );

  return getBankAccountConfig(config.currency, config.subsidiary_id)!;
}

export function deleteBankAccountConfig(id: number): void {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare('DELETE FROM bank_account_config WHERE id = ?').run(id);
}

// --- Subsidiary Config ---

export interface SubsidiaryConfig {
  id: number;
  netsuite_subsidiary_id: string;
  netsuite_subsidiary_name: string | null;
  is_default: number;
  corpayone_entity_id: string | null;
  created_at: string;
  updated_at: string;
}

export function getSubsidiaryConfig(
  corpayone_entity_id?: string,
): SubsidiaryConfig | undefined {
  ensureMappingSchema();
  const db = getDatabase();

  if (corpayone_entity_id) {
    const exact = db
      .prepare('SELECT * FROM subsidiary_config WHERE corpayone_entity_id = ?')
      .get(corpayone_entity_id) as SubsidiaryConfig | undefined;
    if (exact) return exact;
  }

  return db
    .prepare('SELECT * FROM subsidiary_config WHERE is_default = 1 LIMIT 1')
    .get() as SubsidiaryConfig | undefined;
}

export function getAllSubsidiaryConfigs(): SubsidiaryConfig[] {
  ensureMappingSchema();
  const db = getDatabase();
  return db
    .prepare('SELECT * FROM subsidiary_config ORDER BY is_default DESC, netsuite_subsidiary_name')
    .all() as SubsidiaryConfig[];
}

export function upsertSubsidiaryConfig(config: {
  netsuite_subsidiary_id: string;
  netsuite_subsidiary_name?: string;
  is_default?: boolean;
  corpayone_entity_id?: string;
}): SubsidiaryConfig {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO subsidiary_config (netsuite_subsidiary_id, netsuite_subsidiary_name, is_default, corpayone_entity_id, updated_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT(corpayone_entity_id) DO UPDATE SET
      netsuite_subsidiary_id = excluded.netsuite_subsidiary_id,
      netsuite_subsidiary_name = excluded.netsuite_subsidiary_name,
      is_default = excluded.is_default,
      updated_at = datetime('now')
  `).run(
    config.netsuite_subsidiary_id,
    config.netsuite_subsidiary_name || null,
    config.is_default ? 1 : 0,
    config.corpayone_entity_id || null,
  );

  return getSubsidiaryConfig(config.corpayone_entity_id)!;
}

export function deleteSubsidiaryConfig(id: number): void {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare('DELETE FROM subsidiary_config WHERE id = ?').run(id);
}

// --- Integration Settings ---

export function getSetting(key: string): string | undefined {
  ensureMappingSchema();
  const db = getDatabase();
  const row = db
    .prepare('SELECT value FROM integration_settings WHERE key = ?')
    .get(key) as { value: string } | undefined;
  return row?.value;
}

export function setSetting(key: string, value: string): void {
  ensureMappingSchema();
  const db = getDatabase();
  db.prepare(`
    INSERT INTO integration_settings (key, value, updated_at)
    VALUES (?, ?, datetime('now'))
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = datetime('now')
  `).run(key, value);
}

export function getAllSettings(): Record<string, string> {
  ensureMappingSchema();
  const db = getDatabase();
  const rows = db
    .prepare('SELECT key, value FROM integration_settings')
    .all() as Array<{ key: string; value: string }>;

  const settings: Record<string, string> = {};
  for (const row of rows) {
    settings[row.key] = row.value;
  }
  return settings;
}
