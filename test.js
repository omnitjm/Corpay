// Zero-framework tests using node:assert. Run: `npm test` (node test.js).
// A stub fetch returns canned Corpay responses and records NetSuite requests.

import assert from 'node:assert/strict';
import { loadConfig, runSync } from './sync.js';

// ---- canned Corpay full-detail expenses ----
const LONG_REF = 'INV-0001-THIS-IS-A-VERY-LONG-REFERENCE-NUMBER-THAT-EXCEEDS-45-CHARACTERS';
const EXPENSES = {
  'bill-1': {
    id: 'bill-1', type: 'Bill', reference: LONG_REF, number: 5001,
    amount: 125000, currency: 'DKK', state: 'Paid', friendlyStatus: 'Paid',
    referenceDate: '2026-06-01T00:00:00Z', dueDate: '2026-07-01T00:00:00Z',
    paymentDate: '2026-06-15T10:30:00Z',
    vendor: { id: 'v1', name: 'APCOA DANMARK A/S', externalId: '742' },
    category: { externalId: '235' },
    lines: [
      { amount: 100000, note: 'Line one', category: { externalId: '235' } },
      { amount: 25000, note: 'Line two', category: { externalId: 'not-a-number' } },
    ],
  },
  'bill-2': {
    id: 'bill-2', type: 'Bill', reference: 'INV-0002', number: 5002,
    amount: 5000, currency: 'DKK', state: 'Booked', friendlyStatus: 'Booked',
    referenceDate: '2026-06-02T00:00:00Z',
    vendor: { id: 'v2', name: 'Vendor Without ExternalId', externalId: null },
    lines: [],
  },
  'credit-1': {
    id: 'credit-1', type: 'Creditnote', reference: 'CN-0001', number: 6001,
    amount: 30000, currency: 'EUR', state: 'Booked', friendlyStatus: 'Booked',
    referenceDate: '2026-06-03T00:00:00Z',
    vendor: { id: 'v3', name: '3pX Recruitment Limited', externalId: '715' },
    category: { externalId: '236' }, lines: [],
  },
};

const json = (obj, status = 200) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
const noContent = (location) =>
  new Response(null, { status: 204, headers: { Location: location } });

// paymentExists=false -> vendorPayment GET returns 404 (create); true -> 200 (skip).
function makeStub(records, { paymentExists = false } = {}) {
  return async function stubFetch(url, opts = {}) {
    const method = (opts.method || 'GET').toUpperCase();
    const u = new URL(url);
    const path = u.pathname;

    // ---- Corpay ----
    if (u.hostname.includes('corpayone.com')) {
      if (path.endsWith('/connect/token')) return json({ access_token: 'test-token' });
      if (path.endsWith('/v2/expenses')) {
        const type = u.searchParams.get('Type');
        const bills = type === 'Creditnote'
          ? [{ id: 'credit-1' }]
          : [{ id: 'bill-1' }, { id: 'bill-2' }];
        return json({ total: bills.length, offset: 0, count: bills.length, data: { bills } });
      }
      const m = /\/v3\/expenses\/(.+)$/.exec(path);
      if (m) return json({ data: EXPENSES[m[1]] });
      throw new Error(`unexpected corpay path ${path}`);
    }

    // ---- NetSuite ----
    if (u.hostname.includes('suitetalk.api.netsuite.com')) {
      records.push({ method, path, query: u.search, body: opts.body ? JSON.parse(opts.body) : null,
        auth: opts.headers?.Authorization });
      if (method === 'GET' && path.includes('/vendorPayment/eid:')) {
        return paymentExists ? json({ id: '3001' }) : json({}, 404);
      }
      if (method === 'GET' && path.includes('/vendorBill/eid:')) return json({ id: '1001' });
      if (method === 'PUT' && path.includes('/vendorBill/eid:')) {
        return noContent('/services/rest/record/v1/vendorBill/1001');
      }
      if (method === 'PUT' && path.includes('/vendorCredit/eid:')) {
        return noContent('/services/rest/record/v1/vendorCredit/2001');
      }
      if (method === 'POST' && path.endsWith('/vendorPayment')) {
        return noContent('/services/rest/record/v1/vendorPayment/3001');
      }
      throw new Error(`unexpected netsuite ${method} ${path}`);
    }
    throw new Error(`unexpected host ${u.hostname}`);
  };
}

const baseEnv = {
  CORPAY_TOKEN: 'test-token',
  CORPAY_TEAM_ID: 'team-1',
  CORPAY_SYNC_STATES: 'Booked,Paid',
  NS_ACCOUNT_ID: '1234567_SB1',
  NS_CONSUMER_KEY: 'ck', NS_CONSUMER_SECRET: 'cs', NS_TOKEN_ID: 'ti', NS_TOKEN_SECRET: 'ts',
  NS_SUBSIDIARY_ID: '10', NS_AP_ACCOUNT_ID: '114', NS_BANK_ACCOUNT_ID: '340',
  NS_BANK_ACCOUNT_ID_EUR: '341',
  NS_DEFAULT_EXPENSE_ACCOUNT_ID: '999', NS_DEFAULT_TAX_CODE_ID: '18',
};

const find = (records, method, needle) =>
  records.find((r) => r.method === method && r.path.includes(needle));

async function main() {
  // ---------- config validation fails fast ----------
  assert.throws(() => loadConfig({ CORPAY_TOKEN: 'x' }), /Missing required environment variables/);
  const cfg = loadConfig(baseEnv);
  assert.equal(cfg.ns.bankAccountByCurrency.EUR, '341');
  assert.deepEqual(cfg.corpay.syncStates, ['Booked', 'Paid']);

  // ---------- main pass: payment does NOT yet exist ----------
  const records = [];
  const stats = await runSync(loadConfig(baseEnv), makeStub(records));

  assert.deepEqual(
    { bills: stats.bills, credits: stats.credits, payments: stats.payments, skipped: stats.skipped, errors: stats.errors },
    { bills: 1, credits: 1, payments: 1, skipped: 1, errors: 0 },
    'expected 1 bill, 1 credit, 1 payment, 1 skip, 0 errors',
  );

  // Bill upsert: correct eid: URL + payload shape.
  const billPut = find(records, 'PUT', '/vendorBill/eid:corpay-bill-bill-1');
  assert.ok(billPut, 'vendor bill upserted via eid: URL');
  assert.ok(billPut.auth.startsWith('OAuth realm="1234567_SB1"'), 'OAuth realm keeps uppercase underscore form');
  assert.equal(billPut.body.entity.id, '742', 'entity = NetSuite vendor internal id from externalId');
  assert.equal(billPut.body.subsidiary.id, '10');
  assert.equal(billPut.body.approvalStatus.id, '2');
  assert.equal(billPut.body.externalId, 'corpay-bill-bill-1');
  assert.equal(billPut.body.tranDate, '2026-06-01');
  assert.equal(billPut.body.dueDate, '2026-07-01');
  assert.equal(billPut.body.currency, undefined, 'currency omitted (defaults from vendor)');
  assert.equal(billPut.body.tranId.length, 45, 'tranId truncated to 45 chars');

  // Lines: 2 items, minor->major 2-decimal amounts, non-numeric category falls back to default.
  const items = billPut.body.expense.items;
  assert.equal(items.length, 2);
  assert.equal(items[0].account.id, '235');
  assert.equal(items[0].amount, 1000.0);
  assert.equal(items[0].memo, 'Line one');
  assert.equal(items[0].taxCode.id, '18', 'every line gets default tax code');
  assert.equal(items[1].account.id, '999', 'non-numeric line category -> default expense account');
  assert.equal(items[1].amount, 250.0);

  // Skip: bill-2 has no numeric vendor externalId -> never written.
  assert.ok(!find(records, 'PUT', 'corpay-bill-bill-2'), 'bill with missing vendor externalId skipped');

  // Credit upsert.
  const creditPut = find(records, 'PUT', '/vendorCredit/eid:corpay-credit-credit-1');
  assert.ok(creditPut, 'vendor credit upserted via eid: URL');
  assert.equal(creditPut.body.entity.id, '715');
  assert.equal(creditPut.body.expense.items[0].account.id, '236', 'header category used when no lines');
  assert.equal(creditPut.body.expense.items[0].amount, 300.0);
  assert.ok(!creditPut.body.apply, 'credit has no apply sublist (stays open)');

  // Payment: idempotency GET, bill-id resolve, then POST with apply doc = internal id.
  assert.ok(find(records, 'GET', '/vendorPayment/eid:corpay-pay-bill-1'), 'checked for existing payment');
  assert.ok(find(records, 'GET', '/vendorBill/eid:corpay-bill-bill-1'), 'resolved bill internal id');
  const payPost = find(records, 'POST', '/vendorPayment');
  assert.ok(payPost, 'payment created');
  assert.equal(payPost.body.externalId, 'corpay-pay-bill-1');
  assert.equal(payPost.body.account.id, '340', 'DKK payment uses default bank account');
  assert.equal(payPost.body.apAcct.id, '114');
  assert.equal(payPost.body.tranDate, '2026-06-15');
  assert.equal(payPost.body.apply.items[0].doc.id, '1001', 'apply doc = bill internal id (not eid, not tranId)');
  assert.equal(payPost.body.apply.items[0].apply, true);
  assert.equal(payPost.body.apply.items[0].amount, 1250.0);

  // ---------- second pass: payment ALREADY exists -> never re-created ----------
  const records2 = [];
  const stats2 = await runSync(loadConfig(baseEnv), makeStub(records2, { paymentExists: true }));
  assert.equal(stats2.payments, 0, 'existing payment is not re-created');
  assert.ok(!find(records2, 'POST', '/vendorPayment'), 'no POST vendorPayment when one already exists');
  assert.ok(find(records2, 'GET', '/vendorPayment/eid:corpay-pay-bill-1'), 'still checks existence');
  // The bill itself is still upserted every run (idempotent).
  assert.ok(find(records2, 'PUT', '/vendorBill/eid:corpay-bill-bill-1'), 'bill still upserted');

  console.log('All tests passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
