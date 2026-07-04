/**
 * corpay_sync_mr.js — Corpay One -> NetSuite one-way sync, NetSuite-RESIDENT variant.
 *
 * A SuiteScript 2.1 Map/Reduce script that lives entirely inside NetSuite (no external
 * server). It mirrors the business logic and externalId conventions of the external
 * Node variant (sync.js), so the two are interchangeable and never create duplicates:
 *   Vendor Bill    externalId  corpay-bill-{id}
 *   Vendor Credit  externalId  corpay-credit-{id}
 *   Vendor Payment externalId  corpay-pay-{id}
 *
 * Flow (one-way, poll-based; idempotency lives in the NetSuite external ids):
 *   getInputData  page Corpay v2 /expenses (Bill + Creditnote) across states, lookback-filter,
 *                 dedupe, and emit one {id, kind} per document.
 *   map           per document: fetch v3 detail, upsert the bill/credit, and — for a paid bill
 *                 whose payment does not yet exist — transform it into a vendor payment.
 *   summarize     tally outcomes to the Audit log; optionally email a summary when errors > 0.
 *
 * Deploy with concurrency = 1 (see netsuite/README.md).
 *
 * @NApiVersion 2.1
 * @NScriptType MapReduceScript
 */
define(['N/https', 'N/record', 'N/search', 'N/query', 'N/runtime', 'N/log', 'N/email'],
  function (https, record, search, query, runtime, log, email) {
    'use strict';

    // ---------------------------------------------------------------- constants / helpers

    // Canonical NetSuite external id for a Corpay expense. kind = 'bill' | 'credit' | 'pay'.
    function eid(kind, id) { return 'corpay-' + kind + '-' + id; }

    // Corpay amounts are int64 minor units (øre/cents) -> major units, 2 decimals.
    function money(minor) { return Math.round(Number(minor || 0)) / 100; }

    // Digits-only string if val is a positive integer id, else null.
    function numericId(val) {
      if (val === null || val === undefined) { return null; }
      var s = String(val).trim();
      return /^\d+$/.test(s) ? s : null;
    }

    // All digits in val (e.g. a CVR/VAT number stripped of "DK", spaces, dots). '' if none.
    function digitsOnly(val) {
      if (val === null || val === undefined) { return ''; }
      return String(val).replace(/\D/g, '');
    }

    // Company-name normalizer for fuzzy vendor matching: lowercase, collapse internal
    // whitespace to single spaces, trim. '' for null/undefined.
    function normalizeName(val) {
      if (val === null || val === undefined) { return ''; }
      return String(val).replace(/\s+/g, ' ').trim().toLowerCase();
    }

    // "YYYY-MM-DD..." -> a Date at local midnight (avoids timezone day-shift). null if unusable.
    function toDate(val) {
      if (!val) { return null; }
      var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(val));
      return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
    }

    // Payment-eligible once Corpay reports settlement AND a date. Check/VCC flows are not yet
    // Paid; a later run creates their payment when Corpay transitions them to Paid (self-healing).
    function isPaid(expense) {
      var paid = expense.state === 'Paid'
        || expense.friendlyStatus === 'Paid'
        || expense.friendlyStatus === 'MarkedAsPaid';
      return paid && !!expense.paymentDate;
    }

    // Lookback filter for a SHALLOW list item. cutoffMs=null means unlimited; undated items kept.
    function withinLookback(item, cutoffMs) {
      if (cutoffMs === null) { return true; }
      var d = item.paymentDate || item.referenceDate;
      if (!d) { return true; }
      var t = Date.parse(d);
      return isNaN(t) || t >= cutoffMs;
    }

    // ---------------------------------------------------------------- run-scoped caches
    // Module-level, lazily built, and reset at the start of getInputData. Map/Reduce stages run
    // in separate contexts, so the map phase simply rebuilds these on first use (a fresh module
    // per stage) — the reset keeps a single-context test run (or a re-used context) honest.
    var _accountNumberCache = null;   // acctnumber (trimmed string) -> account internal id (string)
    var _vendorListCache = null;      // [{ id, companyname, vatregnumber }] active NetSuite vendors
    var _corpayVendorCache = {};      // Corpay vendorId -> vendor detail (or null) — one GET per run
    var _unmatchedCategorySeen = {};  // dedupe key -> true, so the NOTE logs once per category

    function resetCaches() {
      _accountNumberCache = null;
      _vendorListCache = null;
      _corpayVendorCache = {};
      _unmatchedCategorySeen = {};
    }

    // ---------------------------------------------------------------- script parameters

    function params() {
      var script = runtime.getCurrentScript();
      function g(name) {
        var v = script.getParameter({ name: name });
        return (v === null || v === undefined) ? '' : v;
      }
      // Lookback: unset -> 90 (default); explicit 0 -> unlimited; anything else numeric wins.
      var lookbackDays = 90;
      var lb = g('custscript_cp_lookback_days');
      if (lb !== '') {
        var n = Number(lb);
        if (isFinite(n) && n >= 0) { lookbackDays = n; }
      }
      var states = (g('custscript_cp_states') || 'Booked,Initialized,Paid')
        .split(',').map(function (s) { return s.trim(); }).filter(Boolean);
      return {
        baseUrl: (g('custscript_cp_base_url') || 'https://api.corpayone.com/external')
          .replace(/\/$/, ''),
        tokenSecret: g('custscript_cp_token_secret'),
        tokenPlain: g('custscript_cp_token_plain'),
        teamId: g('custscript_cp_team_id'),
        states: states,
        lookbackDays: lookbackDays,
        subsidiary: g('custscript_cp_subsidiary'),
        apAccount: g('custscript_cp_ap_account'),
        bankAccount: g('custscript_cp_bank_account'),
        bankAccountEur: g('custscript_cp_bank_account_eur'),
        defaultExpenseAcct: g('custscript_cp_default_expense_acct'),
        defaultTaxcode: g('custscript_cp_default_taxcode'),
        taxcodeEur: g('custscript_cp_taxcode_eur'),
        notifyEmail: g('custscript_cp_notify_email'),
        // Vendor auto-match is ON unless explicitly set to 'false'. When enabled, a bill/credit
        // whose vendor has no numeric NetSuite externalId is matched by CVR/VAT then exact name
        // (see resolveVendor); when disabled, such a document is skipped as before.
        vendorAutomatch: String(g('custscript_cp_vendor_automatch')).toLowerCase() !== 'false',
        // Vendor auto-CREATE is ON unless explicitly set to 'false'. When auto-match finds NO
        // candidate at all (no CVR and no exact-name hit — an ambiguous name still SKIPs, so a
        // duplicate is never created), the vendor is created in NetSuite so the document posts in
        // the same run. Requires auto-match on; when off, such a document is skipped as before.
        vendorAutocreate: String(g('custscript_cp_vendor_autocreate')).toLowerCase() !== 'false'
      };
    }

    // ---------------------------------------------------------------- Corpay client (N/https)

    // Authorization header. The API Secret (preferred) is injected server-side via a
    // SecureString so the token never appears in the execution log. A plain-text token
    // parameter is the fallback for accounts without the API Secrets feature.
    function authHeader(p) {
      if (p.tokenSecret) {
        return https.createSecureString({ input: 'Bearer {' + p.tokenSecret + '}' });
      }
      return 'Bearer ' + p.tokenPlain;
    }

    function buildQuery(query) {
      if (!query) { return ''; }
      var parts = [];
      for (var k in query) {
        if (query.hasOwnProperty(k) && query[k] !== null && query[k] !== undefined) {
          parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
        }
      }
      return parts.length ? '?' + parts.join('&') : '';
    }

    function corpayGet(p, path, query) {
      var url = p.baseUrl + path + buildQuery(query);
      var res = https.get({
        url: url,
        headers: { Authorization: authHeader(p), Accept: 'application/json' }
      });
      if (res.code < 200 || res.code >= 300) {
        throw new Error('Corpay GET ' + path + ' -> ' + res.code + ': ' + res.body);
      }
      return JSON.parse(res.body);
    }

    // List expense ids of a given Type across the given states (paginated), keeping only
    // shallow items inside the lookback window. Deduped across states.
    function listExpenseIds(p, type, cutoffMs, states) {
      var seen = {};
      var ids = [];
      (states || p.states).forEach(function (state) {
        var offset = 0;
        for (;;) {
          var resp = corpayGet(p, '/v2/expenses', {
            TeamId: p.teamId, Type: type, State: state, Offset: offset, Count: 100
          });
          var bills = (resp && resp.data && resp.data.bills) || [];
          for (var i = 0; i < bills.length; i++) {
            var b = bills[i];
            if (withinLookback(b, cutoffMs) && !seen[b.id]) {
              seen[b.id] = true;
              ids.push(b.id);
            }
          }
          offset += bills.length;
          // Always stop on an empty page; only trust offset>=total when total is positive.
          var total = resp && resp.total;
          var hasTotal = total !== null && total !== undefined && Number(total) > 0;
          if (bills.length === 0 || (hasTotal && offset >= Number(total))) { break; }
        }
      });
      return ids;
    }

    function getExpense(p, id) {
      var resp = corpayGet(p, '/v3/expenses/' + encodeURIComponent(id), null);
      return resp && resp.data;
    }

    // ---------------------------------------------------------------- NetSuite lookups

    // Internal id of the transaction carrying this external id, or null. External ids are
    // globally unique (corpay-bill / -credit / -pay), so one transaction search disambiguates.
    function findByExternalId(externalId) {
      var found = null;
      search.create({
        type: search.Type.TRANSACTION,
        filters: [['externalidstring', 'is', externalId]],
        columns: ['internalid']
      }).run().each(function (row) { found = row.id; return false; });
      return found;
    }

    // Run a SuiteQL statement and return an array of {column: value} objects (column names lower-cased).
    function runSuiteQL(sql) {
      return query.runSuiteQL({ query: sql }).asMappedResults();
    }

    // ---------------------------------------------------------------- preflight validation

    // Validate the account/subsidiary parameters up front so a misconfiguration produces ONE
    // clear, actionable error at the top of the run — not a wall of identical per-document
    // failures. Collects every problem and throws them together. Called from getInputData.
    function preflight(p) {
      var problems = [];

      // Each configured account, with the accttype it must have ('' = any type, just exists+active).
      var checks = [
        { name: 'custscript_cp_ap_account', id: p.apAccount, type: 'AcctPay', label: 'an Accounts Payable account' },
        { name: 'custscript_cp_bank_account', id: p.bankAccount, type: 'Bank', label: 'a Bank account' },
        { name: 'custscript_cp_default_expense_acct', id: p.defaultExpenseAcct, type: '', label: '' }
      ];
      if (numericId(p.bankAccountEur)) {
        checks.push({ name: 'custscript_cp_bank_account_eur', id: p.bankAccountEur, type: 'Bank', label: 'a Bank account' });
      }

      var ids = [];
      checks.forEach(function (c) {
        var nid = numericId(c.id);
        if (nid) { ids.push(nid); }
        else { problems.push(c.name + '=' + c.id + ': not a numeric account internal id'); }
      });

      var acctById = {};
      if (ids.length) {
        runSuiteQL('SELECT id, accttype, isinactive FROM account WHERE id IN (' + ids.join(', ') + ')')
          .forEach(function (r) { acctById[String(r.id)] = r; });
      }
      checks.forEach(function (c) {
        var nid = numericId(c.id);
        if (!nid) { return; } // already reported above
        var row = acctById[nid];
        if (!row) { problems.push(c.name + '=' + c.id + ': account not found'); return; }
        if (String(row.isinactive).toUpperCase() === 'T') {
          problems.push(c.name + '=' + c.id + ': account is inactive');
        }
        if (c.type && String(row.accttype) !== c.type) {
          problems.push(c.name + '=' + c.id + ': not ' + c.label + ' (accttype=' + row.accttype + ')');
        }
      });

      var subId = numericId(p.subsidiary);
      if (!subId) {
        problems.push('custscript_cp_subsidiary=' + p.subsidiary + ': not a numeric subsidiary internal id');
      } else if (!runSuiteQL('SELECT id FROM subsidiary WHERE id = ' + subId).length) {
        problems.push('custscript_cp_subsidiary=' + p.subsidiary + ': subsidiary not found');
      }

      if (problems.length) {
        throw new Error('Preflight validation failed:\n  ' + problems.join('\n  '));
      }
    }

    // ---------------------------------------------------------------- account resolution

    // acctnumber -> internal id map for all active accounts, built once per run (lazy).
    function accountNumberMap() {
      if (_accountNumberCache === null) {
        _accountNumberCache = {};
        runSuiteQL("SELECT id, acctnumber FROM account WHERE isinactive = 'F'").forEach(function (r) {
          if (r.acctnumber !== null && r.acctnumber !== undefined && String(r.acctnumber).trim() !== '') {
            _accountNumberCache[String(r.acctnumber).trim()] = String(r.id);
          }
        });
      }
      return _accountNumberCache;
    }

    // Log the "no account matched" NOTE at most once per distinct category per run.
    function noteUnmatchedCategory(category) {
      var name = (category && category.name) || '';
      var number = (category && category.number !== null && category.number !== undefined)
        ? category.number : '';
      var key = name + '|' + number;
      if (_unmatchedCategorySeen[key]) { return; }
      _unmatchedCategorySeen[key] = true;
      log.audit('NOTE', 'category "' + name + '" (' + number + ') not matched to a NetSuite '
        + 'account — using default');
    }

    // Resolve a Corpay category to a NetSuite account internal id:
    //   (a) numeric category.externalId -> use directly as the internal id;
    //   (b) category.number matches a NetSuite account acctnumber -> that account;
    //   (c) fallback to the default expense account (logged once per category).
    function resolveAccount(category, p) {
      var extId = numericId(category && category.externalId);
      if (extId) { return extId; }
      if (category && category.number !== null && category.number !== undefined) {
        var hit = accountNumberMap()[String(category.number).trim()];
        if (hit) { return hit; }
      }
      noteUnmatchedCategory(category);
      return p.defaultExpenseAcct;
    }

    // ---------------------------------------------------------------- vendor resolution

    // Active NetSuite vendors, fetched once per run (lazy).
    function vendorList() {
      if (_vendorListCache === null) {
        _vendorListCache = runSuiteQL(
          "SELECT id, companyname, vatregnumber FROM vendor WHERE isinactive = 'F'");
      }
      return _vendorListCache;
    }

    // Internal id of the vendor carrying this externalid, or null. Used as the idempotent
    // fallback when an auto-create races another writer and hits the externalid unique index.
    function findVendorByExternalId(externalId) {
      var safe = String(externalId).replace(/'/g, "''");
      var rows = runSuiteQL("SELECT id FROM vendor WHERE externalid = '" + safe + "'");
      return rows.length ? String(rows[0].id) : null;
    }

    // Corpay vendor detail (name + identification), cached per vendorId per run. Best-effort:
    // a failed GET returns null (matching continues on whatever the shallow expense carries).
    function corpayVendorDetail(p, vendorId) {
      if (!vendorId) { return null; }
      var key = String(vendorId);
      if (_corpayVendorCache.hasOwnProperty(key)) { return _corpayVendorCache[key]; }
      var detail = null;
      try {
        var resp = corpayGet(p, '/v2/teams/' + encodeURIComponent(p.teamId)
          + '/vendors/' + encodeURIComponent(vendorId), null);
        detail = (resp && resp.data) || null;
      } catch (e) {
        log.audit('NOTE', 'could not fetch Corpay vendor ' + vendorId + ': ' + ((e && e.message) || e));
      }
      _corpayVendorCache[key] = detail;
      return detail;
    }

    // Best-effort stamp-back of the matched NetSuite internal id onto the Corpay vendor, so the
    // next run resolves it instantly via externalId and never re-matches. A failure (missing
    // teams.vendors write scope, transient error) is logged and never blocks the sync.
    function stampVendorExternalId(p, vendorId, nsId) {
      if (!vendorId) { return; }
      try {
        var res = https.request({
          method: 'PATCH',
          url: p.baseUrl + '/v2/teams/' + encodeURIComponent(p.teamId)
            + '/vendors/' + encodeURIComponent(vendorId) + '/external-id',
          body: JSON.stringify({ source: 'netsuite', externalId: String(nsId) }),
          headers: { Authorization: authHeader(p), 'Content-Type': 'application/json' }
        });
        if (res && (res.code < 200 || res.code >= 300)) {
          log.audit('NOTE', 'vendor ' + vendorId + ' external-id stamp-back -> ' + res.code
            + ' (matched anyway; will re-match next run)');
        }
      } catch (e) {
        log.audit('NOTE', 'vendor ' + vendorId + ' external-id stamp-back failed: '
          + ((e && e.message) || e) + ' (matched anyway; will re-match next run)');
      }
    }

    // Resolve the NetSuite vendor internal id for an expense. Returns { id } on success, or
    // { skip: <reason> } when the caller should SKIP the document.
    //   1. numeric expense.vendor.externalId -> use directly (already mapped).
    //   2. auto-match (unless disabled): CVR/VAT digits, then exact normalized company name;
    //      each requires EXACTLY ONE candidate. On match, stamp the id back to Corpay.
    //   3. otherwise SKIP with an actionable message.
    function resolveVendor(p, expense) {
      var vendor = expense.vendor || {};
      var extId = numericId(vendor.externalId);
      if (extId) { return { id: extId }; }

      if (!p.vendorAutomatch) {
        return { skip: 'vendor "' + (vendor.name || '') + '" has no numeric NetSuite externalId' };
      }

      var vendors = vendorList();
      var detail = corpayVendorDetail(p, vendor.id);
      var corpayName = (detail && detail.name) || vendor.name || '';
      var tail = ' — set the NetSuite internal id as the vendor\'s externalId in Corpay One';

      // Match 1: CVR/VAT (digits only, both sides non-empty, exactly one candidate).
      var cvr = digitsOnly(detail && detail.identification);
      if (cvr) {
        var cvrMatches = vendors.filter(function (v) {
          var vc = digitsOnly(v.vatregnumber);
          return vc && vc === cvr;
        });
        if (cvrMatches.length === 1) {
          log.audit('MATCH', 'vendor "' + corpayName + '" -> NetSuite ' + cvrMatches[0].id + ' (cvr)');
          stampVendorExternalId(p, vendor.id, cvrMatches[0].id);
          return { id: String(cvrMatches[0].id) };
        }
      }

      // Match 2: exact normalized company name (exactly one candidate).
      var norm = normalizeName(corpayName);
      if (norm) {
        var nameMatches = vendors.filter(function (v) { return normalizeName(v.companyname) === norm; });
        if (nameMatches.length === 1) {
          log.audit('MATCH', 'vendor "' + corpayName + '" -> NetSuite ' + nameMatches[0].id + ' (name)');
          stampVendorExternalId(p, vendor.id, nameMatches[0].id);
          return { id: String(nameMatches[0].id) };
        }
        if (nameMatches.length > 1) {
          return { skip: 'vendor "' + corpayName + '" not auto-matched ('
            + nameMatches.length + ' name candidates)' + tail };
        }
      }

      // No candidate at all (and the name was not ambiguous). Auto-create the vendor when enabled
      // so the booked document can post this run; otherwise skip as before.
      if (p.vendorAutocreate) {
        return createVendor(p, expense, detail, corpayName);
      }
      return { skip: 'vendor "' + corpayName + '" not auto-matched (no CVR/name candidates)' + tail };
    }

    // Auto-create a NetSuite vendor when auto-match found no candidate. Returns { id, created } on
    // success or { skip } when there is nothing to create from. The externalid
    // 'corpay-vendor-{corpayVendorId}' is the idempotency key: a retry or a concurrent run resolves
    // to the SAME record via the externalid unique index — a duplicate-externalid save error falls
    // back to a lookup by that externalid. On success the vendor is added to the per-run cache and
    // its internal id is stamped back to Corpay, exactly like a match.
    function createVendor(p, expense, detail, corpayName) {
      var vendor = expense.vendor || {};
      var corpayVendorId = vendor.id;
      var name = String((detail && detail.name) || vendor.name || '').trim();
      if (!name || corpayVendorId === null || corpayVendorId === undefined || corpayVendorId === '') {
        return { skip: 'vendor "' + corpayName + '" has no name/id to auto-create from' };
      }
      var externalId = 'corpay-vendor-' + corpayVendorId;
      var identification = (detail && detail.identification) || '';
      var email = (detail && detail.email) || '';

      var newId;
      var created = false;
      try {
        var rec = record.create({ type: record.Type.VENDOR, isDynamic: true });
        rec.setValue({ fieldId: 'externalid', value: externalId });
        rec.setValue({ fieldId: 'companyname', value: name });
        rec.setValue({ fieldId: 'isperson', value: false });
        rec.setValue({ fieldId: 'subsidiary', value: p.subsidiary });
        if (identification) { rec.setValue({ fieldId: 'vatregnumber', value: String(identification) }); }
        if (email) { rec.setValue({ fieldId: 'email', value: email }); }
        // Bank/payment details are intentionally omitted: payments flow from Corpay, not NetSuite.
        newId = rec.save({ enableSourcing: true, ignoreMandatoryFields: true });
        created = true;
      } catch (e) {
        // A concurrent run / retry may have already created this vendor: the externalid unique
        // index rejects the duplicate. Resolve to the existing record instead of failing.
        var existing = findVendorByExternalId(externalId);
        if (existing) {
          newId = existing;
          log.audit('NOTE', 'vendor "' + name + '" already existed (ns id ' + newId
            + ') — reusing (duplicate externalid on create)');
        } else {
          throw e;
        }
      }

      if (created) {
        log.audit('CREATED', 'vendor "' + name + '" in NetSuite (ns id ' + newId + ')');
      }
      // Keep the per-run cache consistent so a later document for the same vendor matches in-memory.
      vendorList().push({ id: String(newId), companyname: name, vatregnumber: identification });
      stampVendorExternalId(p, corpayVendorId, newId);
      return { id: String(newId), created: created };
    }

    // ---------------------------------------------------------------- record building

    // Corpay lines are GROSS (VAT-inclusive) splits of the payable total. Each line is posted as
    // `grossamt` with the default tax code, so NetSuite back-computes the net and the bill total
    // equals the Corpay amount. (Net `amount` + a tax code would add VAT on top and leave every
    // bill ~25% open after the matching payment.)
    function addExpenseLine(rec, account, gross, taxcode, note) {
      rec.selectNewLine({ sublistId: 'expense' });
      rec.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'account', value: account });
      rec.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'grossamt', value: gross });
      if (taxcode) {
        rec.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'taxcode', value: taxcode });
      }
      if (note) {
        rec.setCurrentSublistValue({ sublistId: 'expense', fieldId: 'memo', value: note });
      }
      rec.commitLine({ sublistId: 'expense' });
    }

    // Tax code by expense currency (EUR override for e.g. EU reverse charge), else default.
    function taxcodeFor(expense, p) {
      var cur = expense.currency ? String(expense.currency).toUpperCase() : '';
      return (cur === 'EUR' && p.taxcodeEur) ? p.taxcodeEur : p.defaultTaxcode;
    }

    // The bill total MUST equal expense.amount — the payment applies exactly that — so line
    // splits are used only when they reconcile: zero lines are dropped, and if a line is
    // negative or the sum differs from the header amount, ONE header-total line is booked
    // instead (logged loudly) rather than wrong money.
    function addExpenseLines(rec, expense, p) {
      var taxcode = taxcodeFor(expense, p);
      var headerAccount = resolveAccount(expense.category, p);
      var all = Array.isArray(expense.lines) ? expense.lines : [];
      var lines = all.filter(function (l) { return Number(l.amount || 0) !== 0; });

      if (lines.length > 0) {
        var sumMinor = all.reduce(function (s, l) { return s + Number(l.amount || 0); }, 0);
        var anyNegative = lines.some(function (l) { return Number(l.amount) < 0; });
        if (!anyNegative && sumMinor === Number(expense.amount)) {
          lines.forEach(function (l) {
            var account = resolveAccount(l.category, p);
            addExpenseLine(rec, account, money(l.amount), taxcode, l.note);
          });
          return;
        }
        log.audit('WARN', expense.id + ': line splits '
          + (anyNegative ? 'contain negative amounts'
            : 'sum ' + money(sumMinor) + ' != total ' + money(expense.amount))
          + ' — booking single header-total line');
      }
      // No usable lines: a single line from the header category for the full (gross) amount.
      addExpenseLine(rec, headerAccount, money(expense.amount), taxcode, null);
    }

    function removeAllExpenseLines(rec) {
      var count = rec.getLineCount({ sublistId: 'expense' });
      for (var i = count - 1; i >= 0; i--) {
        rec.removeLine({ sublistId: 'expense', line: i });
      }
    }

    // Upsert a vendor bill (kind='bill') or vendor credit (kind='credit'). Returns the internal id.
    // On UPDATE all existing expense lines are removed first, then re-added — this prevents line
    // duplication/merge across runs. Currency is intentionally left to default from the vendor.
    function upsertBillOrCredit(p, expense, kind, vendorId) {
      var type = kind === 'bill' ? record.Type.VENDOR_BILL : record.Type.VENDOR_CREDIT;
      var externalId = eid(kind, expense.id);
      var existingId = findByExternalId(externalId);

      var rec;
      if (existingId) {
        rec = record.load({ type: type, id: existingId, isDynamic: true });
        removeAllExpenseLines(rec);
      } else {
        rec = record.create({ type: type, isDynamic: true });
      }

      rec.setValue({ fieldId: 'externalid', value: externalId });
      rec.setValue({ fieldId: 'entity', value: vendorId });
      rec.setValue({ fieldId: 'subsidiary', value: p.subsidiary });
      var tranDate = toDate(expense.referenceDate);
      if (tranDate) { rec.setValue({ fieldId: 'trandate', value: tranDate }); }
      var dueDate = toDate(expense.dueDate);
      if (dueDate) { rec.setValue({ fieldId: 'duedate', value: dueDate }); }
      rec.setValue({
        fieldId: 'tranid',
        // Falls back to the Corpay expense id so tranid is never blank (some accounts
        // reject an empty Reference No.).
        value: String(expense.reference || expense.number || expense.id).slice(0, 45)
      });
      rec.setValue({ fieldId: 'memo', value: 'Corpay One expense ' + expense.id });
      // approvalstatus (2 = Approved) exists only on vendorBill — Corpay is the approval system
      // of record. vendorCredit has no such field.
      if (kind === 'bill') { rec.setValue({ fieldId: 'approvalstatus', value: 2 }); }

      addExpenseLines(rec, expense, p);

      // ignoreMandatoryFields keeps form-level mandatory custom fields (Staria / e-invoicing
      // localization) from blocking the save — matching how the REST variant posts. See README.
      return rec.save({ enableSourcing: true, ignoreMandatoryFields: true });
    }

    // Create the vendor payment for a just-upserted bill via transform (pre-populates the apply
    // sublist from the source bill). The caller has already confirmed no payment exists yet.
    function createPayment(p, expense, billId) {
      var pay = record.transform({
        fromType: record.Type.VENDOR_BILL,
        fromId: billId,
        toType: record.Type.VENDOR_PAYMENT,
        isDynamic: true
      });

      var cur = expense.currency ? String(expense.currency).toUpperCase() : '';
      var bank = (cur === 'EUR' && p.bankAccountEur) ? p.bankAccountEur : p.bankAccount;
      pay.setValue({ fieldId: 'account', value: bank });
      var payDate = toDate(expense.paymentDate);
      if (payDate) { pay.setValue({ fieldId: 'trandate', value: payDate }); }
      pay.setValue({ fieldId: 'externalid', value: eid('pay', expense.id) });
      pay.setValue({ fieldId: 'memo', value: 'Corpay One payment ' + expense.id });

      // Verify/force the apply line for THIS bill: checked, full amount. `doc` on the apply
      // sublist holds the internal id of the applied transaction (matches the REST apply.doc.id).
      var amount = money(expense.amount);
      var count = pay.getLineCount({ sublistId: 'apply' });
      for (var i = 0; i < count; i++) {
        var docId = pay.getSublistValue({ sublistId: 'apply', fieldId: 'doc', line: i });
        if (String(docId) === String(billId)) {
          pay.selectLine({ sublistId: 'apply', line: i });
          pay.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'apply', value: true });
          pay.setCurrentSublistValue({ sublistId: 'apply', fieldId: 'amount', value: amount });
          pay.commitLine({ sublistId: 'apply' });
        }
      }
      return pay.save({ enableSourcing: true, ignoreMandatoryFields: true });
    }

    // Emit a single-key outcome so summarize can tally it. Keys are unique (outcome + id) so no
    // two writes ever collide; the value is the canonical stat name.
    function record_outcome(context, outcome, id) {
      context.write({ key: outcome + ':' + id, value: outcome });
    }

    // ---------------------------------------------------------------- Map/Reduce stages

    function getInputData() {
      var p = params();
      resetCaches();

      // Validate the account/subsidiary configuration before any listing. A misconfiguration
      // fails the run once, loudly, with an actionable message — not per-document noise.
      try {
        preflight(p);
      } catch (e) {
        log.error('PREFLIGHT', (e && e.message) || e);
        throw e;
      }

      var cutoffMs = p.lookbackDays > 0 ? Date.now() - p.lookbackDays * 86400000 : null;
      var billIds = listExpenseIds(p, 'Bill', cutoffMs);
      var creditIds = listExpenseIds(p, 'Creditnote', cutoffMs);
      var out = [];
      billIds.forEach(function (id) { out.push({ id: id, kind: 'bill' }); });
      creditIds.forEach(function (id) { out.push({ id: id, kind: 'credit' }); });

      // Reversal check: cancelled/refunded expenses that were already synced would otherwise
      // sit in NetSuite as approved payables forever. They are surfaced as warnings in map —
      // posted financials are never deleted automatically.
      var reversalStates = ['Cancelled', 'Refunded'];
      listExpenseIds(p, 'Bill', cutoffMs, reversalStates).forEach(function (id) {
        out.push({ id: id, kind: 'bill', reversal: true });
      });
      listExpenseIds(p, 'Creditnote', cutoffMs, reversalStates).forEach(function (id) {
        out.push({ id: id, kind: 'credit', reversal: true });
      });

      log.audit('getInputData', 'states=' + p.states.join(',')
        + ' lookback=' + (p.lookbackDays ? p.lookbackDays + 'd' : 'unlimited')
        + ' bills=' + billIds.length + ' credits=' + creditIds.length
        + ' reversal-candidates=' + (out.length - billIds.length - creditIds.length));
      return out;
    }

    function map(context) {
      var item = JSON.parse(context.value);
      var id = item.id;
      var kind = item.kind;
      var p = params();
      try {
        // Reversal candidate: cancelled/refunded in Corpay. If it still exists in NetSuite,
        // surface it loudly for manual reversal — never auto-delete posted financials.
        if (item.reversal) {
          var existing = findByExternalId(eid(kind, id));
          if (existing) {
            log.audit('WARN', kind + ' ' + id + ': cancelled/refunded in Corpay but NetSuite '
              + 'record ' + existing + ' still exists — reverse manually');
            record_outcome(context, 'warnings', id);
          }
          return;
        }

        var expense = getExpense(p, id);
        if (!expense) {
          log.audit('SKIP', kind + ' ' + id + ': no detail payload');
          record_outcome(context, 'skipped', id);
          return;
        }
        var vres = resolveVendor(p, expense);
        if (vres.skip) {
          log.audit('SKIP', kind + ' ' + id + ': ' + vres.skip);
          record_outcome(context, 'skipped', id);
          return;
        }
        var vendorId = vres.id;
        // A freshly auto-created vendor is tallied as its own outcome (and already stamped back).
        if (vres.created) { record_outcome(context, 'vendors', id); }

        var payable = kind === 'bill' && isPaid(expense);

        // For a paid bill the FIRST NetSuite lookup is the payment-existence check. If the payment
        // exists the bill is SETTLED, so we skip the bill upsert entirely (never mutate a paid
        // bill; a later Corpay edit could otherwise make the update fail forever).
        if (payable && findByExternalId(eid('pay', id))) {
          log.audit('SETTLED', eid('bill', id) + ' — payment exists, skipping');
          record_outcome(context, 'settled', id);
          return;
        }

        var billId = upsertBillOrCredit(p, expense, kind, vendorId);
        record_outcome(context, kind === 'bill' ? 'bills' : 'credits', id);
        log.audit(kind === 'bill' ? 'BILL' : 'CREDIT',
          eid(kind, id) + ' upserted (ns id ' + billId + ')');

        if (payable) {
          var payId = createPayment(p, expense, billId);
          record_outcome(context, 'payments', id);
          log.audit('PAY', eid('pay', id) + ' created (ns id ' + payId + ')');
        }
      } catch (e) {
        // Per-expense isolation: one bad document never kills the run.
        log.error('ERROR ' + kind + ' ' + id, (e && e.message) || e);
        record_outcome(context, 'errors', id);
      }
    }

    function summarize(summary) {
      var totals = { bills: 0, credits: 0, payments: 0, vendors: 0, settled: 0, skipped: 0, warnings: 0, errors: 0 };
      summary.output.iterator().each(function (key, value) {
        if (totals.hasOwnProperty(value)) { totals[value] += 1; }
        return true;
      });

      // Uncaught map/reduce errors are reported here too, in addition to the caught ones above.
      var errorLines = [];
      summary.mapSummary.errors.iterator().each(function (key, err) {
        totals.errors += 1;
        errorLines.push(key + ': ' + err);
        log.error('MAP ERROR ' + key, err);
        return true;
      });

      var line = 'bills=' + totals.bills + ' credits=' + totals.credits
        + ' payments=' + totals.payments + ' vendors=' + totals.vendors
        + ' settled=' + totals.settled + ' skipped=' + totals.skipped
        + ' warnings=' + totals.warnings + ' errors=' + totals.errors;
      log.audit('SUMMARY', line);

      if (totals.errors > 0) {
        var p = params();
        if (p.notifyEmail) {
          try {
            email.send({
              author: runtime.getCurrentUser().id,
              recipients: p.notifyEmail,
              subject: 'Corpay One -> NetSuite sync: ' + totals.errors + ' error(s)',
              body: 'Corpay One -> NetSuite Map/Reduce sync finished with errors.\n\n'
                + line + '\n\n' + (errorLines.join('\n') || '(see the script Execution Log)')
            });
          } catch (e) {
            // Never let a notification failure fail the whole job.
            log.error('summary email failed', (e && e.message) || e);
          }
        }
      }
    }

    return {
      getInputData: getInputData,
      map: map,
      summarize: summarize
    };
  });
