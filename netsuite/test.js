// Offline tests for corpay_sync_mr.js — no NetSuite, no network. Run: `node netsuite/test.js`.
//
// The SuiteScript file is AMD (`define([...], factory)`), so we load it in a fresh vm context
// with a `define` shim that invokes the factory against mock N/* modules. Each scenario gets its
// own mocks (fresh account state), so the module is re-evaluated per scenario.
// Note: values crossing the vm boundary (Date, plain objects) fail `instanceof` / deepStrictEqual
// across realms, so we assert via duck-typed field reads.

import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SRC = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'corpay_sync_mr.js'), 'utf8');

function loadModule(mocks) {
  const sandbox = { console };
  vm.createContext(sandbox);
  sandbox.define = (deps, factory) => { sandbox.__mr = factory(...deps.map((d) => mocks[d])); };
  vm.runInContext(SRC, sandbox, { filename: 'corpay_sync_mr.js' });
  return sandbox.__mr;
}

// ---- mocks ----------------------------------------------------------------------------------
const logMock = { debug() {}, audit() {}, error() {} };
const runtimeMock = (p, userId = 42) => ({
  getCurrentScript: () => ({ getParameter: ({ name }) => p[name] }),
  getCurrentUser: () => ({ id: userId })
});
const httpsMock = (handler, calls) => ({
  createSecureString: ({ input }) => ({ __secure: true, input }),
  get: ({ url, headers }) => { if (calls) calls.push({ url, headers }); return handler(url, headers); }
});
const searchMock = (existing, seen) => ({
  Type: { TRANSACTION: 'transaction' },
  create: ({ filters }) => {
    const extId = filters[0][2]; // [['externalidstring','is', extId]]
    if (seen) seen.push(extId);
    return { run: () => ({ each: (cb) => { if (existing[extId]) cb({ id: existing[extId] }); } }) };
  }
});
const emailMock = (sent) => ({ send: (opts) => sent.push(opts) });

function makeRec(type, id) {
  return {
    type, id, fields: {}, sublists: { expense: [], apply: [] }, removed: 0, _cur: null,
    setValue({ fieldId, value }) { this.fields[fieldId] = value; },
    getLineCount({ sublistId }) { return this.sublists[sublistId].length; },
    removeLine({ sublistId, line }) { this.sublists[sublistId].splice(line, 1); this.removed++; },
    selectNewLine() { this._cur = {}; },
    selectLine({ sublistId, line }) { this._cur = this.sublists[sublistId][line]; },
    setCurrentSublistValue({ fieldId, value }) { this._cur[fieldId] = value; },
    commitLine({ sublistId }) {
      if (this.sublists[sublistId].indexOf(this._cur) === -1) this.sublists[sublistId].push(this._cur);
      this._cur = null;
    },
    getSublistValue({ sublistId, fieldId, line }) { return this.sublists[sublistId][line][fieldId]; },
    save() { return this.id; }
  };
}
function recordMock(state) {
  return {
    Type: { VENDOR_BILL: 'vendorbill', VENDOR_CREDIT: 'vendorcredit', VENDOR_PAYMENT: 'vendorpayment' },
    create: ({ type }) => {
      const r = makeRec(type, type === 'vendorbill' ? 'BILL-NEW' : type === 'vendorcredit' ? 'CREDIT-NEW' : 'PAY-NEW');
      state.created.push(r); return r;
    },
    load: ({ type, id }) => {
      const r = makeRec(type, id);
      // two pre-existing lines so the update path can prove it removes them before re-adding
      r.sublists.expense.push({ account: '111', grossamt: 9.99 }, { account: '222', grossamt: 8.88 });
      state.loaded.push(r); return r;
    },
    transform: ({ fromId, toType }) => {
      const r = makeRec(toType, 'PAY-NEW'); r.fromId = fromId;
      // NetSuite pre-populates apply from the source bill, unchecked here so the script must force it
      r.sublists.apply.push({ doc: fromId, apply: false, amount: 0, total: 1250, due: 1250 });
      state.transformed.push(r); return r;
    }
  };
}

// ---- canned Corpay v3 details --------------------------------------------------------------
const LONG_REF = 'INV-0001-THIS-IS-A-VERY-LONG-REFERENCE-NUMBER-THAT-EXCEEDS-45-CHARACTERS';
const DETAILS = {
  'bill-1': { id: 'bill-1', reference: LONG_REF, number: 5001, amount: 125000, currency: 'DKK',
    state: 'Paid', friendlyStatus: 'Paid', referenceDate: '2026-06-01T00:00:00Z',
    dueDate: '2026-07-01T00:00:00Z', paymentDate: '2026-06-15T10:30:00Z',
    vendor: { name: 'APCOA', externalId: '742' }, category: { externalId: '235' },
    lines: [{ amount: 100000, note: 'Line one', category: { externalId: '235' } },
      { amount: 25000, note: 'Line two', category: { externalId: 'not-a-number' } },
      { amount: 0, note: 'Zero informational line', category: { externalId: '235' } }] },
  'bill-mm': { id: 'bill-mm', reference: null, number: 0, amount: 10000, currency: 'DKK',
    state: 'Booked', referenceDate: '2026-06-05T00:00:00Z',
    vendor: { name: 'Mismatch Vendor', externalId: '742' }, category: { externalId: '235' },
    lines: [{ amount: 8000, note: 'Only part of the total', category: { externalId: '235' } }] },
  'bill-noext': { id: 'bill-noext', reference: 'INV-X', amount: 5000, currency: 'DKK',
    state: 'Booked', referenceDate: '2026-06-02T00:00:00Z',
    vendor: { name: 'No ExternalId', externalId: null }, lines: [] },
  'bill-upd': { id: 'bill-upd', reference: 'INV-UPD', amount: 40000, currency: 'DKK',
    state: 'Booked', referenceDate: '2026-06-04T00:00:00Z',
    vendor: { name: 'Some Vendor', externalId: '746' }, category: { externalId: '235' }, lines: [] },
  'credit-1': { id: 'credit-1', reference: 'CN-0001', amount: 30000, currency: 'EUR',
    state: 'Booked', referenceDate: '2026-06-03T00:00:00Z',
    vendor: { name: '3pX', externalId: '715' }, category: { externalId: '236' }, lines: [] }
};
const jsonRes = (obj, code = 200) => ({ code, body: JSON.stringify(obj) });
const detailHandler = (url) => {
  const m = /\/v3\/expenses\/([^/?]+)/.exec(url);
  if (m) return jsonRes({ data: DETAILS[m[1]] });
  throw new Error('unexpected corpay url ' + url);
};

const P = {
  custscript_cp_base_url: 'https://api.corpayone.com/external',
  custscript_cp_token_secret: 'custsecret_corpay', custscript_cp_token_plain: '',
  custscript_cp_team_id: 'team-1', custscript_cp_states: 'Booked,Paid',
  custscript_cp_lookback_days: '90', custscript_cp_subsidiary: '10',
  custscript_cp_ap_account: '114', custscript_cp_bank_account: '340',
  custscript_cp_bank_account_eur: '341', custscript_cp_default_expense_acct: '999',
  custscript_cp_default_taxcode: '18', custscript_cp_notify_email: 'ops@example.com'
};

// Build a module + shared state for a map scenario.
function harness({ existing = {}, params = P } = {}) {
  const state = { created: [], loaded: [], transformed: [] };
  const searches = [];
  const mr = loadModule({
    'N/https': httpsMock(detailHandler), 'N/record': recordMock(state),
    'N/search': searchMock(existing, searches), 'N/runtime': runtimeMock(params),
    'N/log': logMock, 'N/email': emailMock([])
  });
  const outputs = [];
  return { state, searches, outVals: () => outputs.map((o) => o.value),
    run: (id, kind, extra) => mr.map({
      value: JSON.stringify({ id, kind, ...extra }), write: (kv) => outputs.push(kv) }) };
}

function main() {
  // ============================================ getInputData: paging + lookback + dedupe
  {
    const RECENT = new Date().toISOString();
    const OLD = new Date(Date.now() - 400 * 86400000).toISOString();
    const pages = [];
    const handler = (url) => {
      const u = new URL(url), type = u.searchParams.get('Type'), off = Number(u.searchParams.get('Offset'));
      const state = u.searchParams.get('State');
      pages.push(type + '@' + off);
      if (state === 'Cancelled') return jsonRes({ total: 1, data: { bills: [
        { id: 'b-cancelled', referenceDate: RECENT }] } }); // reversal candidate
      if (state !== 'Booked') return jsonRes({ total: 0, data: { bills: [] } });
      if (type === 'Bill' && off === 0) return jsonRes({ total: 3, data: { bills: [
        { id: 'b-recent', paymentDate: RECENT }, { id: 'b-old', referenceDate: OLD }] } });
      if (type === 'Bill' && off === 2) return jsonRes({ total: 3, data: { bills: [
        { id: 'b-recent', paymentDate: RECENT }] } }); // duplicate across pages -> deduped
      if (type === 'Creditnote' && off === 0) return jsonRes({ total: 1, data: { bills: [
        { id: 'c-recent', referenceDate: RECENT }] } });
      return jsonRes({ total: 0, data: { bills: [] } });
    };
    const mr = loadModule({
      'N/https': httpsMock(handler), 'N/record': recordMock({ created: [], loaded: [], transformed: [] }),
      'N/search': searchMock({}),
      'N/runtime': runtimeMock({ ...P, custscript_cp_states: 'Booked', custscript_cp_lookback_days: '30' }),
      'N/log': logMock, 'N/email': emailMock([])
    });
    const input = mr.getInputData();
    const ids = input.map((x) => x.id);
    assert.ok(ids.includes('b-recent') && !ids.includes('b-old'), 'lookback filters old before detail fetch');
    assert.equal(ids.filter((x) => x === 'b-recent').length, 1, 'duplicate id deduped');
    assert.equal(input.find((x) => x.id === 'b-recent').kind, 'bill');
    assert.equal(input.find((x) => x.id === 'c-recent').kind, 'credit');
    assert.ok(pages.includes('Bill@2'), 'paged to offset 2 while total not reached');
    // Cancelled/Refunded are listed separately and flagged as reversal candidates.
    const reversals = input.filter((x) => x.reversal);
    assert.equal(reversals.length, 2, 'cancelled id listed once per kind as reversal candidate');
    assert.ok(reversals.every((x) => x.id === 'b-cancelled'));
    assert.equal(input.length, 4);
    console.log('ok  getInputData: paging + lookback + dedupe + reversal candidates');
  }

  // ============================================ (a) paid bill happy path + transform payment
  {
    const h = harness(); // nothing exists -> create bill, then transform payment
    h.run('bill-1', 'bill');
    const bill = h.state.created[0];
    assert.equal(h.state.created.length, 1);
    assert.equal(bill.type, 'vendorbill');
    assert.equal(bill.fields.externalid, 'corpay-bill-bill-1');
    assert.equal(bill.fields.entity, '742', 'entity = vendor internal id from externalId');
    assert.equal(bill.fields.subsidiary, '10');
    assert.equal(bill.fields.approvalstatus, 2, 'bill carries approvalStatus Approved');
    assert.equal(bill.fields.tranid.length, 45, 'tranId truncated to 45');
    assert.equal(bill.fields.trandate.getFullYear(), 2026, 'trandate parsed from referenceDate');
    assert.equal(bill.sublists.expense.length, 2);
    assert.equal(bill.sublists.expense[0].account, '235');
    assert.equal(bill.sublists.expense[0].grossamt, 1000, 'posted as grossamt (VAT-inclusive)');
    assert.equal(bill.sublists.expense[0].taxcode, '18', 'every line gets default tax code');
    assert.equal(bill.sublists.expense[0].memo, 'Line one');
    assert.equal(bill.sublists.expense[1].account, '999', 'non-numeric category -> default account');
    assert.equal(bill.sublists.expense[0].grossamt + bill.sublists.expense[1].grossamt, 1250,
      'gross lines sum to the Corpay payable total');
    const pay = h.state.transformed[0];
    assert.equal(h.state.transformed.length, 1, 'payment created via transform');
    assert.equal(pay.fromId, 'BILL-NEW', 'transform used the just-saved bill internal id');
    assert.equal(pay.fields.externalid, 'corpay-pay-bill-1');
    assert.equal(pay.fields.account, '340', 'DKK payment uses default bank account');
    assert.equal(pay.fields.trandate.getMonth(), 5, 'payment dated from paymentDate (June)');
    assert.equal(pay.sublists.apply[0].apply, true, 'apply line forced checked');
    assert.equal(pay.sublists.apply[0].amount, 1250, 'apply line forced to full amount');
    assert.deepEqual(h.outVals().sort(), ['bills', 'payments']);
    console.log('ok  (a) paid bill happy path incl. transform payment');
  }

  // ============================================ (b) credit note
  {
    const h = harness();
    h.run('credit-1', 'credit');
    const c = h.state.created[0];
    assert.equal(c.type, 'vendorcredit');
    assert.equal(c.fields.externalid, 'corpay-credit-credit-1');
    assert.equal(c.fields.entity, '715');
    assert.equal(c.fields.approvalstatus, undefined, 'vendorCredit has NO approvalStatus field');
    assert.equal(c.sublists.expense.length, 1, 'no lines -> single header-category line');
    assert.equal(c.sublists.expense[0].account, '236');
    assert.equal(c.sublists.expense[0].grossamt, 300);
    assert.equal(h.state.transformed.length, 0, 'no payment for a credit');
    assert.deepEqual(h.outVals(), ['credits']);
    console.log('ok  (b) credit note');
  }

  // ============================================ (c) missing vendor externalId skip
  {
    const h = harness();
    h.run('bill-noext', 'bill');
    assert.equal(h.state.created.length, 0);
    assert.equal(h.searches.length, 0, 'skipped before any NetSuite search');
    assert.deepEqual(h.outVals(), ['skipped']);
    console.log('ok  (c) missing vendor externalId -> skip');
  }

  // ============================================ (d) settled skip (payment exists -> no bill touch)
  {
    const h = harness({ existing: { 'corpay-pay-bill-1': '3001' } });
    h.run('bill-1', 'bill');
    assert.equal(h.state.created.length + h.state.loaded.length, 0, 'settled bill never touched');
    assert.equal(h.state.transformed.length, 0, 'no new payment when one exists');
    assert.deepEqual(h.searches, ['corpay-pay-bill-1'], 'payment-existence check happens first, then short-circuits');
    assert.deepEqual(h.outVals(), ['settled']);
    console.log('ok  (d) settled skip: payment exists -> no bill touch');
  }

  // ============================================ (e) update path removes lines before re-adding
  {
    const h = harness({ existing: { 'corpay-bill-bill-upd': '1500' } });
    h.run('bill-upd', 'bill');
    const bill = h.state.loaded[0];
    assert.equal(h.state.created.length, 0, 'existing bill updated, not created');
    assert.equal(bill.id, '1500');
    assert.equal(bill.removed, 2, 'both pre-existing lines removed before re-adding');
    assert.equal(bill.sublists.expense.length, 1, 'exactly the re-mapped line remains (no merge/dup)');
    assert.equal(bill.sublists.expense[0].grossamt, 400);
    assert.deepEqual(h.outVals(), ['bills']);
    console.log('ok  (e) update path removes existing lines before re-adding');
  }

  // ============================================ (f) mismatched splits -> header-total fallback
  {
    const h = harness();
    h.run('bill-mm', 'bill');
    const bill = h.state.created[0];
    assert.equal(bill.sublists.expense.length, 1, 'mismatched splits collapse to one header line');
    assert.equal(bill.sublists.expense[0].grossamt, 100.0, 'header line carries the full payable');
    assert.equal(bill.fields.tranid, 'bill-mm', 'blank reference/number -> tranid falls back to id');
    assert.deepEqual(h.outVals(), ['bills']);
    console.log('ok  (f) mismatched splits fall back to header-total line; tranid never blank');
  }

  // ============================================ (g) reversal candidate -> warning, no writes
  {
    const h = harness({ existing: { 'corpay-bill-bill-1': '555' } });
    h.run('bill-1', 'bill', { reversal: true });
    assert.equal(h.state.created.length + h.state.loaded.length + h.state.transformed.length, 0,
      'reversal check performs no record writes');
    assert.deepEqual(h.searches, ['corpay-bill-bill-1'], 'only the existence lookup runs');
    assert.deepEqual(h.outVals(), ['warnings'], 'existing NetSuite record -> warning outcome');
    // Same candidate but nothing in NetSuite -> silent no-op.
    const h2 = harness();
    h2.run('bill-1', 'bill', { reversal: true });
    assert.deepEqual(h2.outVals(), [], 'no NetSuite record -> nothing to warn about');
    console.log('ok  (g) cancelled/refunded surfaced as warning, never deleted');
  }

  // ============================================ (h) EUR tax code override
  {
    const h = harness({ params: { ...P, custscript_cp_taxcode_eur: '149' } });
    h.run('credit-1', 'credit'); // credit-1 is EUR
    assert.equal(h.state.created[0].sublists.expense[0].taxcode, '149',
      'EUR expense uses the reverse-charge tax code override');
    console.log('ok  (h) EUR tax code override applied');
  }

  // ============================================ auth: API secret SecureString + plain fallback
  {
    const sc = [];
    loadModule({ 'N/https': httpsMock(detailHandler, sc), 'N/record': recordMock({ created: [], loaded: [], transformed: [] }),
      'N/search': searchMock({}), 'N/runtime': runtimeMock(P), 'N/log': logMock, 'N/email': emailMock([]) })
      .map({ value: JSON.stringify({ id: 'credit-1', kind: 'credit' }), write() {} });
    assert.equal(sc[0].headers.Authorization.__secure, true, 'API secret -> SecureString header');
    assert.equal(sc[0].headers.Authorization.input, 'Bearer {custsecret_corpay}', 'secret by placeholder, never inlined');

    const pc = [];
    loadModule({ 'N/https': httpsMock(detailHandler, pc), 'N/record': recordMock({ created: [], loaded: [], transformed: [] }),
      'N/search': searchMock({}),
      'N/runtime': runtimeMock({ ...P, custscript_cp_token_secret: '', custscript_cp_token_plain: 'raw-jwt' }),
      'N/log': logMock, 'N/email': emailMock([]) })
      .map({ value: JSON.stringify({ id: 'credit-1', kind: 'credit' }), write() {} });
    assert.equal(pc[0].headers.Authorization, 'Bearer raw-jwt', 'plain-text token fallback header');
    console.log('ok  auth: API secret SecureString + plain-text fallback');
  }

  // ============================================ summarize: tally + conditional error email
  {
    const iter = (pairs) => ({ iterator: () => ({ each: (cb) => pairs.forEach(([k, v]) => cb(k, v)) }) });
    const sent = [];
    loadModule({ 'N/https': httpsMock(detailHandler), 'N/record': recordMock({ created: [], loaded: [], transformed: [] }),
      'N/search': searchMock({}), 'N/runtime': runtimeMock(P), 'N/log': logMock, 'N/email': emailMock(sent) })
      .summarize({
        output: iter([['bills:1', 'bills'], ['payments:1', 'payments'], ['skipped:4', 'skipped'], ['errors:5', 'errors']]),
        mapSummary: { errors: iter([['errors:6', 'boom uncaught']]) }
      });
    assert.equal(sent.length, 1, 'one summary email when errors > 0 and notify email set');
    assert.equal(sent[0].recipients, 'ops@example.com');
    assert.equal(sent[0].author, 42, 'author = execute-as user id');
    assert.ok(/errors=2/.test(sent[0].body), 'caught (1) + uncaught (1) errors both counted');

    const sent2 = [];
    loadModule({ 'N/https': httpsMock(detailHandler), 'N/record': recordMock({ created: [], loaded: [], transformed: [] }),
      'N/search': searchMock({}), 'N/runtime': runtimeMock(P), 'N/log': logMock, 'N/email': emailMock(sent2) })
      .summarize({ output: iter([['bills:1', 'bills']]), mapSummary: { errors: iter([]) } });
    assert.equal(sent2.length, 0, 'no email when there are no errors');
    console.log('ok  summarize: tally + conditional error email');
  }

  console.log('\nAll tests passed.');
}

main();
