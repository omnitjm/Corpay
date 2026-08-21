# Corpay One external API — reference

Working reference for this integration, distilled from the **official public OpenAPI specs**
that are committed alongside it in [`corpay-api/`](corpay-api/):

| File | Spec | Paths | Contents |
|---|---|---|---|
| [`corpay-api/swagger-v1.json`](corpay-api/swagger-v1.json) | CorpayOne public API v1 | 23 | **Webhooks** (CRUD + sync logs), legacy endpoints |
| [`corpay-api/swagger-v2.json`](corpay-api/swagger-v2.json) | CorpayOne public API v2 | 26 | Expenses (list), vendors, items, card accounts |
| [`corpay-api/swagger-v3.json`](corpay-api/swagger-v3.json) | CorpayOne public API v3 | 3 | Single-expense detail, card transaction/payment detail |

Re-download the specs any time with:

```bash
for v in v1 v2 v3; do
  curl -sS "https://api.corpayone.com/swagger/public-$v/swagger.json" -o docs/corpay-api/swagger-$v.json
done
```

Browsable Swagger UI: <https://api.corpayone.com/docs/index.html> (staging:
<https://api.staging.corpayone.com/docs/index.html>). The developer portal
(<https://app.corpayone.com/developers>) is login-walled — the specs above are the
authoritative machine-readable source.

Vendor Q&A (March 2026, Corpay One engineering) confirms: staging is a full environment,
aim for **under 50 requests/minute**, webhooks are preferred over polling, expense state
changes are visible in the API immediately, and the **expense id** is the identifier to
store for reconciliation (`creditAccountTransactionId` is US-market only — ignore for DK).

---

## 1. Environments and authentication

| | Production | Staging |
|---|---|---|
| API base | `https://api.corpayone.com/external` | `https://api.staging.corpayone.com/external` |
| Identity (OAuth) | `https://identity.corpayone.com` | `https://identity.staging.corpayone.com` |
| Web app | `https://app.corpayone.com` | `https://web.staging.corpayone.com` |

Two security schemes, identical in all three specs:

- **`oauth2`** — `authorizationCode` flow only (no client-credentials flow in the spec):
  `…/connect/authorize` and `…/connect/token`. Create a client at
  `https://app.corpayone.com/developers`.
- **`Bearer`** — `Authorization: Bearer {jwt}`.

Scopes used by this integration: `expenses.list`, `expenses.read` (or `expenses.all`),
`teams.vendors.read` + a vendor-write scope (`teams.vendors.all` / `teams.vendors.create`)
for the external-id stamp-back, and `webhooks.*` if webhooks are adopted later.

**HTTP status conventions** (per the vendor Q&A — there is no exhaustive error-code list):
`400` invalid input/business-rule error · `403` authorization (wrong scope, not a team
member, deactivated/restricted user) · `404` not found or no access · `429` throttling ·
`500` server error.

---

## 2. Expenses

### `GET /external/v2/expenses` — list (paginated, shallow)

| Query param | Type | Notes |
|---|---|---|
| `TeamId` | string | **required** |
| `Type` | `FinancialDocumentType` | `Bill`, `Receipt`, `Creditnote`, `Reimbursement`, `FuelBill` |
| `State` | `BillStatus` | see §4 |
| `Offset` | int32 ≥ 0 | |
| `Count` | int32 | **min 10, max 100** |
| `IncludeInactive`, `IncludeArchived`, `PendingUserApproval` | bool | |

Response envelope: `{ total, offset, count, data: { bills: [...] }, warnings, requestId }`.

List items are **shallow** — `id`, `number`, `amount`, `currency`, `state`, `referenceDate`,
`issueDate`, `dueDate`, `originalDueDate`, `initializedDate`, `paymentDate`, `category`
(`{id, name, number, parent}`), `vendor` (`{id, name, externalId}`), `owner`, `type`.
No lines, no payment method, no FX. A full sync therefore needs one v3 detail call per id.

### `GET /external/v3/expenses/{expenseId}` — full detail

Returns `{ data: ExpenseResponse }`:

```
id, type, reference, number, amount, originalAmount, currency, originalCurrency,
state (BillStatus), friendlyStatus (ExpenseFriendlyStatus),
referenceDate, issueDate, dueDate, originalDueDate, isDueDateOverwritten,
initializedDate, paymentDate, ripePaymentId,
attachments[], notes[], labels[], departments[], declineReason, isPayable,
paymentMethod { id, type }, category { id, name, number, externalId, parent },
item { id, name, externalId, quantity },
fx { homeAmount, foreignAmount, homeCurrency, foreignCurrency,
     isForeignFixedCurrency, exchangeRate, paymentInstructionType },
creditor { id }, owner { user, team }, vendor { id, name, externalId },
lines: [ { id, category{id,name,number,externalId,parent}, departmentId, department,
           created, amount, note, labels[], item } ]
```

**Amount semantics (load-bearing for this integration):** every `amount` is `int64`
**minor units** (øre/cents) and is **gross — VAT inclusive** (it is the payable total;
`lines[]` are gross splits of it). There is no separate "amount paid" field: settlement is
conveyed by `state`/`friendlyStatus` plus `paymentDate`, `paymentMethod` and `ripePaymentId`.

> Caveat: v3's `ExpenseResponse.type` is an unenumerated nullable string, while the typed
> `FinancialDocumentType` appears only on the v2 list item. This integration therefore
> routes by the **list** `Type` it came from, not the detail field.

### Related expense endpoints (v2)

- `GET /expenses/{id}/links` → `{ links: [ { linkedExpenseId, totalAmount, linkedAmount, currency, state } ] }`
  — **how a credit note is tied to a bill** (scope `expenses.read`).
- `GET /expenses/{id}/activities` → timeline events.
- `GET /expenses/{id}/approvers` → `[ { id } ]`.
- Write endpoints exist (`POST /expenses`, `POST /expenses/generate`, `PATCH …/category`,
  `PATCH …/amountlines`, `PATCH …/approve|decline`, …) but are unused here — this
  integration only reads expenses.

---

## 3. Vendors, categories, payments

**Vendors** (`VendorResponse`: `id, teamVendorId, name, identification, email, address,
country, postal, city, stateProvince, website, externalId, source` — all nullable strings):

- `GET /external/v2/teams/{teamId}/vendors` (optional `ExternalId` filter) → `{ data: [...] }`
- `GET /external/v2/teams/{teamId}/vendors/{vendorId}` → `{ data: {...} }`
- `PATCH /external/v2/teams/{teamId}/vendors/{vendorId}/external-id` with
  `{ "source": "netsuite", "externalId": "742" }` — **the stamp-back this integration uses**
  after auto-matching a vendor. `identification` carries the CVR/VAT number used for matching.
- `POST /external/v2/teams/{teamId}/vendors` can import vendors (unused here).

**Categories (GL accounts)** have no standalone list endpoint — they appear embedded on
expenses as `{ id, name, number, externalId, parent }`. The `number` is the accounting-system
account number, which is why account mapping keys on it (see [MAPPING.md](MAPPING.md)).

**Payments**: there is **no bulk payment endpoint** — payments exist only on top of expenses
in CP1. Payment facts live on the expense (`paymentDate`, `initializedDate`, `paymentMethod`,
`ripePaymentId`, `fx`, `state`/`friendlyStatus`). The `creditaccounts/*` endpoints are the
US card programme — not applicable to DK.

---

## 4. State machine

- **`BillStatus`** (the `state` field and the `State` list filter):
  `Pending`, `Booked`, `Paid`, `Cancelled`, `Awaiting`, `Paused`, `Duplicate`, `Refunded`, `Initialized`
- **`ExpenseFriendlyStatus`** (finer-grained `friendlyStatus`):
  `Pending`, `Booked`, `Paid`, `Cancelled`, `Awaiting`, `Paused`, `Duplicate`, `Refunded`,
  `Initiated`, `CheckIssued`, `VccIssued`, `Refunding`, `MarkedAsPaid`, `Scheduled`, `Processing`, `OnHold`

This integration treats `state=Paid` or `friendlyStatus` `Paid`/`MarkedAsPaid` **with a
`paymentDate`** as settled. `CheckIssued`/`VccIssued` are not yet settled — the next run
picks them up when Corpay transitions them to `Paid`. `Cancelled`/`Refunded` are polled
separately to warn about documents already posted in NetSuite.

**Credit notes** are `FinancialDocumentType.Creditnote` (exact casing) on the list endpoint;
`InternalExpenseType` also contains `CreditNote` but only on upload requests.

---

## 5. Webhooks (v1 spec — not currently used)

Webhook CRUD **is** documented, in the **v1** spec only:

| Method | Path |
|---|---|
| `POST` | `/external/v1/webhooks` — create (scope `webhooks.all` or `webhooks.create`) |
| `GET` | `/external/v1/webhooks` — list (only webhooks created by this API client) |
| `GET` | `/external/v1/webhooks/{webhookId}` — read one |
| `PUT` | `/external/v1/webhooks` — update (`WebhooksUpdateRequest`) |
| `DELETE` | `/external/v1/webhooks/{webhookId}` — delete |
| `POST` | `/external/v1/webhooks/{webhookId}/expenses/{expenseId}/logs` — write a sync log visible in the app's Integrations tab (`eventPayload`, `state`, `statusCode`, `errorMessage`) |

`WebhooksCreateRequest`: `url` (**required**), `teamId` (**required**), `events: string[]`,
`configuration: map<string,string>` (**undocumented** — possibly custom headers or a secret;
needs vendor confirmation).

**Registration handshake:** on create/update, Corpay POSTs a validation payload to the URL —
`{"data":{"event":"webhook.validation","timestamp":"…"}}` — and the endpoint **must answer
200 OK** or the webhook is not saved.

**Not documented anywhere public:** the event-name catalogue (the `events` array is a bare
string list), retry/delivery guarantees, timeouts, and ordering. Legacy official docs from
the Roger.ai era describe thin payloads (`{"data":{"event":"expense.state.paid","bill":{"id":…}}}`
— i.e. you still fetch the expense afterwards) and an HMAC-SHA512 signature header over
`"{timestamp}.{rawBody}"`; treat both as **unverified for the current API**.

Why this integration polls instead: the payload carries no expense data (a fetch is needed
regardless), delivery guarantees are undocumented (a missed event means a missing bill unless
you also poll), and receiving a push would require a public HTTPS endpoint — which NetSuite
cannot safely provide (RESTlets need per-request OAuth signing; Oracle explicitly advises
against public "available without login" Suitelets for integrations). Polling with a lookback
window is self-healing and needs no inbound surface. Revisit if Corpay documents delivery
guarantees and the `configuration`/signature mechanism.

---

## 6. Practical limits

- **Rate:** no hard per-client limit yet, but stay **under ~50 req/min**; Corpay monitors and
  can revoke access. This integration paces every Corpay call by 150 ms and bounds each run
  with a lookback window.
- **Pagination:** `Offset`/`Count` on `/v2/expenses` (Count 10–100). Trust `total` only when
  it is present and positive — always stop on an empty page.
- **No date filter** on the list endpoint, hence the client-side lookback.
- **No `servers` block** in any spec — base URLs come from the table in §1.
- **Fees / FX spreads:** how they are reported was left open in the vendor Q&A ("let's talk
  in the call") — still unresolved, and out of scope for the current mapping.
