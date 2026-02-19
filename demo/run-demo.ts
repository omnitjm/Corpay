#!/usr/bin/env npx ts-node
/**
 * CorpayOne → NetSuite Integration Demo
 *
 * This script demonstrates the complete integration flow using mock data.
 * No real API credentials required - it simulates both CorpayOne and NetSuite
 * APIs with in-memory mocks, showing:
 *
 *   Step 1: Configure mapping (like the NetSuite Suitelet dashboard)
 *   Step 2: Fetch expenses from CorpayOne (v3 API)
 *   Step 3: Sync vendors to NetSuite
 *   Step 4: Sync vendor bills to NetSuite (mapped accounts, multi-line support)
 *   Step 5: Sync payments to NetSuite (with mapped bank account)
 *   Step 6: Show final sync status
 *
 * Run: npx ts-node demo/run-demo.ts
 */

import path from 'path';
import fs from 'fs';

// ─── Set up env vars so config.ts doesn't throw ────────────────────
process.env.CORPAYONE_CLIENT_ID = 'demo-client-id';
process.env.CORPAYONE_CLIENT_SECRET = 'demo-client-secret';
process.env.NETSUITE_ACCOUNT_ID = 'DEMO123';
process.env.NETSUITE_CONSUMER_KEY = 'demo-consumer-key';
process.env.NETSUITE_CONSUMER_SECRET = 'demo-consumer-secret';
process.env.NETSUITE_TOKEN_KEY = 'demo-token-key';
process.env.NETSUITE_TOKEN_SECRET = 'demo-token-secret';
process.env.NETSUITE_AP_ACCOUNT_ID = '400';
process.env.NETSUITE_BANK_ACCOUNT_ID = '152';
process.env.NETSUITE_SUBSIDIARY_ID = '1';
process.env.LOG_LEVEL = 'warn'; // Keep demo output clean

// Use a temp database so we don't pollute real data
const demoDbPath = path.join(__dirname, 'demo-sync.db');
if (fs.existsSync(demoDbPath)) fs.unlinkSync(demoDbPath);
process.env.DATABASE_PATH = demoDbPath;

import {
  expenses,
  payments,
  netsuiteAccounts,
  netsuiteTaxCodes,
  netsuiteSubsidiaries,
} from './mock-data';
import {
  upsertAccountMapping,
  upsertTaxCodeMapping,
  upsertBankAccountConfig,
  upsertSubsidiaryConfig,
  getAllAccountMappings,
  getAllTaxCodeMappings,
  getAllBankAccountConfigs,
  getAllSubsidiaryConfigs,
} from '../src/database/mapping-db';
import { getDatabase, closeDatabase } from '../src/database/db';
import {
  mapExpenseToVendorBill,
  mapPaymentToVendorPayment,
  isSyncableStatus,
  isSyncablePayment,
  formatNetSuiteDate,
} from '../src/mapping/invoice-mapper';

// ─── Pretty-print helpers ──────────────────────────────────────────

const RESET = '\x1b[0m';
const BOLD = '\x1b[1m';
const DIM = '\x1b[2m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const BLUE = '\x1b[34m';
const MAGENTA = '\x1b[35m';
const CYAN = '\x1b[36m';
const RED = '\x1b[31m';
const BG_GREEN = '\x1b[42m';
const BG_BLUE = '\x1b[44m';
const BG_YELLOW = '\x1b[43m';
const WHITE = '\x1b[37m';

function banner(text: string) {
  const line = '═'.repeat(64);
  console.log(`\n${BOLD}${BLUE}╔${line}╗${RESET}`);
  console.log(`${BOLD}${BLUE}║${RESET}  ${BOLD}${text.padEnd(62)}${BLUE}║${RESET}`);
  console.log(`${BOLD}${BLUE}╚${line}╝${RESET}\n`);
}

function step(num: number, text: string) {
  console.log(`${BOLD}${CYAN}  ┌─ Step ${num}: ${text}${RESET}`);
}

function stepEnd() {
  console.log(`${CYAN}  └─ Done${RESET}\n`);
}

function info(text: string) {
  console.log(`${DIM}  │${RESET}  ${text}`);
}

function success(text: string) {
  console.log(`${DIM}  │${RESET}  ${GREEN}✓${RESET} ${text}`);
}

function warn(text: string) {
  console.log(`${DIM}  │${RESET}  ${YELLOW}⚠${RESET} ${text}`);
}

function skip(text: string) {
  console.log(`${DIM}  │${RESET}  ${DIM}⊘ ${text}${RESET}`);
}

function json(label: string, obj: unknown) {
  const str = JSON.stringify(obj, null, 2)
    .split('\n')
    .map((line, i) => (i === 0 ? line : `  │     ${line}`))
    .join('\n');
  console.log(`${DIM}  │${RESET}  ${MAGENTA}${label}:${RESET} ${str}`);
}

function table(rows: Array<Record<string, string>>) {
  if (rows.length === 0) return;
  const keys = Object.keys(rows[0]);
  const widths = keys.map((k) =>
    Math.max(k.length, ...rows.map((r) => String(r[k] || '').length)),
  );

  const header = keys.map((k, i) => k.padEnd(widths[i])).join('  ');
  const sep = widths.map((w) => '─'.repeat(w)).join('──');
  console.log(`${DIM}  │${RESET}  ${BOLD}${header}${RESET}`);
  console.log(`${DIM}  │${RESET}  ${DIM}${sep}${RESET}`);
  for (const row of rows) {
    const line = keys.map((k, i) => String(row[k] || '').padEnd(widths[i])).join('  ');
    console.log(`${DIM}  │${RESET}  ${line}`);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Mock NetSuite state (in-memory) ───────────────────────────────

let nextNsId = 5000;
const nsVendors: Record<string, { id: string; companyName: string; externalId: string }> = {};
const nsBills: Record<string, { id: string; entity: string; externalId: string; tranId: string; total: number; lines: number }> = {};
const nsPayments: Record<string, { id: string; entity: string; externalId: string; appliedTo: string; amount: number }> = {};

function mockCreateVendor(name: string, externalId: string): string {
  const id = String(nextNsId++);
  nsVendors[id] = { id, companyName: name, externalId };
  return id;
}

function mockCreateBill(bill: ReturnType<typeof mapExpenseToVendorBill>): string {
  const id = String(nextNsId++);
  const total = bill.expense?.items.reduce((sum, item) => sum + item.amount, 0) || 0;
  const lines = bill.expense?.items.length || 0;
  nsBills[id] = {
    id,
    entity: bill.entity.id,
    externalId: bill.externalId || '',
    tranId: bill.tranId || '',
    total,
    lines,
  };
  return id;
}

function mockCreatePayment(payment: ReturnType<typeof mapPaymentToVendorPayment>): string {
  const id = String(nextNsId++);
  const apply = payment.apply?.items[0];
  nsPayments[id] = {
    id,
    entity: payment.entity.id,
    externalId: payment.externalId || '',
    appliedTo: apply ? String(apply.doc) : '',
    amount: apply?.amount || 0,
  };
  return id;
}

// ─── Demo script ───────────────────────────────────────────────────

async function runDemo() {
  banner('CorpayOne → NetSuite Integration Demo');

  console.log(`  ${DIM}This demo simulates the full integration flow with mock data.${RESET}`);
  console.log(`  ${DIM}No real API credentials needed.${RESET}\n`);

  // Initialize database
  getDatabase();
  await sleep(300);

  // ── Step 1: Configure mapping ──────────────────────────────────

  step(1, 'Configure Mapping in NetSuite (one-way: CorpayOne → NetSuite)');
  info('An admin opens the CorpayOne Configuration Suitelet in NetSuite.');
  info(`${BOLD}Nothing is configured in CorpayOne${RESET} — it is read-only.`);
  info('The admin maps CorpayOne expense categories to NetSuite GL accounts');
  info('and selects bank accounts for payment sync.\n');

  info(`${BOLD}Configuring subsidiary...${RESET}`);
  upsertSubsidiaryConfig({
    netsuite_subsidiary_id: '1',
    netsuite_subsidiary_name: 'Corpay Denmark ApS',
    is_default: true,
  });
  success(`Subsidiary: Corpay Denmark ApS (NS ID: 1) → Default`);

  await sleep(200);

  info(`\n${BOLD}Mapping CorpayOne categories → NetSuite GL accounts...${RESET}`);
  info(`These categories come from the CorpayOne expense category field.\n`);
  const accountMaps = [
    { corpayone_category: 'IT Equipment', corpayone_account_code: '5010', netsuite_account_id: '201', netsuite_account_name: 'IT Equipment' },
    { corpayone_category: 'Office Supplies', corpayone_account_code: '5020', netsuite_account_id: '202', netsuite_account_name: 'Office Supplies' },
    { corpayone_category: 'Office Furniture', corpayone_account_code: '5030', netsuite_account_id: '203', netsuite_account_name: 'Office Furniture' },
    { corpayone_category: 'Cloud Services', corpayone_account_code: '6100', netsuite_account_id: '301', netsuite_account_name: 'Cloud & Hosting Services' },
    { corpayone_category: 'Default', netsuite_account_id: '400', netsuite_account_name: 'Accounts Payable', is_default: true },
  ];
  for (const m of accountMaps) {
    upsertAccountMapping(m);
    success(`"${m.corpayone_category}" → NS: ${m.netsuite_account_name} (${m.netsuite_account_id})${m.is_default ? ' [DEFAULT]' : ''}`);
  }

  await sleep(200);

  info(`\n${BOLD}Configuring tax code mappings...${RESET}`);
  info(`(CorpayOne v3 API has no VAT data — tax codes apply via NetSuite rules)\n`);
  const taxMaps = [
    { corpayone_vat_rate: 25, corpayone_label: 'DK Moms 25%', netsuite_tax_code_id: 'DK-S-25', netsuite_tax_code_name: 'DK Moms 25%', country_code: 'DK' },
    { corpayone_vat_rate: 19, corpayone_label: 'DE Umsatzsteuer 19%', netsuite_tax_code_id: 'DE-S-19', netsuite_tax_code_name: 'DE Umsatzsteuer 19%', country_code: 'DE' },
    { corpayone_vat_rate: 20, corpayone_label: 'GB VAT 20%', netsuite_tax_code_id: 'GB-S-20', netsuite_tax_code_name: 'GB VAT 20%', country_code: 'GB' },
  ];
  for (const t of taxMaps) {
    upsertTaxCodeMapping(t);
    success(`${t.corpayone_vat_rate}% (${t.corpayone_label}) → NS: ${t.netsuite_tax_code_name}`);
  }

  await sleep(200);

  info(`\n${BOLD}Configuring bank accounts for payments...${RESET}`);
  const bankMaps = [
    { netsuite_bank_account_id: '152', netsuite_bank_account_name: 'CorpayOne Bank (DKK)', currency: 'DKK', is_default: true },
    { netsuite_bank_account_id: '153', netsuite_bank_account_name: 'CorpayOne Bank (EUR)', currency: 'EUR' },
    { netsuite_bank_account_id: '154', netsuite_bank_account_name: 'CorpayOne Bank (GBP)', currency: 'GBP' },
  ];
  for (const b of bankMaps) {
    upsertBankAccountConfig(b);
    success(`${b.currency} → NS: ${b.netsuite_bank_account_name} (${b.netsuite_bank_account_id})${b.is_default ? ' [DEFAULT]' : ''}`);
  }

  stepEnd();
  await sleep(500);

  // ── Step 2: Fetch expenses from CorpayOne ──────────────────────

  step(2, 'Fetch Expenses from CorpayOne (v3 API, read-only)');
  info(`Calling GET /external/v3/expenses ... (CorpayOne is only read, never written to)\n`);

  await sleep(300);

  table(
    expenses.map((exp) => ({
      ID: exp.id,
      Reference: exp.reference || '-',
      Vendor: exp.vendor?.name || '-',
      State: exp.state,
      Amount: `${exp.amount} ${exp.currency}`,
      Lines: String(exp.lines.length),
    })),
  );

  info(`\nFetched ${BOLD}${expenses.length}${RESET} expenses from CorpayOne`);
  stepEnd();
  await sleep(500);

  // ── Step 3: Sync vendors to NetSuite ───────────────────────────

  step(3, 'Sync Vendors to NetSuite');
  info('For each syncable expense, ensure the vendor exists in NetSuite.\n');

  const vendorMap: Record<string, string> = {};
  const seenVendors = new Set<string>();

  for (const exp of expenses) {
    if (!isSyncableStatus(exp.state)) continue;
    if (!exp.vendor) continue;
    if (seenVendors.has(exp.vendor.id)) continue;
    seenVendors.add(exp.vendor.id);

    await sleep(200);
    info(`Looking up vendor "${exp.vendor.name}" (${exp.vendor.id})...`);
    info(`  SuiteQL: SELECT id FROM vendor WHERE externalid = 'corpay-vendor-${exp.vendor.id}'`);
    info(`  → Not found. Creating new vendor...`);

    const nsVendorId = mockCreateVendor(exp.vendor.name, `corpay-vendor-${exp.vendor.id}`);
    vendorMap[exp.vendor.id] = nsVendorId;
    success(`Created vendor "${exp.vendor.name}" → NS Internal ID: ${nsVendorId}`);
  }

  stepEnd();
  await sleep(500);

  // ── Step 4: Sync vendor bills ──────────────────────────────────

  step(4, 'Sync Vendor Bills to NetSuite (with mapped accounts, multi-line support)');
  info('Map each approved expense to a NetSuite Vendor Bill.\n');

  const billMap: Record<string, string> = {};
  let synced = 0;
  let skipped = 0;

  for (const exp of expenses) {
    await sleep(300);

    if (!isSyncableStatus(exp.state)) {
      skip(`${exp.id} (${exp.reference || 'no ref'}) — state "${exp.state}" → Skipped`);
      skipped++;
      continue;
    }

    if (!exp.vendor) {
      warn(`${exp.id} — no vendor → Skipped`);
      skipped++;
      continue;
    }

    const nsVendorId = vendorMap[exp.vendor.id];
    const bill = mapExpenseToVendorBill(exp, nsVendorId);
    const nsBillId = mockCreateBill(bill);
    billMap[exp.id] = nsBillId;
    synced++;

    success(`${exp.id} (${exp.reference}) → NS Vendor Bill #${nsBillId}`);

    // Show each expense line
    if (bill.expense?.items) {
      for (const line of bill.expense.items) {
        const acctName = (netsuiteAccounts as Record<string, { name: string }>)[line.account.id]?.name || line.account.id;
        info(`    → Account: ${acctName} (${line.account.id}) | Amount: ${line.amount} | Memo: ${line.memo || '-'}`);
      }
      info(`    → ${BOLD}${bill.expense.items.length} line(s)${RESET} | Total: ${exp.amount} ${exp.currency}`);
    }
    if (bill.subsidiary) {
      const subName = netsuiteSubsidiaries[bill.subsidiary.id as keyof typeof netsuiteSubsidiaries]?.name || bill.subsidiary.id;
      info(`    → Subsidiary: ${subName}`);
    }
  }

  info(`\nBills synced: ${GREEN}${synced}${RESET}, Skipped: ${DIM}${skipped}${RESET}`);
  stepEnd();
  await sleep(500);

  // ── Step 5: Sync payments ──────────────────────────────────────

  step(5, 'Sync Payments to NetSuite (with mapped bank accounts)');
  info('Map each completed payment to a NetSuite Vendor Payment.\n');

  let paymentsSynced = 0;
  let paymentsSkipped = 0;

  for (const pay of payments) {
    await sleep(300);

    if (!isSyncablePayment(pay)) {
      skip(`${pay.id} — status "${pay.status}" → Skipped (only completed payments sync)`);
      paymentsSkipped++;
      continue;
    }

    const exp = expenses.find((e) => e.id === pay.expense_id);
    if (!exp) {
      warn(`${pay.id} — expense ${pay.expense_id} not found → Skipped`);
      paymentsSkipped++;
      continue;
    }

    if (!exp.vendor) {
      warn(`${pay.id} — expense ${pay.expense_id} has no vendor → Skipped`);
      paymentsSkipped++;
      continue;
    }

    const nsVendorId = vendorMap[exp.vendor.id];
    const nsBillId = billMap[pay.expense_id];
    if (!nsBillId) {
      warn(`${pay.id} — bill not synced for expense ${pay.expense_id} → Marked as pending`);
      paymentsSkipped++;
      continue;
    }

    const vendorPayment = mapPaymentToVendorPayment(pay, exp, nsVendorId, nsBillId);
    const nsPaymentId = mockCreatePayment(vendorPayment);
    paymentsSynced++;

    success(`${pay.id} → NS Vendor Payment #${nsPaymentId}`);
    info(`    → Applied to Bill #${nsBillId} | Amount: ${pay.amount} ${pay.currency}`);

    if (vendorPayment.account) {
      const bankName = (netsuiteAccounts as Record<string, { name: string }>)[vendorPayment.account.id]?.name || vendorPayment.account.id;
      info(`    → Bank Account: ${bankName} (${vendorPayment.account.id})`);
    }
    if (vendorPayment.tranDate) {
      info(`    → Payment Date: ${vendorPayment.tranDate}`);
    }
  }

  info(`\nPayments synced: ${GREEN}${paymentsSynced}${RESET}, Skipped: ${DIM}${paymentsSkipped}${RESET}`);
  stepEnd();
  await sleep(500);

  // ── Step 6: Final status ───────────────────────────────────────

  step(6, 'Final Sync Status');
  info('Summary of all records synced:\n');

  info(`${BOLD}NetSuite Vendors:${RESET}`);
  table(
    Object.values(nsVendors).map((v) => ({
      'NS ID': v.id,
      'Company Name': v.companyName,
      'External ID': v.externalId,
    })),
  );

  info(`\n${BOLD}NetSuite Vendor Bills:${RESET}`);
  table(
    Object.values(nsBills).map((b) => ({
      'NS ID': b.id,
      'Vendor ID': b.entity,
      'Tran ID': b.tranId,
      'Total': String(b.total),
      'Lines': String(b.lines),
      'External ID': b.externalId,
    })),
  );

  info(`\n${BOLD}NetSuite Vendor Payments:${RESET}`);
  table(
    Object.values(nsPayments).map((p) => ({
      'NS ID': p.id,
      'Vendor ID': p.entity,
      'Applied To Bill': p.appliedTo,
      'Amount': String(p.amount),
      'External ID': p.externalId,
    })),
  );

  info(`\n${BOLD}Mapping Configuration:${RESET}`);
  info(`  Account mappings:    ${getAllAccountMappings().length}`);
  info(`  Tax code mappings:   ${getAllTaxCodeMappings().length}`);
  info(`  Bank accounts:       ${getAllBankAccountConfigs().length}`);
  info(`  Subsidiaries:        ${getAllSubsidiaryConfigs().length}`);

  stepEnd();

  // ── Cleanup ────────────────────────────────────────────────────

  closeDatabase();
  if (fs.existsSync(demoDbPath)) fs.unlinkSync(demoDbPath);

  banner('Demo Complete!');
  console.log(`  ${GREEN}${BOLD}All integration steps executed successfully.${RESET}\n`);
  console.log(`  ${DIM}In production, this same flow runs automatically via:${RESET}`);
  console.log(`    ${CYAN}•${RESET} Azure Function: scheduled sync every 15 minutes`);
  console.log(`    ${CYAN}•${RESET} Pull-based only — no incoming traffic, no open endpoints`);
  console.log(`    ${CYAN}•${RESET} NetSuite Suitelet dashboard for mapping configuration\n`);
}

// ─── Run ───────────────────────────────────────────────────────────

runDemo().catch((err) => {
  console.error(`\n${RED}Demo failed:${RESET}`, err);
  closeDatabase();
  const demoDb = path.join(__dirname, 'demo-sync.db');
  if (fs.existsSync(demoDb)) fs.unlinkSync(demoDb);
  process.exit(1);
});
