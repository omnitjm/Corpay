#!/usr/bin/env npx ts-node
/**
 * CorpayOne → NetSuite Integration Demo - Web UI
 *
 * Run: npx ts-node demo/web-server.ts
 * Then open: http://localhost:3000
 */

import path from 'path';
import fs from 'fs';

// ─── Env vars (same as run-demo.ts) ─────────────────────────────────
process.env.CORPAYONE_CLIENT_ID      = 'demo-client-id';
process.env.CORPAYONE_CLIENT_SECRET  = 'demo-client-secret';
process.env.NETSUITE_ACCOUNT_ID      = 'DEMO123';
process.env.NETSUITE_CONSUMER_KEY    = 'demo-consumer-key';
process.env.NETSUITE_CONSUMER_SECRET = 'demo-consumer-secret';
process.env.NETSUITE_TOKEN_KEY       = 'demo-token-key';
process.env.NETSUITE_TOKEN_SECRET    = 'demo-token-secret';
process.env.NETSUITE_AP_ACCOUNT_ID   = '400';
process.env.NETSUITE_BANK_ACCOUNT_ID = '152';
process.env.NETSUITE_SUBSIDIARY_ID   = '1';
process.env.LOG_LEVEL                = 'warn';

const demoDbPath = path.join(__dirname, 'demo-web.db');
process.env.DATABASE_PATH = demoDbPath;

import express, { Request, Response } from 'express';
import {
  expenses,
  payments,
  netsuiteAccounts,
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
} from '../src/mapping/invoice-mapper';

// ─── Server setup ────────────────────────────────────────────────────

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── SSE demo endpoint ───────────────────────────────────────────────

app.get('/api/demo/run', async (req: Request, res: Response) => {
  // Clean up any leftover DB from a previous run
  if (fs.existsSync(demoDbPath)) fs.unlinkSync(demoDbPath);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  const emit = (type: string, payload: Record<string, unknown> = {}) => {
    res.write(`data: ${JSON.stringify({ type, ...payload })}\n\n`);
  };

  // ── In-memory mock NetSuite state ────────────────────────────────
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
    const total = bill.expense?.items.reduce((s, i) => s + i.amount, 0) ?? 0;
    const lines = bill.expense?.items.length ?? 0;
    nsBills[id] = { id, entity: bill.entity.id, externalId: bill.externalId ?? '', tranId: bill.tranId ?? '', total, lines };
    return id;
  }

  function mockCreatePayment(payment: ReturnType<typeof mapPaymentToVendorPayment>): string {
    const id = String(nextNsId++);
    const apply = payment.apply?.items[0];
    nsPayments[id] = { id, entity: payment.entity.id, externalId: payment.externalId ?? '', appliedTo: apply ? String(apply.doc) : '', amount: apply?.amount ?? 0 };
    return id;
  }

  try {
    getDatabase();

    // ── Step 1: Configure mapping ────────────────────────────────
    emit('step', { step: 1, title: 'Configure Mapping in NetSuite' });
    await sleep(400);

    upsertSubsidiaryConfig({ netsuite_subsidiary_id: '1', netsuite_subsidiary_name: 'Corpay Denmark ApS', is_default: true });
    emit('success', { text: 'Subsidiary: Corpay Denmark ApS (NS ID: 1) → Default' });
    await sleep(150);

    emit('info', { text: 'Mapping CorpayOne categories → NetSuite GL accounts' });
    const accountMaps = [
      { corpayone_category: 'IT Equipment',     corpayone_account_code: '5010', netsuite_account_id: '201', netsuite_account_name: 'IT Equipment' },
      { corpayone_category: 'Office Supplies',  corpayone_account_code: '5020', netsuite_account_id: '202', netsuite_account_name: 'Office Supplies' },
      { corpayone_category: 'Office Furniture', corpayone_account_code: '5030', netsuite_account_id: '203', netsuite_account_name: 'Office Furniture' },
      { corpayone_category: 'Cloud Services',   corpayone_account_code: '6100', netsuite_account_id: '301', netsuite_account_name: 'Cloud & Hosting Services' },
      { corpayone_category: 'Default',          netsuite_account_id: '400',     netsuite_account_name: 'Accounts Payable', is_default: true },
    ];
    for (const m of accountMaps) {
      upsertAccountMapping(m);
      emit('success', { text: `"${m.corpayone_category}" → NS: ${m.netsuite_account_name} (${m.netsuite_account_id})${(m as Record<string,unknown>).is_default ? ' [DEFAULT]' : ''}` });
      await sleep(120);
    }

    emit('info', { text: 'Configuring tax code mappings' });
    const taxMaps = [
      { corpayone_vat_rate: 25, corpayone_label: 'DK Moms 25%',        netsuite_tax_code_id: 'DK-S-25', netsuite_tax_code_name: 'DK Moms 25%',        country_code: 'DK' },
      { corpayone_vat_rate: 19, corpayone_label: 'DE Umsatzsteuer 19%', netsuite_tax_code_id: 'DE-S-19', netsuite_tax_code_name: 'DE Umsatzsteuer 19%', country_code: 'DE' },
      { corpayone_vat_rate: 20, corpayone_label: 'GB VAT 20%',          netsuite_tax_code_id: 'GB-S-20', netsuite_tax_code_name: 'GB VAT 20%',          country_code: 'GB' },
    ];
    for (const t of taxMaps) {
      upsertTaxCodeMapping(t);
      emit('success', { text: `${t.corpayone_vat_rate}% (${t.corpayone_label}) → NS: ${t.netsuite_tax_code_name}` });
      await sleep(120);
    }

    emit('info', { text: 'Configuring bank accounts for payments' });
    const bankMaps = [
      { netsuite_bank_account_id: '152', netsuite_bank_account_name: 'CorpayOne Bank (DKK)', currency: 'DKK', is_default: true },
      { netsuite_bank_account_id: '153', netsuite_bank_account_name: 'CorpayOne Bank (EUR)', currency: 'EUR' },
      { netsuite_bank_account_id: '154', netsuite_bank_account_name: 'CorpayOne Bank (GBP)', currency: 'GBP' },
    ];
    for (const b of bankMaps) {
      upsertBankAccountConfig(b);
      emit('success', { text: `${b.currency} → NS: ${b.netsuite_bank_account_name} (${b.netsuite_bank_account_id})${b.is_default ? ' [DEFAULT]' : ''}` });
      await sleep(120);
    }

    emit('step_done', { step: 1 });
    await sleep(400);

    // ── Step 2: Fetch expenses ───────────────────────────────────
    emit('step', { step: 2, title: 'Fetch Expenses from CorpayOne (v3 API, read-only)' });
    emit('info', { text: 'GET /external/v3/expenses — CorpayOne is read-only, never written to' });
    await sleep(500);

    emit('table', {
      label: 'CorpayOne Expenses',
      headers: ['ID', 'Reference', 'Vendor', 'State', 'Amount', 'Lines'],
      rows: expenses.map((exp) => [
        exp.id,
        exp.reference ?? '-',
        exp.vendor?.name ?? '-',
        exp.state,
        `${exp.amount} ${exp.currency}`,
        String(exp.lines.length),
      ]),
      stateCol: 3,
    });
    emit('info', { text: `Fetched ${expenses.length} expenses from CorpayOne` });
    emit('step_done', { step: 2 });
    await sleep(400);

    // ── Step 3: Sync vendors ─────────────────────────────────────
    emit('step', { step: 3, title: 'Sync Vendors to NetSuite' });
    emit('info', { text: 'For each syncable expense, ensure the vendor exists in NetSuite' });
    await sleep(300);

    const vendorMap: Record<string, string> = {};
    const seenVendors = new Set<string>();

    for (const exp of expenses) {
      if (!isSyncableStatus(exp.state) || !exp.vendor) continue;
      if (seenVendors.has(exp.vendor.id)) continue;
      seenVendors.add(exp.vendor.id);
      await sleep(250);
      const nsVendorId = mockCreateVendor(exp.vendor.name, `corpay-vendor-${exp.vendor.id}`);
      vendorMap[exp.vendor.id] = nsVendorId;
      emit('success', { text: `Created vendor "${exp.vendor.name}" → NS Internal ID: ${nsVendorId}` });
    }

    emit('step_done', { step: 3 });
    await sleep(400);

    // ── Step 4: Sync vendor bills ────────────────────────────────
    emit('step', { step: 4, title: 'Sync Vendor Bills to NetSuite' });
    emit('info', { text: 'Map each approved expense to a NetSuite Vendor Bill' });
    await sleep(300);

    const billMap: Record<string, string> = {};
    let synced = 0, skipped = 0;

    for (const exp of expenses) {
      await sleep(300);
      if (!isSyncableStatus(exp.state)) {
        emit('skip', { text: `${exp.id} (${exp.reference ?? 'no ref'}) — state "${exp.state}" → Skipped` });
        skipped++;
        continue;
      }
      if (!exp.vendor) {
        emit('warn', { text: `${exp.id} — no vendor → Skipped` });
        skipped++;
        continue;
      }
      const nsVendorId = vendorMap[exp.vendor.id];
      const bill = mapExpenseToVendorBill(exp, nsVendorId);
      const nsBillId = mockCreateBill(bill);
      billMap[exp.id] = nsBillId;
      synced++;
      emit('success', { text: `${exp.id} (${exp.reference}) → NS Vendor Bill #${nsBillId}` });
      if (bill.expense?.items) {
        for (const line of bill.expense.items) {
          const acctName = (netsuiteAccounts as Record<string, { name: string }>)[line.account.id]?.name ?? line.account.id;
          emit('info', { text: `  ↳ Account: ${acctName} (${line.account.id}) | Amount: ${line.amount} | Memo: ${line.memo ?? '-'}` });
        }
        const subName = bill.subsidiary
          ? (netsuiteSubsidiaries[bill.subsidiary.id as keyof typeof netsuiteSubsidiaries]?.name ?? bill.subsidiary.id)
          : null;
        if (subName) emit('info', { text: `  ↳ Subsidiary: ${subName}` });
      }
    }

    emit('info', { text: `Bills synced: ${synced} | Skipped: ${skipped}` });
    emit('step_done', { step: 4 });
    await sleep(400);

    // ── Step 5: Sync payments ────────────────────────────────────
    emit('step', { step: 5, title: 'Sync Payments to NetSuite' });
    emit('info', { text: 'Map each completed payment to a NetSuite Vendor Payment' });
    await sleep(300);

    let paymentsSynced = 0, paymentsSkipped = 0;

    for (const pay of payments) {
      await sleep(300);
      if (!isSyncablePayment(pay)) {
        emit('skip', { text: `${pay.id} — status "${pay.status}" → Skipped (only completed payments sync)` });
        paymentsSkipped++;
        continue;
      }
      const exp = expenses.find((e) => e.id === pay.expense_id);
      if (!exp || !exp.vendor) {
        emit('warn', { text: `${pay.id} — expense not found or no vendor → Skipped` });
        paymentsSkipped++;
        continue;
      }
      const nsVendorId = vendorMap[exp.vendor.id];
      const nsBillId = billMap[pay.expense_id];
      if (!nsBillId) {
        emit('warn', { text: `${pay.id} — bill not synced for expense ${pay.expense_id} → Pending` });
        paymentsSkipped++;
        continue;
      }
      const vendorPayment = mapPaymentToVendorPayment(pay, exp, nsVendorId, nsBillId);
      const nsPaymentId = mockCreatePayment(vendorPayment);
      paymentsSynced++;
      emit('success', { text: `${pay.id} → NS Vendor Payment #${nsPaymentId}` });
      emit('info', { text: `  ↳ Applied to Bill #${nsBillId} | Amount: ${pay.amount} ${pay.currency}` });
      if (vendorPayment.account) {
        const bankName = (netsuiteAccounts as Record<string, { name: string }>)[vendorPayment.account.id]?.name ?? vendorPayment.account.id;
        emit('info', { text: `  ↳ Bank Account: ${bankName} (${vendorPayment.account.id})` });
      }
    }

    emit('info', { text: `Payments synced: ${paymentsSynced} | Skipped: ${paymentsSkipped}` });
    emit('step_done', { step: 5 });
    await sleep(400);

    // ── Step 6: Final status ─────────────────────────────────────
    emit('step', { step: 6, title: 'Final Sync Status' });
    await sleep(300);

    emit('table', {
      label: 'NetSuite Vendors',
      headers: ['NS ID', 'Company Name', 'External ID'],
      rows: Object.values(nsVendors).map((v) => [v.id, v.companyName, v.externalId]),
    });
    await sleep(200);

    emit('table', {
      label: 'NetSuite Vendor Bills',
      headers: ['NS ID', 'Vendor ID', 'Tran ID', 'Total', 'Lines', 'External ID'],
      rows: Object.values(nsBills).map((b) => [b.id, b.entity, b.tranId, String(b.total), String(b.lines), b.externalId]),
    });
    await sleep(200);

    emit('table', {
      label: 'NetSuite Vendor Payments',
      headers: ['NS ID', 'Vendor ID', 'Applied To Bill', 'Amount', 'External ID'],
      rows: Object.values(nsPayments).map((p) => [p.id, p.entity, p.appliedTo, String(p.amount), p.externalId]),
    });

    emit('summary', {
      accountMappings: getAllAccountMappings().length,
      taxCodeMappings: getAllTaxCodeMappings().length,
      bankAccounts: getAllBankAccountConfigs().length,
      subsidiaries: getAllSubsidiaryConfigs().length,
      vendorsSynced: Object.keys(nsVendors).length,
      billsSynced: Object.keys(nsBills).length,
      paymentsSynced: Object.keys(nsPayments).length,
    });

    emit('step_done', { step: 6 });
    emit('done', {});

  } catch (err) {
    emit('error', { message: String(err) });
  } finally {
    try { closeDatabase(); } catch (_) { /* ignore */ }
    if (fs.existsSync(demoDbPath)) fs.unlinkSync(demoDbPath);
    res.end();
  }
});

// ─── Start server ────────────────────────────────────────────────────

const PORT = process.env.PORT ? parseInt(process.env.PORT) : 3000;
app.listen(PORT, () => {
  console.log(`\n  CorpayOne → NetSuite Demo UI`);
  console.log(`  ──────────────────────────────`);
  console.log(`  Running at: http://localhost:${PORT}`);
  console.log(`  Open the URL in your browser.\n`);
});
