# Corpay One → NetSuite sync — NetSuite-resident variant

A single **SuiteScript 2.1 Map/Reduce** script (`corpay_sync_mr.js`) that runs the entire
Corpay One → NetSuite sync **inside NetSuite** — no external server, no cron host, no stored
credentials outside NetSuite. It is functionally equivalent to the external Node variant
(`../sync.js`): same business logic, same external-id conventions, so the two never create
duplicates and you can switch between them freely (but **never run both schedules at once** —
see the comparison table at the bottom).

Design goals (customer): *må ikke fejle* (must not fail), *skal være nemt* (must be easy),
*skal bo i NetSuite* (must live in NetSuite).

## What it does

On each scheduled run:

| Corpay One | NetSuite record | External id | Notes |
|---|---|---|---|
| Expense `Type=Bill` | Vendor Bill | `corpay-bill-{id}` | upsert (search by external id → load+update, else create); `approvalstatus = Approved` |
| Expense `Type=Creditnote` | Vendor Credit | `corpay-credit-{id}` | upsert; left **unapplied** (open on the vendor); no `approvalstatus` (that field exists only on bills) |
| Bill that is paid (`state=Paid` / `friendlyStatus` `Paid`/`MarkedAsPaid`, with a `paymentDate`) | Vendor Payment | `corpay-pay-{id}` | created once via `record.transform`, applied to its bill; never updated |

- **Amounts are gross (VAT-inclusive).** Corpay amounts are int64 minor units (øre/cents). Each
  line is posted as **`grossamt`** with the default tax code, so NetSuite back-computes the net
  and the bill total equals the Corpay payable. (Net `amount` + a tax code would add VAT on top
  and leave every bill ~25 % open after its payment.) The DK legacy tax engine makes line-level
  tax codes effectively mandatory, so every line carries the default tax code.
- **Settled bills are skipped.** For a paid bill the first NetSuite lookup is the payment-existence
  check (`corpay-pay-{id}`). If that payment already exists the bill is *settled* → logged as
  `SETTLED`, and the bill upsert is skipped entirely (never mutate a paid bill). Unpaid bills and
  open credits are re-upserted every run — that is the update mechanism.
- **Self-healing.** Check / virtual-card settlements (`CheckIssued` / `VccIssued`) are not yet
  `Paid`, so no payment is created; a later run creates it once Corpay transitions to `Paid`.

## Deployment

### 1. Enable features
Setup → Company → **Enable Features**:
- **SuiteCloud → SERVER SIDE SCRIPTING** (required to run SuiteScript).
- **SuiteCloud → API SECRETS** (recommended — lets the Corpay token be stored as a secret and
  never logged; see step 2). If your account does not have this feature, use the plain-text token
  parameter instead (step 5).

### 2. Store the Corpay token as an API Secret (recommended)
Setup → Company → Preferences → **API Secrets** → *New*:
- Give it a **Script ID**, e.g. `custsecret_corpay_token`.
- **Value** = the Corpay Bearer token (the raw JWT, without the word `Bearer`).
- **Restrict to this script** once the script record exists (step 4).

The script builds the Authorization header via
`https.createSecureString({ input: 'Bearer {custsecret_corpay_token}' })` — NetSuite substitutes
the secret server-side at request time, so the token **never appears in the Execution Log**.

### 3. Upload the script file
Documents → Files → **SuiteScripts** → upload `corpay_sync_mr.js`.

### 4. Create the Script record
Customization → Scripting → Scripts → **New** → select the uploaded file →
type **Map/Reduce**. Add the **Script Parameters** below (Parameters subtab). Save.

### 5. Script parameters
Set these on the Script record (defaults come from the deployment). Real internal ids for this
account (Omnit ApS) are pre-filled — verify before go-live.

| Parameter ID | Type | Required | Value / default for this account |
|---|---|---|---|
| `custscript_cp_base_url` | Free-Form Text | no | `https://api.corpayone.com/external` (default) |
| `custscript_cp_token_secret` | Free-Form Text | one of | API Secret script id, e.g. `custsecret_corpay_token` — **preferred** |
| `custscript_cp_token_plain` | Password / Free-Form Text | one of | raw Corpay Bearer token — fallback when API Secrets is unavailable |
| `custscript_cp_team_id` | Free-Form Text | **yes** | Corpay team id |
| `custscript_cp_states` | Free-Form Text | no | `Booked,Initialized,Paid` (default) |
| `custscript_cp_lookback_days` | Integer | no | `90` (default; `0` = unlimited, scan all history) |
| `custscript_cp_subsidiary` | Free-Form Text | **yes** | `10` (Omnit ApS) |
| `custscript_cp_ap_account` | Free-Form Text | **yes** | `114` (4101 Kreditorer) |
| `custscript_cp_bank_account` | Free-Form Text | **yes** | `340` (4301 Driftskonto, DKK) |
| `custscript_cp_bank_account_eur` | Free-Form Text | no | `341` (4302 Indlån EUR) — used when the expense currency is EUR |
| `custscript_cp_default_expense_acct` | Free-Form Text | **yes** | fallback GL account when a line/header category has no numeric external id |
| `custscript_cp_default_taxcode` | Free-Form Text | **yes** | `18` (S-DK standard 25% moms) |
| `custscript_cp_taxcode_eur` | Free-Form Text | no | `149` (ESSP-DK EU reverse charge) — tax code used for EUR expenses instead of the default; without it, EUR bills book Danish 25% input VAT |
| `custscript_cp_vendor_automatch` | Free-Form Text | no | vendor auto-match toggle. Empty/anything except `false` = **enabled** (default); `false` = disabled (only vendors with a numeric `externalId` sync, as before). See *How mapping is resolved* |
| `custscript_cp_vendor_autocreate` | Free-Form Text | no | vendor auto-**create** toggle. Empty/anything except `false` = **enabled** (default); `false` = disabled. When enabled and auto-match finds **no** candidate (no CVR and no exact-name hit — an *ambiguous* name never auto-creates), the vendor is created in NetSuite so the document posts the same run. Requires `custscript_cp_vendor_automatch` on. See *How mapping is resolved* |
| `custscript_cp_notify_email` | Free-Form Text | no | ops email; a single summary email is sent only when a run has errors |

> The token: set **either** `custscript_cp_token_secret` (preferred) **or**
> `custscript_cp_token_plain`. If both are set, the secret wins.

### 6. Create the Deployment
On the Script record → Deployments → **New**:
- **Status** — this is the automatic/manual switch, changeable at any time:
  - `Scheduled` → runs automatically on the schedule below;
  - `Not Scheduled` → **manual only**: open the deployment and use **Save & Execute**
    (or the *Execute Now* action) whenever you want a run. Nothing runs by itself.
- **Schedule** (only relevant when Status = `Scheduled`): every **15 minutes**
  (Repeat → Every 15 minutes; or a Daily event repeating every 15 min, depending on your UI).
- **Concurrency**: **1** (single queue). This variant is designed to run one instance at a time —
  do not raise concurrency.
- **Log Level**: `Audit` (so the per-document `BILL` / `CREDIT` / `PAY` / `SETTLED` / `SKIP` lines
  and the final `SUMMARY` line are visible; errors always log at `Error`).
- **Execute As Role**: a role/user that has an email address (needed for the error-notification
  email in step 5) and the permissions below.

### 7. Role / permissions
The *Execute As* role needs:
- **Transactions**: Vendor Bill, Vendor Credit, Vendor Payment — *Create* and *Edit* (Full).
- **Lists**: Vendors, Accounts, Tax Records/Items, Subsidiaries — at least *View*.
- **Setup**: *SuiteScript* (to run scripts). If using `createSecureString`, no extra permission is
  needed beyond access to the restricted secret.
- Access to outbound HTTPS to `api.corpayone.com` is allowed by default for server scripts.

### 8. Vendor mapping (automatic — no manual stamping needed)
Out of the box the script **auto-matches** each Corpay vendor to a NetSuite vendor (see *How
mapping is resolved*) and, on a match, **stamps the NetSuite internal id back** onto the Corpay
vendor's `externalId` (`PATCH /external/v2/teams/{teamId}/vendors/{vendorId}/external-id` with
`{ "source": "netsuite", "externalId": "742" }`), so subsequent runs resolve it instantly. You do
**not** have to pre-stamp vendors by hand.

- The stamp-back is **best-effort**: it requires the Corpay **`teams.vendors` write** scope
  (`teams.vendors.all` / `teams.vendors.create`). Without it the PATCH fails, is logged as a
  `NOTE`, and the run continues — the vendor is still matched, it just re-matches from cache on the
  next run instead of resolving instantly.
- When auto-match finds **no** candidate at all (no CVR hit **and** no exact-name hit), the script
  **auto-creates** the vendor in NetSuite (`custscript_cp_vendor_autocreate`, on by default) so the
  booked Corpay document can post in the same run. The new vendor is created with
  `externalid = corpay-vendor-{corpayVendorId}` (the idempotency key — a retry or an overlapping run
  resolves to the same record via the externalid unique index), `companyname`, `isperson = false`,
  the deployment's `subsidiary`, and — when Corpay supplies them — `vatregnumber` (CVR/VAT) and
  `email`. Its internal id is then stamped back to Corpay exactly like a match. Created vendors carry
  **name / CVR / email / subsidiary only** — no bank or payment details, because payments flow from
  Corpay, not NetSuite. Review each auto-created vendor for completeness (payment terms, default
  category/expense account, 1099/e-invoicing fields, etc.) as part of normal AP hygiene.
- **Duplicate risk.** A NetSuite vendor that already exists **under a different name and without a
  CVR number** will not be matched (nothing to match on), so auto-create will make a **duplicate**.
  To prevent this, **keep the CVR/VAT number (`vatregnumber`) populated on your NetSuite vendors** —
  CVR matches regardless of name differences. An *ambiguous* name (several NetSuite vendors share the
  name) is deliberately **never** auto-created — that would guarantee a duplicate — it is skipped
  instead so you can disambiguate or stamp the `externalId`.
- Set `custscript_cp_vendor_automatch = false` to turn matching (and therefore auto-create) off;
  then only vendors whose Corpay `externalId` already holds a numeric NetSuite id sync, and
  everything else is skipped (the pre-auto-match behaviour). To keep matching but **disable
  auto-create only**, set `custscript_cp_vendor_autocreate = false`: unmatched vendors are then
  skipped with an actionable `SKIP` line telling you to set the `externalId`, and no vendor records
  are created.

## How mapping is resolved

Every run resolves three things per document, each as a short fallback chain:

- **Vendor** (`externalId` → CVR → exact name → auto-create / skip):
  1. numeric Corpay `vendor.externalId` → used directly as the NetSuite vendor internal id;
  2. else (auto-match on) **CVR/VAT**: digits-only of the Corpay vendor's `identification` vs
     digits-only of each NetSuite vendor's `vatregnumber` — matched only when **exactly one**
     NetSuite vendor matches;
  3. else **exact name**: normalized (lowercase, collapsed whitespace, trimmed) Corpay vendor name
     vs NetSuite `companyname` — matched only when **exactly one** matches; if **several** share the
     name it is **ambiguous → skip** (never auto-created, to avoid a guaranteed duplicate), logged
     with the count so you know whether to disambiguate or just stamp the `externalId`;
  4. else (no candidate at all) **auto-create** the vendor in NetSuite when
     `custscript_cp_vendor_autocreate` is on (default) — created with name / CVR / email / subsidiary
     and `externalid = corpay-vendor-{corpayVendorId}` (idempotent), then posted the same run; when
     auto-create is off, **skip** the document with an actionable message telling you to set the
     `externalId`.
  On a match **or** an auto-create the internal id is stamped back to Corpay (best-effort, see
  above), and an auto-create is tallied as a `vendors` outcome in the run `SUMMARY`.
- **Expense account** (`externalId` → account number → default):
  1. numeric category `externalId` → used directly as the NetSuite account internal id;
  2. else category **`number`** matched against the NetSuite account **`acctnumber`** (e.g. Corpay
     category number `2201` → account "2201 Lønninger") → that account;
  3. else the **default expense account** (`custscript_cp_default_expense_acct`), logged once per
     category as a `NOTE`.
- **Subsidiary**: **1 Corpay team = 1 NetSuite subsidiary = 1 deployment.** Each deployment posts
  everything to its single `custscript_cp_subsidiary`. A **multi-subsidiary** customer deploys the
  script **once per subsidiary/team pair** (each deployment with its own `custscript_cp_team_id` +
  `custscript_cp_subsidiary` + account parameters).

The NetSuite account and vendor lookups are done with `N/query` SuiteQL, fetched once per run and
cached; the Corpay vendor detail (`GET /external/v2/teams/{teamId}/vendors/{vendorId}`) is fetched
lazily and cached per vendor per run.

## Preflight validation

At the very start of every run (before any Corpay listing), the script validates its
account/subsidiary parameters with one SuiteQL query each and **fails the whole run once, loudly**,
if anything is wrong — rather than emitting the same misconfiguration error on every document. It
checks that: the subsidiary exists; `custscript_cp_ap_account` is an **Accounts Payable** account
(`accttype = AcctPay`); `custscript_cp_bank_account` (and `custscript_cp_bank_account_eur`, if set)
are **Bank** accounts; the default expense account exists; and none of them is inactive. **All**
problems are collected into a single error, e.g.:

```
Preflight validation failed:
  custscript_cp_ap_account=114: not an Accounts Payable account (accttype=Bank)
  custscript_cp_subsidiary=10: subsidiary not found
```

The failure is logged as `log.error('PREFLIGHT', …)` and the Map/Reduce job aborts, so a
misconfigured deployment is obvious in the Execution Log instead of silently producing wrong or
zero output.

## Reading the logs
Script record → **Deployments** → open the deployment → **Execution Log**:
- `Audit` — `getInputData` counts, one line per document (`BILL corpay-bill-… upserted (ns id …)`,
  `CREDIT …`, `PAY …`, `SETTLED …`, `SKIP …`, `WARN …`), any vendor auto-create
  (`CREATED vendor "…" in NetSuite (ns id …)`) and vendor `MATCH …` lines, and a final
  `SUMMARY bills=… credits=… payments=… vendors=… settled=… skipped=… warnings=… errors=…`
  (`vendors` = vendors auto-created this run).
- `WARN` lines need attention but never block the run: **line splits that don't sum to the
  payable** (the document is booked as one header-total line so the bill total always equals the
  payment), and **cancelled/refunded Corpay expenses that still exist in NetSuite** (posted
  financials are never auto-deleted — reverse them manually).
- `Error` — per-document failures (`ERROR bill <id>: <message>`) and any uncaught map errors,
  surfaced again in the summary. A single document failing never stops the run.

## Governance & rate limits
- Map/Reduce **auto-yields** across governance boundaries, so long backlogs finish across
  continuations without hitting the usage-unit ceiling. Rough per-document cost:
  `https.get` ≈ 10 units, `record.save` ≈ 20, `search` ≈ 10, `record.transform` + payment save
  ≈ 20 — comfortably inside limits at lookback-bounded volumes.
- **Concurrency 1** keeps the two Corpay-facing calls per document (list paging in `getInputData`,
  one v3 detail per `map`) serialized. Corpay's soft target is **< 50 req/min**; natural NetSuite
  latency between calls keeps a single-queue run near or below that without explicit sleeping.
- **Residual risk**: a very large *first* backlog (e.g. `lookback = 0` on a big history) issues
  many v3 detail calls in a burst and could approach the Corpay rate ceiling. Start with the
  default 90-day lookback (or smaller) for the first run, then widen if needed.

## Limitations
- **Polling, not webhooks** — lists per `custscript_cp_states` within `custscript_cp_lookback_days`
  each run; no push/webhook, no incremental cursor.
- **Long-lived token required.** This variant expects a long-lived Corpay Bearer token (stored as
  an API Secret or plain parameter). It does **not** run the OAuth refresh-token grant — if your
  Corpay client only issues short-lived tokens, refresh the parameter/secret out of band (or use
  the external `sync.js` variant, which performs the refresh grant).
- **Currency from the vendor default; no FX / partial payments.** No currency id is sent on
  bills/credits, so each Corpay vendor's currency must match its NetSuite vendor record. The
  payment applies the full `expense.amount`; the bank account is picked by currency
  (EUR → `custscript_cp_bank_account_eur`, else `custscript_cp_bank_account`).
- **Credits left unapplied** — vendor credits post open on the vendor's AP; apply them to bills
  manually in NetSuite.
- **Closed posting periods surface as errors** — a bill dated in a closed/locked period fails for
  that document, is logged, and the run continues.
- **`ignoreMandatoryFields: true` on saves.** Chosen deliberately so form-level mandatory custom
  fields from the Danish/Nordic localization bundles (Staria `custbody_sta_*`, e-invoicing
  `custbody_psg_ei_*`) cannot block an otherwise-valid import — matching how the REST variant
  posts. Smoke-test one bill per subsidiary before go-live to confirm nothing critical is skipped.

## This variant vs. the external `sync.js`

Both write the **same records with the same external ids**, so they are drop-in interchangeable
and idempotent against each other. Pick one; **never run both schedules simultaneously** (two
writers racing the same external ids risks duplicate-detection errors and wasted work).

| | NetSuite-resident (`corpay_sync_mr.js`) | External (`sync.js`) |
|---|---|---|
| Runs where | Inside NetSuite (Map/Reduce) | Any Node ≥ 18 host + cron |
| NetSuite auth | Native session (Execute-As role) — no keys stored | OAuth 1.0a TBA keys in `.env` |
| Corpay token | API Secret (server-side, never logged) or plain param | `.env`; supports refresh-token grant |
| NetSuite writes | `N/record` (`create` / `load` / `transform`) | REST `PUT eid:` upsert + `POST` |
| Bill upsert key | search transaction by external id → load/update or create | `PUT /record/v1/vendorBill/eid:corpay-bill-{id}` |
| Payment | `record.transform(vendorBill → vendorPayment)` | `POST /record/v1/vendorPayment` with `apply` |
| Scheduling | NetSuite deployment (every 15 min, concurrency 1) | external cron |
| External ids | `corpay-bill-{id}` / `corpay-credit-{id}` / `corpay-pay-{id}` | **identical** |

### Run the offline tests
```bash
node --check netsuite/corpay_sync_mr.js   # AMD define parses as valid JS
node netsuite/test.js                     # mocked N/* modules, no NetSuite, no network
```
