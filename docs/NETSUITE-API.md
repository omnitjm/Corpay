# NetSuite SuiteTalk REST — reference for this integration

Distilled from the **official Oracle NetSuite documentation** plus **live metadata from the
Omnit account** (record metadata + SuiteQL). Field and property names below were verified
against the account's actual `record/v1` schema — the same schema the REST API Browser renders.

Account shape: **OneWorld** (multiple subsidiaries, so `subsidiary` is mandatory on
transactions), **legacy tax engine** (line-level `taxCode`; no SuiteTax `taxDetails` sublist),
**multi-currency** (DKK base + EUR), with Danish/Nordic localization bundles installed
(Staria `custbody_sta_*`, e-invoicing `custbody_psg_ei_*`).

---

## 1. Endpoints

```
https://{accountId}.suitetalk.api.netsuite.com/services/rest/record/v1/…
https://{accountId}.suitetalk.api.netsuite.com/services/rest/query/v1/suiteql   (POST)
```

`{accountId}` in the **host** is lowercased with underscores → hyphens
(`1234567_SB1` → `1234567-sb1`); the OAuth **realm** keeps the uppercase underscore form.

| Record | Create | Idempotent upsert |
|---|---|---|
| Vendor Bill | `POST /record/v1/vendorBill` | `PUT /record/v1/vendorBill/eid:{externalId}` |
| Vendor Credit | `POST /record/v1/vendorCredit` | `PUT /record/v1/vendorCredit/eid:{externalId}` |
| Vendor Payment | `POST /record/v1/vendorPayment` | `PUT /record/v1/vendorPayment/eid:{externalId}` |
| Vendor | `POST /record/v1/vendor` | `PUT /record/v1/vendor/eid:{externalId}` |

- Success on write = **`204 No Content`** with the new record's URL in the **`Location`**
  header — parse the trailing path segment for the internal id.
- The **`eid:` prefix** works anywhere an internal id is accepted in a URL, and `PUT` to an
  `eid:` URL is an **upsert** (create if absent, update if present). This is the integration's
  entire idempotency mechanism.
- **`?replace=expense`** on an upsert makes the write **replace** the expense sublist. Without
  it NetSuite REST *merges* sublists — incoming lines with no line id are **appended**, so a
  repeated upsert would duplicate lines on every run. Load-bearing.
- Errors are RFC 7807 problem+json: read `status` and iterate `o:errorDetails[]` for
  `o:errorCode` / `detail` / `o:errorPath`.
- Not reachable over REST on vendorBill: `expensePlanMessage`, `accountingBookDetail`,
  `taxDetails`.

**SuiteQL** (used for preflight validation, the chart-of-accounts map and the vendor list):

```
POST /services/rest/query/v1/suiteql?limit=1000&offset=0
Prefer: transient          ← mandatory; omitting it returns INVALID_HEADER
{ "q": "SELECT id, acctnumber FROM account WHERE isinactive = 'F'" }
```

Response carries `items`, `hasMore`, `totalResults`. Max 1000 rows/page, 100 000 per query.
Record-collection filtering is also available: `GET /record/v1/vendorBill?q=externalId IS "X"`
(returns id refs only).

---

## 2. Authentication — OAuth 1.0a TBA (HMAC-SHA256)

```
Authorization: OAuth realm="1234567_SB1",
  oauth_consumer_key="…", oauth_token="…",
  oauth_signature_method="HMAC-SHA256", oauth_timestamp="…",
  oauth_nonce="…", oauth_version="1.0", oauth_signature="…"
```

- `realm` = the account id, and is the **only** parameter excluded from the signature base string.
- **HMAC-SHA256 only** — HMAC-SHA1 has been unsupported since 2023.1.
- Signature base string (RFC 5849):
  `{METHOD}&{pctEnc(url-without-query)}&{pctEnc(sortedParams)}` where `sortedParams` is all
  OAuth params **plus the URL query params**, sorted by key, each `key=value` percent-encoded
  (RFC 3986 — `encodeURIComponent` plus `!'()*`) and joined with `&`.
- Signing key = `pctEnc(consumerSecret) + "&" + pctEnc(tokenSecret)`;
  signature = `base64(HMAC-SHA256(baseString, key))`.
- Alternative: **OAuth 2.0 client credentials (M2M)** needs an X.509 certificate and a signed
  JWT client assertion (`scope=rest_webservices`), yielding ~60-minute bearer tokens with no
  refresh token. TBA still works but cannot be used for **new** integrations from 2027.1.

Setup in NetSuite: enable **Token-Based Authentication** + **REST Web Services** (Setup →
Company → Enable Features → SuiteCloud), create an **Integration record** (consumer key +
secret, shown once) and an **Access Token** for a user + role (token id + secret, shown once).

---

## 3. Record payloads

### vendorBill

```json
{
  "externalId": "corpay-bill-{corpayId}",
  "entity":     { "id": "742" },
  "subsidiary": { "id": "10" },
  "currency":   { "id": "1" },
  "tranId":     "INV-12345",
  "tranDate":   "2026-07-03",
  "dueDate":    "2026-08-02",
  "memo":       "Corpay One expense …",
  "approvalStatus": { "id": "2" },
  "expense": { "items": [
    { "account": { "id": "235" }, "grossAmt": 1000.00, "memo": "Line", "taxCode": { "id": "18" } }
  ] }
}
```

- `entity` = vendor internal id. `subsidiary` is required (OneWorld); **positive ids only** —
  negative ids are consolidated views and are not postable.
- `tranId` is the **vendor's invoice number** ("Reference No.", max 45 chars — truncate).
- Sublists are wrapped: `"expense": { "items": [ … ] }`. Line fields available: `account`,
  `amount`, `grossAmt`, `memo`, `category`, `department`, `class`, `location`, `taxCode`,
  `line`, `isBillable`. Use `item` lines instead only when mapping to NetSuite items.
- **`grossAmt` vs `amount`**: `amount` is net and NetSuite adds tax **on top**; `grossAmt` is
  VAT-inclusive and NetSuite back-computes the net. Corpay amounts are gross, so this
  integration always sends `grossAmt` — otherwise every bill ends up ~25 % over the payable
  and its payment can never close it.
- `approvalStatus`: `1` = Pending Approval, `2` = Approved. Sent as Approved because Corpay is
  the approval system of record. **Exists only on vendorBill** — sending it on a vendorCredit
  is rejected (verified: zero approval fields in this account's vendorcredit metadata).
- Omit `exchangeRate` to let NetSuite use the effective rate. Don't send header `taxTotal` — computed.

### vendorCredit

Same shape and same `expense`/`item` sublists (no `orderDoc`/`orderLine` on lines), **without**
`approvalStatus`. Amounts stay positive — it is a credit by record type, not by sign.
An optional `apply` sublist can apply it to an open bill
(`{ "apply": { "items": [ { "doc": {"id":"…"}, "apply": true, "amount": 250.00 } ] } }`);
omitted here, so credits stay open on the vendor's AP.

### vendorPayment

```json
{
  "externalId": "corpay-pay-{corpayId}",
  "entity":     { "id": "742" },
  "subsidiary": { "id": "10" },
  "currency":   { "id": "1" },
  "account":    { "id": "340" },
  "apAcct":     { "id": "114" },
  "tranDate":   "2026-07-03",
  "apply": { "items": [ { "doc": { "id": "1234" }, "apply": true, "amount": 1000.00 } ] }
}
```

- `account` = the **bank account** the money leaves; `apAcct` = the AP control account.
- `apply.items[].doc` = the **internal id** of the vendor bill (not `tranId`, not an `eid:`
  reference). Take it from the bill upsert's `Location` header, or look it up
  (`GET /vendorBill/eid:…?fields=id`, or SuiteQL on `transaction`).
- Verified apply-line property names: **`doc`**, **`apply`** (bool), **`amount`** (not
  `docId`/`applied`); also `disc`/`discAmt`, plus a separate `credit` sublist for applying
  open vendor credits.
- Payment currency must match the bill currency.
- Alternative: `POST /record/v1/vendorBill/{id}/!transform/vendorPayment` pre-populates the
  apply line from the source bill (this is what the SuiteScript variant uses via
  `record.transform`, though apply pre-population is observed behaviour, not a documented
  guarantee — verify and force the line).

### vendor (auto-create)

`companyName`, `isPerson: false`, `subsidiary`, plus `vatRegNumber` (CVR) and `email` when
known, keyed by `externalId: corpay-vendor-{corpayVendorId}` for idempotency. Bank and payment
details are deliberately omitted — payments originate in Corpay.

---

## 4. Real internal ids in the Omnit account

**Subsidiaries** (positive = postable): 1 Parent Company · 4 Omnit Group Consolidated ·
9 Omnit Finance · **10 Omnit ApS** · 11 Omnit Rentals · 12 Omnit Partners · 14 LS accounting.
(−1, −4, −9 are consolidated views — never on transactions.)

**Accounts**: AP (`AcctPay`) **114 "4101 Kreditorer"** (the only active one) · Bank
**340 "4301 Driftskonto"** (DKK), **341 "4302 Indlån EUR"** (EUR), 1 "100011 Cheque Account",
225 "123456789 Pleo Bank" (note: 358 "2214 Fri telefon" is mistyped as Bank — avoid) ·
Expense examples 235 "2201 Lønninger", 236 "2202 Pensioner", 237 "2203 Lønrefusion".

**Currencies**: **1 = DKK** (base), **4 = EUR**.

**Tax codes** (line `taxCode`, DK nexus): **18** "S-DK standard 25% moms" · 57 "E-DK Exempt" ·
**149** "ESSP-DK EU køb ydelser" (reverse charge, services) · 150 "ES-DK EU varekøb" (EU goods) ·
58 "I-DK" (import 25%).

**Vendors** (samples): 715 "3pX Recruitment Limited" (EUR) · 742 "APCOA DANMARK A/S" (DKK) ·
746 "Altibox Danmark A/S" (DKK) · 725 "Avernus ApS" (DKK).

---

## 5. Gotchas

1. **Line-level `taxCode` is effectively mandatory** on purchase transactions under the legacy
   tax engine with a DK/EU nexus. Currency-specific overrides matter: a EUR reverse-charge
   expense booked with the Danish 25 % code silently creates phantom recoverable input VAT.
2. **Vendor / subsidiary / currency triangle** — a post fails if the vendor is not available in
   the target subsidiary, or the currency is not on the vendor record. Keep bill currency,
   payment currency and the chosen bank account's currency mutually consistent.
3. **Closed posting periods** — `postingPeriod` defaults from `tranDate`; a closed or locked
   period fails the write. Surfaced as a per-document error for manual handling.
4. **Form-level mandatory custom fields are invisible to the API.** The Staria/e-invoicing
   bundles add many `custbody_*` fields; REST metadata flags none as required, but a form can
   still block a save. **A sandbox smoke test per subsidiary is the only reliable check** before
   go-live.
5. `tranId` is capped at 45 characters, and a blank Reference No. can be rejected depending on
   the account's numbering preferences — always send a non-empty value.
6. **Persist the internal id from the `Location` header immediately** — the payment's
   `apply.items[].doc` needs it.

### SuiteScript-specific uncertainties (NetSuite-resident variant)

Offline tests cannot settle these — the first sandbox run will:
`externalidstring` as the transaction search filter id · the exact casing of the `grossamt`
sublist field · whether `record.transform` pre-selects only the source bill on the `apply`
sublist · the `https.createSecureString({input:'Bearer {custsecret_…}'})` placeholder form ·
and script-timezone alignment for `trandate`/`duedate`.

---

## 6. Official sources

Oracle NetSuite Applications Suite (docs.oracle.com), sections used:
signature for web services and RESTlets (`section_1534941088`) · OAuth 2.0 client credentials
(`section_162686838198`) · TBA overview (`section_4381113277`) · Vendor Bill record
(`article_164484956387`) · Vendor Payment record (`article_7095737506`) · external ids
(`section_156334828635`) · upsert (`section_156335203191`) · creating a record instance
(`section_1545141395`) · transforming records (`section_157901123882`) · record collection
filtering (`section_1545222128`) · SuiteQL over REST (`section_157909186990`) · error handling
(`section_156570709583`) · script type usage unit limits (`section_N3351480`) · N/https
(`section_4418229131`) · secrets management (`article_160216486846`).
Schema browser (JS SPA, not machine-fetchable):
`https://system.netsuite.com/help/helpcenter/en_US/APIs/REST_API_Browser/record/v1/`.
