# Corpay One → NetSuite sync

A maximally simple, one-way integration that pushes financial documents from
**Corpay One** into **NetSuite**. Plain Node.js (>= 18), ESM, **zero npm
dependencies** (native `fetch`, `node:crypto` for OAuth 1.0a signing).

It runs as a one-shot: `node sync.js` does one full pass and exits. Schedule it
with cron / Task Scheduler.

## What it does (three record flows)

On each pass it reads Corpay One expenses and upserts into NetSuite:

| Corpay One | NetSuite record | External id | Notes |
|---|---|---|---|
| Expense `Type=Bill` | Vendor Bill | `corpay-bill-{id}` | `PUT eid:` upsert; `approvalStatus=Approved` |
| Expense `Type=Creditnote` | Vendor Credit | `corpay-credit-{id}` | `PUT eid:` upsert; left **unapplied** (stays open on the vendor). No `approvalStatus` — that field exists only on bills |
| Bill that is paid (`state=Paid` / `friendlyStatus` `Paid`/`MarkedAsPaid`, with a `paymentDate`) | Vendor Payment | `corpay-pay-{id}` | Created once, **never updated**; applied to the bill it belongs to |

### Amounts are gross (VAT-inclusive)

Corpay amounts are the **payable invoice total** including VAT; lines are gross
splits of it. Each line is posted as **`grossAmt`** with a tax code, so NetSuite
back-computes the net and the **bill total equals the Corpay amount**. (Posting
the net `amount` + a tax code would make NetSuite add VAT on top, overshooting
the payable and leaving every bill ~25 % open after its payment.) Minor units
(øre/cents) are converted to major units (divided by 100). The DK legacy tax
engine makes line-level tax codes effectively mandatory; the code used is
`NS_TAX_CODE_ID_<CUR>` for the expense's currency when set, otherwise
`NS_DEFAULT_TAX_CODE_ID`.

**The bill total must always equal the payment amount**, so line splits are only
trusted when they reconcile: zero-amount lines are dropped, and if any line is
negative or the splits do not sum exactly to the header amount, the bill is
booked as **one header-total line** instead (logged as `WARN`). Bill/credit
upserts send `?replace=expense` so a re-upsert **replaces** the expense sublist
— NetSuite's REST default would otherwise append the lines again on every run.

### Settled bills are skipped

For a paid bill the first NetSuite call each run is a payment-existence check. If
the payment already exists the bill is **settled** — it is logged as
`SETTLED corpay-bill-{id}` and **not re-upserted** (counted under `settled`, not
`bills`). This avoids a pointless write per settled bill per run and, more
importantly, stops mutating a bill after it has been paid (a later Corpay edit
could otherwise make the PUT fail forever). Unpaid/booked bills and open credits
keep being upserted every run — that is the update mechanism.

Check / virtual-card settlements (`friendlyStatus` `CheckIssued` / `VccIssued`)
are not yet `Paid`, so no payment is created for them; the next run that sees
Corpay transition the expense to `Paid` creates it. This self-heals via polling.

### Cancelled/refunded expenses raise warnings

Each pass also lists `Cancelled`/`Refunded` expenses (within the lookback
window). If such an expense **still exists in NetSuite**, it is surfaced as
`WARN ... reverse manually` and counted under `warnings`. Posted financials are
never deleted or voided automatically — reversing is a human decision.

## Setup

### 1. Corpay One developer app

1. Create a client at <https://app.corpayone.com/developers>.
2. Grant scopes: `expenses.list`, `expenses.read`, `teams.vendors.read`.
3. Authenticate one of two ways:
   - **`CORPAY_TOKEN`** – a ready Bearer JWT (wins if set), or
   - **refresh-token grant** – set `CORPAY_CLIENT_ID`, `CORPAY_CLIENT_SECRET`,
     `CORPAY_REFRESH_TOKEN` (and optionally `CORPAY_IDENTITY_URL`); the tool
     exchanges them for an access token at `{CORPAY_IDENTITY_URL}/connect/token`.
4. Find your **Team id** (`CORPAY_TEAM_ID`).

### 2. Vendor mapping — the `externalId` convention (required)

The tool does **not** create or match vendors. For every Corpay vendor you want
to sync, the **NetSuite vendor internal id must be stamped as the Corpay
vendor's `externalId`**. Any bill/credit whose vendor has a missing or
non-numeric `externalId` is **skipped** (logged, counted, pass continues).

Stamp it via the Corpay UI, or the API:

```
PATCH /external/v2/teams/{teamId}/vendors/{vendorId}/external-id
{ "source": "netsuite", "externalId": "742" }
```

### 3. NetSuite integration + Token-Based Authentication (TBA)

1. Enable **Token-Based Authentication** (Setup → Company → Enable Features →
   SuiteCloud) and **REST Web Services**.
2. Create an **Integration record** (consumer key + secret).
3. Create an **Access Token** for a user + role (token id + secret).
4. The role needs permissions: **Vendor Bills**, **Vendor Credits**, **Vendor
   Payments** (Create/Edit), plus **REST Web Services** and **Log in using
   Access Tokens**.
5. Collect the account id (e.g. `1234567` or `1234567_SB1`) and the posting
   defaults below.

## Environment variables

Copy `.env.example` to `.env` (git-ignored) or export them in the environment.
On startup, `process.env` is used first; a `.env` file in the working directory
fills in anything missing.

| Variable | Required | Default | Description |
|---|---|---|---|
| `CORPAY_BASE_URL` | no | `https://api.corpayone.com/external` | Corpay API base |
| `CORPAY_TEAM_ID` | **yes** | – | Corpay team id |
| `CORPAY_TOKEN` | one of | – | Bearer JWT (wins if set) |
| `CORPAY_CLIENT_ID` | one of | – | For refresh-token grant |
| `CORPAY_CLIENT_SECRET` | one of | – | For refresh-token grant |
| `CORPAY_REFRESH_TOKEN` | one of | – | For refresh-token grant |
| `CORPAY_IDENTITY_URL` | no | `https://identity.corpayone.com` | Token endpoint host |
| `CORPAY_SYNC_STATES` | no | `Booked,Initialized,Paid` | Comma-separated states to pull |
| `CORPAY_LOOKBACK_DAYS` | no | `90` | Only sync expenses whose `paymentDate`/`referenceDate` is within the last N days. `0` = unlimited (scan all history). Bounds runtime as history grows |
| `NS_ACCOUNT_ID` | **yes** | – | e.g. `1234567_SB1` |
| `NS_CONSUMER_KEY` | **yes** | – | TBA integration consumer key |
| `NS_CONSUMER_SECRET` | **yes** | – | TBA integration consumer secret |
| `NS_TOKEN_ID` | **yes** | – | TBA access token id |
| `NS_TOKEN_SECRET` | **yes** | – | TBA access token secret |
| `NS_SUBSIDIARY_ID` | **yes** | – | Posting subsidiary internal id |
| `NS_AP_ACCOUNT_ID` | **yes** | – | AP control account internal id |
| `NS_BANK_ACCOUNT_ID` | **yes** | – | Default bank account for payments |
| `NS_DEFAULT_EXPENSE_ACCOUNT_ID` | **yes** | – | Fallback GL account for lines |
| `NS_DEFAULT_TAX_CODE_ID` | **yes** | – | Tax code applied to lines (unless overridden per currency) |
| `NS_BANK_ACCOUNT_ID_<CUR>` | no | – | Per-currency bank override, e.g. `NS_BANK_ACCOUNT_ID_EUR=341` |
| `NS_CURRENCY_ID_<CUR>` | no | – | NetSuite currency internal id per ISO code, e.g. `NS_CURRENCY_ID_DKK=1`, `NS_CURRENCY_ID_EUR=4`. Mapped currencies are set explicitly on bills **and** payments; unmapped ones fall back to the vendor default currency + default bank |
| `NS_TAX_CODE_ID_<CUR>` | no | – | Tax code override per currency, e.g. `NS_TAX_CODE_ID_EUR=149` (EU reverse charge) |

Missing required variables cause an immediate fail-fast with a listed message.

## Run

```bash
npm run sync      # one full pass
npm test          # offline unit tests (stubbed fetch, no network)
```

The process exits `1` if any expense errored during the pass, otherwise `0`.
The final line is a summary, e.g.
`SUMMARY bills=12 credits=1 payments=4 settled=8 skipped=2 warnings=0 errors=0`
(`settled` = paid bills skipped because their payment already exists;
`warnings` = cancelled/refunded expenses still present in NetSuite).

Transient Corpay failures (network, 429, 5xx) are retried once; a `401` from an
expired token triggers **one automatic re-acquire** via the refresh-token grant
when `CORPAY_CLIENT_ID`/`SECRET`/`REFRESH_TOKEN` are configured. A static
`CORPAY_TOKEN` alone cannot self-heal an expiry — prefer configuring the
refresh credentials for unattended runs.

### Automatic vs manual runs

There is no daemon and no webhooks — every run is a one-shot `node sync.js`,
so **manual mode is the default**: run it whenever you want.

For automatic runs, pick one:

- **GitHub Actions** (`.github/workflows/sync.yml`): the repository variable
  `SYNC_ENABLED` is the switch. `SYNC_ENABLED=true` → runs automatically every
  15 minutes *and* on demand; unset/anything else → **manual only** via the
  Actions tab → *Corpay One → NetSuite sync* → **Run workflow**. Toggle the
  variable at any time — no code change needed.
- **cron**: add the line below for automatic runs; remove it to go back to
  manual-only.

```cron
*/15 * * * * cd /path/to/corpay-netsuite-sync && /usr/bin/node sync.js >> sync.log 2>&1
```

## Idempotency

- Unpaid bills and credits use NetSuite **`eid:` upserts** (`PUT .../eid:corpay-bill-{id}`):
  creating if absent, updating if present. Re-running a pass is harmless and
  keeps NetSuite in step with Corpay.
- Payments are created **once and never updated**. For a paid bill each pass
  first checks `GET .../vendorPayment/eid:corpay-pay-{id}`; if it exists the bill
  is **settled** and skipped without re-writing it (see *Settled bills are
  skipped* above). This avoids ever mutating a settled bill or payment.

## Limitations

- **Polling, not webhooks.** The tool lists expenses per `CORPAY_SYNC_STATES`
  (within `CORPAY_LOOKBACK_DAYS`) on each run; there is no push/webhook or
  incremental cursor.
- **Credits are left unapplied** — vendor credits are posted open on the
  vendor's AP; apply them to bills manually in NetSuite.
- **No FX or partial payments.** Amounts are taken from `expense.amount` in the
  expense currency and the payment applies the full amount — FX conversions and
  partial settlements are not modelled. Currencies mapped via
  `NS_CURRENCY_ID_<CUR>` are set explicitly on bills and payments (and may use a
  matching `NS_BANK_ACCOUNT_ID_<CUR>` bank); unmapped currencies fall back to
  the vendor's default currency and the default bank account, so keep each
  Corpay vendor's currency aligned with its NetSuite vendor record.
- **Closed posting periods surface as errors.** A bill dated in a
  closed/locked NetSuite period fails; it is logged as `ERROR` and left for
  manual handling (the run still exits `1`).
- No local state/database — idempotency lives entirely in NetSuite external ids.
