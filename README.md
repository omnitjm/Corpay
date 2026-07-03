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
| Expense `Type=Bill` | Vendor Bill | `corpay-bill-{id}` | `PUT eid:` upsert |
| Expense `Type=Creditnote` | Vendor Credit | `corpay-credit-{id}` | `PUT eid:` upsert; left **unapplied** (stays open on the vendor) |
| Bill that is paid (`state=Paid` / `friendlyStatus` `Paid`/`MarkedAsPaid`, with a `paymentDate`) | Vendor Payment | `corpay-pay-{id}` | Created once, **never updated**; applied to the bill it belongs to |

Amounts are converted from Corpay minor units (øre/cents) to major units
(divided by 100). Every expense line is posted with the default tax code (the
account uses the DK legacy tax engine, so line-level tax codes are effectively
mandatory).

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
| `NS_ACCOUNT_ID` | **yes** | – | e.g. `1234567_SB1` |
| `NS_CONSUMER_KEY` | **yes** | – | TBA integration consumer key |
| `NS_CONSUMER_SECRET` | **yes** | – | TBA integration consumer secret |
| `NS_TOKEN_ID` | **yes** | – | TBA access token id |
| `NS_TOKEN_SECRET` | **yes** | – | TBA access token secret |
| `NS_SUBSIDIARY_ID` | **yes** | – | Posting subsidiary internal id |
| `NS_AP_ACCOUNT_ID` | **yes** | – | AP control account internal id |
| `NS_BANK_ACCOUNT_ID` | **yes** | – | Default bank account for payments |
| `NS_DEFAULT_EXPENSE_ACCOUNT_ID` | **yes** | – | Fallback GL account for lines |
| `NS_DEFAULT_TAX_CODE_ID` | **yes** | – | Tax code applied to every line |
| `NS_BANK_ACCOUNT_ID_<CUR>` | no | – | Per-currency bank override, e.g. `NS_BANK_ACCOUNT_ID_EUR` |

Missing required variables cause an immediate fail-fast with a listed message.

## Run

```bash
npm run sync      # one full pass
npm test          # offline unit tests (stubbed fetch, no network)
```

The process exits `1` if any expense errored during the pass, otherwise `0`.
The final line is a summary, e.g.
`SUMMARY bills=12 credits=1 payments=4 skipped=2 errors=0`.

### Scheduling (cron)

There is no daemon and no webhooks — scheduling is external. Example crontab
line running every 15 minutes:

```cron
*/15 * * * * cd /path/to/corpay-netsuite-sync && /usr/bin/node sync.js >> sync.log 2>&1
```

## Idempotency

- Bills and credits use NetSuite **`eid:` upserts** (`PUT .../eid:corpay-bill-{id}`):
  creating if absent, updating if present. Re-running a pass is harmless and
  keeps NetSuite in step with Corpay.
- Payments are created **once and never updated**. Each pass first checks
  `GET .../vendorPayment/eid:corpay-pay-{id}`; if it exists the payment is
  skipped. This avoids ever mutating a settled payment.

## Limitations

- **Polling, not webhooks.** The tool lists expenses per `CORPAY_SYNC_STATES` on
  each run; there is no push/webhook or incremental cursor.
- **Credits are left unapplied** — vendor credits are posted open on the
  vendor's AP; apply them to bills manually in NetSuite.
- **Currency is taken from the vendor default.** No currency id is sent on
  bills/credits, so each Corpay vendor's currency must match the currency on its
  NetSuite vendor record. (Payments pick the bank account by currency via
  `NS_BANK_ACCOUNT_ID_<CUR>`, falling back to `NS_BANK_ACCOUNT_ID`.)
- **Closed posting periods surface as errors.** A bill dated in a
  closed/locked NetSuite period fails; it is logged as `ERROR` and left for
  manual handling (the run still exits `1`).
- No local state/database — idempotency lives entirely in NetSuite external ids.
