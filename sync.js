// Corpay One -> NetSuite one-way sync.
// Pushes Bills, Bill Credits (credit notes) and Bill Payments from Corpay One
// into NetSuite. One-shot: `node sync.js` does one full pass and exits.
// Idempotency comes entirely from NetSuite externalId (eid:) upserts.
// Zero npm dependencies: native fetch + node:crypto for OAuth1 signing.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dedupe = (arr) => [...new Set(arr)];

// -------------------- config --------------------

// Tiny .env parser (KEY=VALUE lines, # comments, optional quotes). Zero deps.
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    out[key] = val;
  }
  return out;
}

// process.env, with a .env file in cwd filling in any missing vars.
function loadEnv() {
  const env = { ...process.env };
  try {
    const parsed = parseEnvFile(readFileSync(join(process.cwd(), '.env'), 'utf8'));
    for (const [k, v] of Object.entries(parsed)) if (env[k] === undefined) env[k] = v;
  } catch { /* no .env file — fine */ }
  return env;
}

export function loadConfig(env = loadEnv()) {
  const missing = [];
  const req = (k) => { if (!env[k]) missing.push(k); return env[k]; };

  const token = env.CORPAY_TOKEN;
  const hasRefresh = env.CORPAY_CLIENT_ID && env.CORPAY_CLIENT_SECRET && env.CORPAY_REFRESH_TOKEN;
  if (!token && !hasRefresh) {
    missing.push('CORPAY_TOKEN (or CORPAY_CLIENT_ID + CORPAY_CLIENT_SECRET + CORPAY_REFRESH_TOKEN)');
  }
  const teamId = req('CORPAY_TEAM_ID');
  const nsKeys = ['NS_ACCOUNT_ID', 'NS_CONSUMER_KEY', 'NS_CONSUMER_SECRET', 'NS_TOKEN_ID',
    'NS_TOKEN_SECRET', 'NS_SUBSIDIARY_ID', 'NS_AP_ACCOUNT_ID', 'NS_BANK_ACCOUNT_ID',
    'NS_DEFAULT_EXPENSE_ACCOUNT_ID', 'NS_DEFAULT_TAX_CODE_ID'];
  const ns = {};
  for (const k of nsKeys) ns[k] = req(k);

  if (missing.length) {
    throw new Error('Missing required environment variables:\n  ' + missing.join('\n  '));
  }

  // Per-currency bank account overrides: NS_BANK_ACCOUNT_ID_<CURRENCY>
  const bankByCurrency = {};
  for (const [k, v] of Object.entries(env)) {
    const m = /^NS_BANK_ACCOUNT_ID_([A-Za-z]{3})$/.exec(k);
    if (m && v) bankByCurrency[m[1].toUpperCase()] = v;
  }

  const syncStates = (env.CORPAY_SYNC_STATES || 'Booked,Initialized,Paid')
    .split(',').map((s) => s.trim()).filter(Boolean);

  return {
    corpay: {
      baseUrl: (env.CORPAY_BASE_URL || 'https://api.corpayone.com/external').replace(/\/$/, ''),
      identityUrl: (env.CORPAY_IDENTITY_URL || 'https://identity.corpayone.com').replace(/\/$/, ''),
      token: token || null,
      clientId: env.CORPAY_CLIENT_ID,
      clientSecret: env.CORPAY_CLIENT_SECRET,
      refreshToken: env.CORPAY_REFRESH_TOKEN,
      teamId,
      syncStates,
    },
    ns: {
      accountId: ns.NS_ACCOUNT_ID,
      consumerKey: ns.NS_CONSUMER_KEY,
      consumerSecret: ns.NS_CONSUMER_SECRET,
      tokenId: ns.NS_TOKEN_ID,
      tokenSecret: ns.NS_TOKEN_SECRET,
      subsidiaryId: ns.NS_SUBSIDIARY_ID,
      apAccountId: ns.NS_AP_ACCOUNT_ID,
      bankAccountId: ns.NS_BANK_ACCOUNT_ID,
      defaultExpenseAccountId: ns.NS_DEFAULT_EXPENSE_ACCOUNT_ID,
      defaultTaxCodeId: ns.NS_DEFAULT_TAX_CODE_ID,
      bankAccountByCurrency: bankByCurrency,
    },
  };
}

// -------------------- helpers --------------------

// Amounts arrive as int64 minor units (e.g. øre/cents) -> major units, 2 decimals.
function money(minor) {
  return Math.round(Number(minor || 0)) / 100;
}

const dateOnly = (dt) => (dt ? String(dt).slice(0, 10) : undefined);

// Returns the digits-only string if val is a positive integer id, else null.
function numericId(val) {
  if (val == null) return null;
  const s = String(val).trim();
  return /^\d+$/.test(s) ? s : null;
}

// -------------------- Corpay client --------------------

async function corpayGetToken(fetchImpl, c) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
  });
  const res = await fetchImpl(`${c.identityUrl}/connect/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) throw new Error(`Corpay token request failed ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (!json.access_token) throw new Error('Corpay token response missing access_token');
  return json.access_token;
}

async function corpayGet(fetchImpl, c, path, query) {
  await sleep(150); // gentle pacing — stay well under Corpay rate limits
  const url = new URL(c.baseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  const res = await fetchImpl(url.toString(), {
    headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`Corpay GET ${path} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// List all expense ids of a given Type across the configured states (paginated).
async function listExpenseIds(fetchImpl, c, type) {
  const ids = [];
  for (const state of c.syncStates) {
    let offset = 0;
    for (;;) {
      const resp = await corpayGet(fetchImpl, c, '/v2/expenses',
        { TeamId: c.teamId, Type: type, State: state, Offset: offset, Count: 100 });
      const bills = resp?.data?.bills || [];
      for (const b of bills) ids.push(b.id);
      const total = Number(resp?.total || 0);
      offset += bills.length;
      if (bills.length === 0 || offset >= total) break;
    }
  }
  return ids;
}

async function getExpense(fetchImpl, c, id) {
  const resp = await corpayGet(fetchImpl, c, `/v3/expenses/${id}`);
  return resp?.data;
}

// -------------------- NetSuite client (OAuth 1.0a TBA) --------------------

// RFC3986 percent-encoding: encodeURIComponent plus the four chars it leaves alone.
function rfc3986(str) {
  return encodeURIComponent(String(str)).replace(/[!'()*]/g, (ch) =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase());
}

// Account id in the host is lowercased with underscores -> hyphens (1234567_SB1 -> 1234567-sb1);
// the OAuth realm keeps the uppercase underscore form.
function nsBase(accountId) {
  const host = accountId.toLowerCase().replace(/_/g, '-');
  return `https://${host}.suitetalk.api.netsuite.com/services/rest`;
}

function nsAuthHeader(cfg, method, url) {
  const u = new URL(url);
  const oauth = {
    oauth_consumer_key: cfg.consumerKey,
    oauth_token: cfg.tokenId,
    oauth_signature_method: 'HMAC-SHA256',
    oauth_timestamp: Math.floor(Date.now() / 1000).toString(),
    oauth_nonce: crypto.randomBytes(16).toString('hex'),
    oauth_version: '1.0',
  };
  // Signature base string (RFC 5849): METHOD & encoded(url-no-query) & encoded(sorted params).
  // Params = oauth params + query params, each key=value pair percent-encoded, sorted by key.
  const params = { ...oauth };
  for (const [k, v] of u.searchParams) params[k] = v;
  const paramString = Object.keys(params).sort()
    .map((k) => `${rfc3986(k)}=${rfc3986(params[k])}`).join('&');
  const baseUrl = u.origin + u.pathname;
  const baseString = [method.toUpperCase(), rfc3986(baseUrl), rfc3986(paramString)].join('&');
  const signingKey = `${rfc3986(cfg.consumerSecret)}&${rfc3986(cfg.tokenSecret)}`;
  const signature = crypto.createHmac('sha256', signingKey).update(baseString).digest('base64');

  const parts = { ...oauth, oauth_signature: signature };
  const kv = Object.keys(parts).map((k) => `${rfc3986(k)}="${rfc3986(parts[k])}"`).join(', ');
  return `OAuth realm="${rfc3986(cfg.accountId.toUpperCase())}", ${kv}`;
}

async function nsRequest(fetchImpl, cfg, method, path, body) {
  const url = nsBase(cfg.accountId) + path;
  const headers = { Authorization: nsAuthHeader(cfg, method, url) };
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetchImpl(url, { method, headers, body: payload });
}

async function nsErrorText(res) {
  let text = '';
  try { text = await res.text(); } catch { /* ignore */ }
  try {
    const body = JSON.parse(text);
    const details = body?.['o:errorDetails'];
    if (Array.isArray(details)) {
      return details.map((d) => `${d['o:errorCode'] || ''} ${d.detail || ''}`.trim()).join('; ');
    }
  } catch { /* not json */ }
  return text;
}

// PUT/POST that must succeed; returns the internal id parsed from the Location header.
async function nsWrite(fetchImpl, cfg, method, path, body) {
  const res = await nsRequest(fetchImpl, cfg, method, path, body);
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`NetSuite ${method} ${path} -> ${res.status}: ${await nsErrorText(res)}`);
  }
  const loc = res.headers.get('Location');
  return { status: res.status, id: loc ? loc.split('/').pop() : null };
}

// GET a record by eid:; returns its internal id, or null on 404.
async function nsGetInternalId(fetchImpl, cfg, path) {
  const res = await nsRequest(fetchImpl, cfg, 'GET', path);
  if (res.status === 404) return null;
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`NetSuite GET ${path} -> ${res.status}: ${await nsErrorText(res)}`);
  }
  const body = await res.json();
  return body?.id != null ? String(body.id) : null;
}

// -------------------- mapping --------------------

// Expense lines -> NetSuite expense.items[]. Every line gets the default tax code.
function mapLines(expense, ns) {
  const taxCode = { id: ns.defaultTaxCodeId };
  const lines = Array.isArray(expense.lines) ? expense.lines : [];
  if (lines.length > 0) {
    return lines.map((l) => {
      const item = {
        account: { id: numericId(l.category?.externalId) || ns.defaultExpenseAccountId },
        amount: money(l.amount),
        taxCode,
      };
      if (l.note) item.memo = l.note;
      return item;
    });
  }
  // No lines: single line from the header category for the full amount.
  return [{
    account: { id: numericId(expense.category?.externalId) || ns.defaultExpenseAccountId },
    amount: money(expense.amount),
    taxCode,
  }];
}

// Vendor bill / vendor credit share the same body shape (kind = 'bill' | 'credit').
// Currency is intentionally omitted so NetSuite defaults it from the vendor record.
function buildBillBody(expense, vendorId, ns, kind) {
  const body = {
    externalId: `corpay-${kind}-${expense.id}`,
    entity: { id: vendorId },
    subsidiary: { id: ns.subsidiaryId },
    tranId: String(expense.reference || expense.number || '').slice(0, 45),
    tranDate: dateOnly(expense.referenceDate),
    memo: `Corpay One expense ${expense.id}`,
    approvalStatus: { id: '2' }, // 2 = Approved (Corpay is the approval system of record)
    expense: { items: mapLines(expense, ns) },
  };
  const due = dateOnly(expense.dueDate);
  if (due) body.dueDate = due;
  return body;
}

function buildPaymentBody(expense, vendorId, billInternalId, ns) {
  const cur = expense.currency ? expense.currency.toUpperCase() : '';
  const bank = ns.bankAccountByCurrency[cur] || ns.bankAccountId;
  return {
    externalId: `corpay-pay-${expense.id}`,
    entity: { id: vendorId },
    subsidiary: { id: ns.subsidiaryId },
    account: { id: bank },
    apAcct: { id: ns.apAccountId },
    tranDate: dateOnly(expense.paymentDate),
    memo: `Corpay One payment ${expense.id}`,
    apply: { items: [{ doc: { id: billInternalId }, apply: true, amount: money(expense.amount) }] },
  };
}

// -------------------- per-record processing --------------------

function resolveVendorId(expense, stats, kind) {
  const vendorId = numericId(expense.vendor?.externalId);
  if (!vendorId) {
    stats.skipped++;
    console.log(`SKIP ${kind} ${expense.id}: vendor "${expense.vendor?.name || ''}" has no numeric NetSuite externalId`);
  }
  return vendorId;
}

async function processBill(fetchImpl, config, expense, stats) {
  const { ns } = config;
  const vendorId = resolveVendorId(expense, stats, 'bill');
  if (!vendorId) return;

  const body = buildBillBody(expense, vendorId, ns, 'bill');
  const res = await nsWrite(fetchImpl, ns, 'PUT', `/record/v1/vendorBill/eid:corpay-bill-${expense.id}`, body);
  stats.bills++;
  console.log(`BILL corpay-bill-${expense.id} upserted (ns id ${res.id || '?'})`);

  await maybePayment(fetchImpl, config, expense, vendorId, stats);
}

async function processCredit(fetchImpl, config, expense, stats) {
  const { ns } = config;
  const vendorId = resolveVendorId(expense, stats, 'credit');
  if (!vendorId) return;

  const body = buildBillBody(expense, vendorId, ns, 'credit'); // no apply sublist — credit stays open
  const res = await nsWrite(fetchImpl, ns, 'PUT', `/record/v1/vendorCredit/eid:corpay-credit-${expense.id}`, body);
  stats.credits++;
  console.log(`CREDIT corpay-credit-${expense.id} upserted (ns id ${res.id || '?'})`);
}

async function maybePayment(fetchImpl, config, expense, vendorId, stats) {
  const { ns } = config;
  const paid = expense.state === 'Paid'
    || expense.friendlyStatus === 'Paid'
    || expense.friendlyStatus === 'MarkedAsPaid';
  if (!paid || !expense.paymentDate) return;

  // Payments are never updated: if one already exists for this expense, skip.
  const existing = await nsGetInternalId(fetchImpl, ns, `/record/v1/vendorPayment/eid:corpay-pay-${expense.id}?fields=id`);
  if (existing) {
    console.log(`PAYMENT corpay-pay-${expense.id} already exists (ns id ${existing}) - skipping`);
    return;
  }
  // Resolve the bill's internal id (it was just upserted this run).
  const billId = await nsGetInternalId(fetchImpl, ns, `/record/v1/vendorBill/eid:corpay-bill-${expense.id}?fields=id`);
  if (!billId) {
    stats.skipped++;
    console.log(`SKIP payment ${expense.id}: bill corpay-bill-${expense.id} not found in NetSuite`);
    return;
  }
  const body = buildPaymentBody(expense, vendorId, billId, ns);
  const res = await nsWrite(fetchImpl, ns, 'POST', '/record/v1/vendorPayment', body);
  stats.payments++;
  console.log(`PAYMENT corpay-pay-${expense.id} created (ns id ${res.id || '?'})`);
}

// -------------------- main pass --------------------

export async function runSync(config, fetchImpl = globalThis.fetch) {
  const c = config.corpay;
  const stats = { bills: 0, credits: 0, payments: 0, skipped: 0, errors: 0 };

  if (!c.token) {
    console.log('Acquiring Corpay token via refresh_token grant...');
    c.token = await corpayGetToken(fetchImpl, c);
  }

  console.log(`Listing Corpay expenses (states: ${c.syncStates.join(', ')})...`);
  const billIds = dedupe(await listExpenseIds(fetchImpl, c, 'Bill'));
  const creditIds = dedupe(await listExpenseIds(fetchImpl, c, 'Creditnote'));
  console.log(`Found ${billIds.length} bill(s) and ${creditIds.length} credit note(s).`);

  for (const id of billIds) {
    try {
      const expense = await getExpense(fetchImpl, c, id);
      await processBill(fetchImpl, config, expense, stats);
    } catch (e) {
      stats.errors++;
      console.error(`ERROR bill ${id}: ${e.message}`);
    }
  }
  for (const id of creditIds) {
    try {
      const expense = await getExpense(fetchImpl, c, id);
      await processCredit(fetchImpl, config, expense, stats);
    } catch (e) {
      stats.errors++;
      console.error(`ERROR credit ${id}: ${e.message}`);
    }
  }

  console.log(`SUMMARY bills=${stats.bills} credits=${stats.credits} payments=${stats.payments} skipped=${stats.skipped} errors=${stats.errors}`);
  return stats;
}

// -------------------- CLI entry --------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  runSync(loadConfig())
    .then((stats) => process.exit(stats.errors > 0 ? 1 : 0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
