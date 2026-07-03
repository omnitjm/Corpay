// Corpay One -> NetSuite one-way sync.
// Pushes Bills, Bill Credits (credit notes) and Bill Payments from Corpay One
// into NetSuite. One-shot: `node sync.js` does one full pass and exits.
// Idempotency comes entirely from NetSuite externalId (eid:) upserts.
// Zero npm dependencies: native fetch + node:crypto for OAuth1 signing.

import crypto from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dedupe = (arr) => [...new Set(arr)];

// Canonical NetSuite external id for a Corpay expense. kind = 'bill'|'credit'|'pay'.
const eid = (kind, id) => `corpay-${kind}-${id}`;

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

  // Per-currency overrides, all following the same NS_<NAME>_<ISO> pattern:
  //   NS_BANK_ACCOUNT_ID_EUR=341   bank account used for EUR payments
  //   NS_CURRENCY_ID_DKK=1         NetSuite currency internal id for the ISO code
  //   NS_TAX_CODE_ID_EUR=149       tax code override (e.g. EU reverse charge)
  const byCurrency = (prefix) => {
    const map = {};
    const re = new RegExp(`^${prefix}_([A-Za-z]{3})$`);
    for (const [k, v] of Object.entries(env)) {
      const m = re.exec(k);
      if (m && v) map[m[1].toUpperCase()] = v;
    }
    return map;
  };
  const bankByCurrency = byCurrency('NS_BANK_ACCOUNT_ID');
  const currencyIdByCode = byCurrency('NS_CURRENCY_ID');
  const taxCodeByCurrency = byCurrency('NS_TAX_CODE_ID');

  const syncStates = (env.CORPAY_SYNC_STATES || 'Booked,Initialized,Paid')
    .split(',').map((s) => s.trim()).filter(Boolean);

  // Client-side lookback: the list endpoint has no date param, so shallow items are
  // filtered before detail-fetch. Default 90 days; 0 = unlimited (scan all history).
  let lookbackDays = 90;
  const lb = env.CORPAY_LOOKBACK_DAYS;
  if (lb != null && lb !== '') {
    const n = Number(lb);
    lookbackDays = Number.isFinite(n) && n >= 0 ? n : 90;
  }

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
      lookbackDays,
      // Auto-match unstamped Corpay vendors against NetSuite (CVR, then exact name)
      // and stamp the match back. 'false' disables and restores skip-only behavior.
      vendorAutomatch: env.CORPAY_VENDOR_AUTOMATCH !== 'false',
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
      currencyIdByCode,
      taxCodeByCurrency,
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

// Payment-eligible once Corpay reports settlement AND a date. Check/VCC flows
// (friendlyStatus CheckIssued/VccIssued) are not yet Paid; a later run gets their payment
// when Corpay transitions them to Paid (self-healing via polling).
function isPaid(expense) {
  const paid = expense.state === 'Paid'
    || expense.friendlyStatus === 'Paid'
    || expense.friendlyStatus === 'MarkedAsPaid';
  return paid && !!expense.paymentDate;
}

// Lookback filter for a SHALLOW list item. cutoffMs=null means unlimited; undated items kept.
function withinLookback(item, cutoffMs) {
  if (cutoffMs == null) return true;
  const d = item.paymentDate || item.referenceDate;
  if (!d) return true;
  const t = Date.parse(d);
  return Number.isNaN(t) || t >= cutoffMs;
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

// One retry on transient failures (network/429/5xx) and one token re-acquire on 401 when
// refresh credentials exist — a mid-run token expiry must not kill the whole pass.
async function corpayGet(fetchImpl, c, path, query) {
  const url = new URL(c.baseUrl + path);
  if (query) for (const [k, v] of Object.entries(query)) if (v != null) url.searchParams.set(k, v);
  let retried = false;
  let reauthed = false;
  for (;;) {
    await sleep(150); // gentle pacing — stay well under Corpay rate limits
    let res;
    try {
      res = await fetchImpl(url.toString(), {
        headers: { Authorization: `Bearer ${c.token}`, Accept: 'application/json' },
      });
    } catch (e) {
      if (retried) throw e;
      retried = true;
      await sleep(2000);
      continue;
    }
    if (res.ok) return res.json();
    if (res.status === 401 && !reauthed && c.clientId && c.clientSecret && c.refreshToken) {
      reauthed = true;
      console.log('Corpay 401 — re-acquiring token via refresh_token grant...');
      c.token = await corpayGetToken(fetchImpl, c);
      continue;
    }
    if ((res.status === 429 || res.status >= 500) && !retried) {
      retried = true;
      await sleep(2000);
      continue;
    }
    throw new Error(`Corpay GET ${path} -> ${res.status}: ${await res.text()}`);
  }
}

// List all expense ids of a given Type across the given states (paginated),
// keeping only shallow items inside the lookback window.
async function listExpenseIds(fetchImpl, c, type, cutoffMs, states = c.syncStates) {
  const ids = [];
  for (const state of states) {
    let offset = 0;
    for (;;) {
      const resp = await corpayGet(fetchImpl, c, '/v2/expenses',
        { TeamId: c.teamId, Type: type, State: state, Offset: offset, Count: 100 });
      const bills = resp?.data?.bills || [];
      for (const b of bills) if (withinLookback(b, cutoffMs)) ids.push(b.id);
      offset += bills.length;
      // Always stop on an empty page. Only trust the offset>=total break when the
      // envelope actually carries a positive total (guards against envelope changes).
      const total = resp?.total;
      const hasTotal = total != null && Number(total) > 0;
      if (bills.length === 0 || (hasTotal && offset >= Number(total))) break;
    }
  }
  return ids;
}

async function getExpense(fetchImpl, c, id) {
  const resp = await corpayGet(fetchImpl, c, `/v3/expenses/${id}`);
  return resp?.data;
}

// Best-effort write back to Corpay (used to stamp matched vendors). Throws on failure;
// callers decide whether that is fatal (for stamping it never is).
async function corpayPatch(fetchImpl, c, path, body) {
  await sleep(150);
  const res = await fetchImpl(c.baseUrl + path, {
    method: 'PATCH',
    headers: { Authorization: `Bearer ${c.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Corpay PATCH ${path} -> ${res.status}`);
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

async function nsRequest(fetchImpl, cfg, method, path, body, extraHeaders) {
  const url = nsBase(cfg.accountId) + path;
  const headers = { Authorization: nsAuthHeader(cfg, method, url), ...(extraHeaders || {}) };
  let payload;
  if (body != null) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetchImpl(url, { method, headers, body: payload });
}

// Run a SuiteQL query (paginated) and return all rows.
async function nsSuiteQL(fetchImpl, cfg, q) {
  const rows = [];
  let offset = 0;
  for (;;) {
    const res = await nsRequest(fetchImpl, cfg, 'POST',
      `/query/v1/suiteql?limit=1000&offset=${offset}`, { q }, { Prefer: 'transient' });
    if (!res.ok) {
      throw new Error(`NetSuite SuiteQL -> ${res.status}: ${await nsErrorText(res)}`);
    }
    const body = await res.json();
    const items = body?.items || [];
    rows.push(...items);
    if (!body?.hasMore || items.length === 0) return rows;
    offset += items.length;
  }
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

// PUT/POST that must succeed; returns the internal id parsed from the Location header (or null).
async function nsWrite(fetchImpl, cfg, method, path, body) {
  const res = await nsRequest(fetchImpl, cfg, method, path, body);
  if (!res.ok) {
    throw new Error(`NetSuite ${method} ${path} -> ${res.status}: ${await nsErrorText(res)}`);
  }
  const loc = res.headers.get('Location');
  return loc ? loc.split('/').pop() : null;
}

// GET a record by eid:; returns its internal id, or null on 404.
async function nsGetInternalId(fetchImpl, cfg, path) {
  const res = await nsRequest(fetchImpl, cfg, 'GET', path);
  if (res.status === 404) return null;
  if (!res.ok) {
    throw new Error(`NetSuite GET ${path} -> ${res.status}: ${await nsErrorText(res)}`);
  }
  const body = await res.json();
  return body?.id != null ? String(body.id) : null;
}

// -------------------- preflight --------------------

// Validate the NetSuite side of the configuration BEFORE touching any documents, so a
// misconfiguration produces ONE clear, actionable message instead of a wall of cryptic
// per-expense errors. Verifies auth, the subsidiary and every configured account.
async function preflight(fetchImpl, ns) {
  const accountIds = dedupe(
    [ns.apAccountId, ns.bankAccountId, ns.defaultExpenseAccountId,
      ...Object.values(ns.bankAccountByCurrency)]
      .map((id) => Number(id)).filter(Number.isFinite),
  );
  let accounts;
  let subs;
  try {
    accounts = await nsSuiteQL(fetchImpl, ns,
      `SELECT id, accttype, isinactive FROM account WHERE id IN (${accountIds.join(', ')})`);
    subs = await nsSuiteQL(fetchImpl, ns,
      `SELECT id FROM subsidiary WHERE id = ${Number(ns.subsidiaryId)}`);
  } catch (e) {
    throw new Error(`PREFLIGHT: cannot query NetSuite (${e.message}) — check NS_ACCOUNT_ID and the four TBA keys`);
  }

  const byId = {};
  for (const a of accounts) byId[String(a.id)] = a;
  const problems = [];
  const check = (id, label, expectedType) => {
    const a = byId[String(id)];
    if (!a) { problems.push(`${label}=${id}: account not found in NetSuite`); return; }
    if (String(a.isinactive).toUpperCase() === 'T') problems.push(`${label}=${id}: account is inactive`);
    if (expectedType && a.accttype !== expectedType) {
      problems.push(`${label}=${id}: expected an ${expectedType} account, got ${a.accttype}`);
    }
  };
  check(ns.apAccountId, 'NS_AP_ACCOUNT_ID', 'AcctPay');
  check(ns.bankAccountId, 'NS_BANK_ACCOUNT_ID', 'Bank');
  for (const [cur, id] of Object.entries(ns.bankAccountByCurrency)) {
    check(id, `NS_BANK_ACCOUNT_ID_${cur}`, 'Bank');
  }
  check(ns.defaultExpenseAccountId, 'NS_DEFAULT_EXPENSE_ACCOUNT_ID', null);
  if (subs.length === 0) problems.push(`NS_SUBSIDIARY_ID=${ns.subsidiaryId}: subsidiary not found (positive internal id required)`);

  if (problems.length) {
    throw new Error('PREFLIGHT failed — fix the configuration:\n  ' + problems.join('\n  '));
  }
  console.log('PREFLIGHT ok (NetSuite auth, subsidiary and accounts verified)');
}

// -------------------- per-run lookup caches --------------------

const digitsOnly = (s) => String(s || '').replace(/\D/g, '');
const normName = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

// NetSuite chart of accounts: acctnumber -> internal id (fetched once per run).
async function getAccountMap(ctx) {
  if (!ctx.accountMap) {
    const rows = await nsSuiteQL(ctx.fetchImpl, ctx.ns,
      "SELECT id, acctnumber FROM account WHERE isinactive = 'F'");
    ctx.accountMap = {};
    for (const r of rows) {
      if (r.acctnumber != null && String(r.acctnumber).trim() !== '') {
        ctx.accountMap[String(r.acctnumber).trim()] = String(r.id);
      }
    }
  }
  return ctx.accountMap;
}

// Active NetSuite vendors for auto-matching (fetched once per run).
async function getNsVendors(ctx) {
  if (!ctx.nsVendors) {
    ctx.nsVendors = await nsSuiteQL(ctx.fetchImpl, ctx.ns,
      "SELECT id, companyname, vatregnumber FROM vendor WHERE isinactive = 'F'");
  }
  return ctx.nsVendors;
}

// Expense-account resolution chain: numeric category.externalId -> category.number matched
// against the NetSuite chart of accounts -> default account (noted once per category).
async function resolveAccount(ctx, category) {
  const direct = numericId(category?.externalId);
  if (direct) return direct;
  const num = category?.number;
  if (num != null && String(num).trim() !== '') {
    const map = await getAccountMap(ctx);
    const hit = map[String(num).trim()];
    if (hit) return hit;
  }
  const key = `"${category?.name || '?'}" (${category?.number ?? '-'})`;
  if (!ctx.notedCategories.has(key)) {
    ctx.notedCategories.add(key);
    console.log(`NOTE category ${key} not matched to a NetSuite account — using default`);
  }
  return ctx.ns.defaultExpenseAccountId;
}

// Vendor resolution chain: numeric vendor.externalId -> auto-match by CVR/VAT number ->
// auto-match by exact (normalized) name -> skip loudly. A match is stamped back onto the
// Corpay vendor (best effort) so subsequent runs resolve directly.
async function resolveVendor(ctx, expense, kind) {
  const direct = numericId(expense.vendor?.externalId);
  if (direct) return direct;

  const name = expense.vendor?.name || '';
  const skip = (why) => {
    ctx.stats.skipped++;
    console.log(`SKIP ${kind} ${expense.id}: vendor "${name}" ${why} — set the NetSuite internal id as the vendor's externalId in Corpay One`);
    return null;
  };
  if (!ctx.corpay.vendorAutomatch) return skip('has no numeric NetSuite externalId (automatch disabled)');

  // Corpay vendor detail carries the CVR/VAT number ("identification"); cache per vendor.
  const cvId = expense.vendor?.id;
  let detail = null;
  if (cvId != null) {
    if (!(cvId in ctx.corpayVendorCache)) {
      try {
        const resp = await corpayGet(ctx.fetchImpl, ctx.corpay,
          `/v2/teams/${ctx.corpay.teamId}/vendors/${cvId}`);
        ctx.corpayVendorCache[cvId] = resp?.data || null;
      } catch {
        ctx.corpayVendorCache[cvId] = null;
      }
    }
    detail = ctx.corpayVendorCache[cvId];
  }

  const vendors = await getNsVendors(ctx);
  const cvr = digitsOnly(detail?.identification);
  if (cvr) {
    const hits = vendors.filter((v) => digitsOnly(v.vatregnumber) === cvr);
    if (hits.length === 1) return vendorMatched(ctx, expense, hits[0], 'cvr');
  }
  const nm = normName(detail?.name || name);
  if (nm) {
    const hits = vendors.filter((v) => normName(v.companyname) === nm);
    if (hits.length === 1) return vendorMatched(ctx, expense, hits[0], 'name');
    if (hits.length > 1) return skip(`is ambiguous (${hits.length} NetSuite vendors share the name)`);
  }
  return skip('was not auto-matched (no CVR or exact-name candidate in NetSuite)');
}

async function vendorMatched(ctx, expense, vendor, how) {
  const id = String(vendor.id);
  console.log(`MATCH vendor "${expense.vendor?.name || ''}" -> NetSuite ${id} (${how})`);
  const cvId = expense.vendor?.id;
  if (cvId != null) {
    try {
      await corpayPatch(ctx.fetchImpl, ctx.corpay,
        `/v2/teams/${ctx.corpay.teamId}/vendors/${cvId}/external-id`,
        { source: 'netsuite', externalId: id });
      console.log(`STAMPED Corpay vendor ${cvId} with externalId=${id}`);
      if (ctx.corpayVendorCache[cvId]) ctx.corpayVendorCache[cvId].externalId = id;
    } catch (e) {
      // Needs a vendor-write scope; without it we simply re-match from cache next run.
      console.log(`NOTE could not stamp Corpay vendor ${cvId} (${e.message}) — will re-match next run`);
    }
  }
  return id;
}

// -------------------- mapping --------------------

// Tax code by expense currency (NS_TAX_CODE_ID_<ISO>, e.g. EU reverse charge for EUR),
// falling back to the default. Corpay carries no tax data, so currency is the only proxy.
function taxCodeFor(expense, ns) {
  const cur = expense.currency ? String(expense.currency).toUpperCase() : '';
  return { id: ns.taxCodeByCurrency[cur] || ns.defaultTaxCodeId };
}

// NetSuite currency internal id for the expense's ISO code (NS_CURRENCY_ID_<ISO>).
// Unmapped/absent -> null: the transaction then uses the vendor's default currency AND the
// default bank account, so bill, payment and bank currencies can never diverge.
function currencyIdFor(expense, ns) {
  const cur = expense.currency ? String(expense.currency).toUpperCase() : '';
  return (cur && ns.currencyIdByCode[cur]) || null;
}

// Expense lines -> NetSuite expense.items[].
// Corpay amounts are GROSS (VAT-inclusive splits of the payable total), so lines are sent
// as `grossAmt` (not net `amount`): NetSuite back-computes net from the tax code and the
// bill total equals the Corpay amount. Net `amount` + taxCode would add VAT on top and
// leave every bill ~25% open after the matching payment.
// The bill total MUST equal expense.amount — the payment applies exactly that — so splits
// are used only when they reconcile: zero lines are dropped, and if a line is negative or
// the sum differs from the header amount, the bill falls back to one header-total line
// (logged loudly) instead of booking wrong money.
async function mapLines(ctx, expense) {
  const ns = ctx.ns;
  const taxCode = taxCodeFor(expense, ns);
  const headerLine = async () => [{
    account: { id: await resolveAccount(ctx, expense.category) },
    grossAmt: money(expense.amount),
    taxCode,
  }];
  const all = Array.isArray(expense.lines) ? expense.lines : [];
  const lines = all.filter((l) => Number(l.amount || 0) !== 0);
  if (lines.length === 0) return headerLine();

  const sumMinor = all.reduce((s, l) => s + Number(l.amount || 0), 0);
  const anyNegative = lines.some((l) => Number(l.amount) < 0);
  if (anyNegative || sumMinor !== Number(expense.amount)) {
    const why = anyNegative
      ? 'contain negative amounts'
      : `sum ${money(sumMinor)} != total ${money(expense.amount)}`;
    console.log(`WARN ${expense.id}: line splits ${why} — booking single header-total line`);
    return headerLine();
  }
  const items = [];
  for (const l of lines) {
    const item = {
      account: { id: await resolveAccount(ctx, l.category) },
      grossAmt: money(l.amount),
      taxCode,
    };
    if (l.note) item.memo = l.note;
    items.push(item);
  }
  return items;
}

// Vendor bill / vendor credit share the same body shape (kind = 'bill' | 'credit').
// Currency is set explicitly when NS_CURRENCY_ID_<ISO> maps it; otherwise it is omitted
// and NetSuite defaults it from the vendor record.
async function buildBillBody(ctx, expense, vendorId, kind) {
  const ns = ctx.ns;
  const body = {
    externalId: eid(kind, expense.id),
    entity: { id: vendorId },
    subsidiary: { id: ns.subsidiaryId },
    // Falls back to the Corpay expense id so tranId is never blank (some accounts
    // reject an empty Reference No.).
    tranId: String(expense.reference || expense.number || expense.id).slice(0, 45),
    tranDate: dateOnly(expense.referenceDate),
    memo: `Corpay One expense ${expense.id}`,
    expense: { items: await mapLines(ctx, expense) },
  };
  const curId = currencyIdFor(expense, ns);
  if (curId) body.currency = { id: curId };
  // approvalStatus exists only on vendorBill (2 = Approved; Corpay is the approval system
  // of record). vendorCredit has no such field and NetSuite 400s on the unknown property.
  if (kind === 'bill') body.approvalStatus = { id: '2' };
  const due = dateOnly(expense.dueDate);
  if (due) body.dueDate = due;
  return body;
}

function buildPaymentBody(expense, vendorId, billInternalId, ns) {
  const cur = expense.currency ? expense.currency.toUpperCase() : '';
  const curId = currencyIdFor(expense, ns);
  // A currency-specific bank account is only safe when the currency is explicitly set on
  // the transactions; with a vendor-default currency, stick to the default bank so the
  // payment, bill and bank currencies always agree.
  const bank = (curId && ns.bankAccountByCurrency[cur]) || ns.bankAccountId;
  const body = {
    externalId: eid('pay', expense.id),
    entity: { id: vendorId },
    subsidiary: { id: ns.subsidiaryId },
    account: { id: bank },
    apAcct: { id: ns.apAccountId },
    tranDate: dateOnly(expense.paymentDate),
    memo: `Corpay One payment ${expense.id}`,
    apply: { items: [{ doc: { id: billInternalId }, apply: true, amount: money(expense.amount) }] },
  };
  if (curId) body.currency = { id: curId };
  return body;
}

// -------------------- per-record processing --------------------

// Upsert a bill or credit; for a paid bill also create its payment (once, never updated).
async function processExpense(ctx, expense, kind) {
  const { ns, fetchImpl, stats } = ctx;
  const record = kind === 'bill' ? 'vendorBill' : 'vendorCredit';
  const counter = kind === 'bill' ? 'bills' : 'credits';
  const label = kind === 'bill' ? 'BILL' : 'CREDIT';

  const vendorId = await resolveVendor(ctx, expense, kind);
  if (!vendorId) return;

  const payable = kind === 'bill' && isPaid(expense);

  // For a paid bill the FIRST NetSuite call is the payment-existence check: if the payment
  // already exists the bill is settled, so skip it entirely (no re-PUT). Saves a write per
  // settled bill per run and stops mutating a bill after payment (a later Corpay edit could
  // otherwise make the PUT fail forever).
  if (payable) {
    const paidId = await nsGetInternalId(fetchImpl, ns, `/record/v1/vendorPayment/eid:${eid('pay', expense.id)}?fields=id`);
    if (paidId) {
      stats.settled++;
      console.log(`SETTLED ${eid('bill', expense.id)} — skipping`);
      return;
    }
  }

  const body = await buildBillBody(ctx, expense, vendorId, kind);
  // ?replace=expense: NetSuite REST MERGES sublists on update by default (incoming lines
  // without line ids are APPENDED). replace makes each upsert a full sublist replace, so
  // re-upserting an unchanged/edited bill can never duplicate lines.
  const internalId = await nsWrite(fetchImpl, ns, 'PUT', `/record/v1/${record}/eid:${eid(kind, expense.id)}?replace=expense`, body);
  stats[counter]++;
  console.log(`${label} ${eid(kind, expense.id)} upserted (ns id ${internalId || '?'})`);

  if (payable) await createPayment(ctx, expense, vendorId, internalId);
}

// Create the vendor payment for a just-upserted bill (existence already checked by caller).
// billInternalId comes from the bill PUT's Location header; only look it up if that was null.
async function createPayment(ctx, expense, vendorId, billInternalId) {
  const { ns, fetchImpl, stats } = ctx;
  let billId = billInternalId;
  if (!billId) {
    billId = await nsGetInternalId(fetchImpl, ns, `/record/v1/vendorBill/eid:${eid('bill', expense.id)}?fields=id`);
  }
  if (!billId) {
    stats.skipped++;
    console.log(`SKIP pay ${expense.id}: bill ${eid('bill', expense.id)} not found in NetSuite`);
    return;
  }
  const body = buildPaymentBody(expense, vendorId, billId, ns);
  const payId = await nsWrite(fetchImpl, ns, 'POST', '/record/v1/vendorPayment', body);
  stats.payments++;
  console.log(`PAY ${eid('pay', expense.id)} created (ns id ${payId || '?'})`);
}

// -------------------- main pass --------------------

export async function runSync(config, fetchImpl = globalThis.fetch) {
  // Local copy so acquiring a token never mutates the caller's config object.
  const c = { ...config.corpay };
  const stats = { bills: 0, credits: 0, payments: 0, settled: 0, skipped: 0, warnings: 0, errors: 0 };

  if (!c.token) {
    console.log('Acquiring Corpay token via refresh_token grant...');
    c.token = await corpayGetToken(fetchImpl, c);
  }

  // Per-run context: config, per-run lookup caches, counters.
  const ctx = {
    fetchImpl,
    ns: config.ns,
    corpay: c,
    stats,
    accountMap: null,
    nsVendors: null,
    corpayVendorCache: {},
    notedCategories: new Set(),
  };

  await preflight(fetchImpl, config.ns);

  const cutoffMs = c.lookbackDays > 0 ? Date.now() - c.lookbackDays * 86400000 : null;
  console.log(`Listing Corpay expenses (states: ${c.syncStates.join(', ')}; lookback: ${c.lookbackDays ? c.lookbackDays + 'd' : 'unlimited'})...`);
  const billIds = dedupe(await listExpenseIds(fetchImpl, c, 'Bill', cutoffMs));
  const creditIds = dedupe(await listExpenseIds(fetchImpl, c, 'Creditnote', cutoffMs));
  console.log(`Found ${billIds.length} bill(s) and ${creditIds.length} credit note(s).`);

  const runOne = async (id, kind) => {
    try {
      const expense = await getExpense(fetchImpl, c, id);
      if (!expense) {
        stats.skipped++;
        console.log(`SKIP ${kind} ${id}: no detail payload`);
        return;
      }
      await processExpense(ctx, expense, kind);
    } catch (e) {
      stats.errors++;
      console.error(`ERROR ${kind} ${id}: ${e.message}`);
    }
  };

  for (const id of billIds) await runOne(id, 'bill');
  for (const id of creditIds) await runOne(id, 'credit');

  // Reversal check: a document cancelled/refunded in Corpay AFTER it was synced would
  // otherwise sit in NetSuite as an approved payable forever. Posted financials are never
  // auto-deleted — they are surfaced loudly for manual reversal instead.
  for (const [type, kind, record] of [['Bill', 'bill', 'vendorBill'], ['Creditnote', 'credit', 'vendorCredit']]) {
    let reversedIds = [];
    try {
      reversedIds = dedupe(await listExpenseIds(fetchImpl, c, type, cutoffMs, ['Cancelled', 'Refunded']));
    } catch (e) {
      stats.errors++;
      console.error(`ERROR listing reversals (${type}): ${e.message}`);
      continue;
    }
    for (const id of reversedIds) {
      try {
        const existing = await nsGetInternalId(fetchImpl, config.ns, `/record/v1/${record}/eid:${eid(kind, id)}?fields=id`);
        if (existing) {
          stats.warnings++;
          console.log(`WARN ${kind} ${id}: cancelled/refunded in Corpay but ${record} ${existing} still exists in NetSuite — reverse manually`);
        }
      } catch (e) {
        stats.errors++;
        console.error(`ERROR reversal check ${kind} ${id}: ${e.message}`);
      }
    }
  }

  console.log('SUMMARY ' + Object.entries(stats).map(([k, v]) => `${k}=${v}`).join(' '));
  return stats;
}

// -------------------- CLI entry --------------------

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSync(loadConfig())
    .then((stats) => process.exit(stats.errors > 0 ? 1 : 0))
    .catch((err) => { console.error(err.message); process.exit(1); });
}
