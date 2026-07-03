# Flow: Corpay One → NetSuite

Sådan virker `sync.js`. Én kørsel (`node sync.js`) skubber regninger (Vendor Bill), kreditnotaer (Vendor Credit) og betalinger (Vendor Payment) fra Corpay One til NetSuite og stopper. Al idempotens ligger i NetSuites `externalId` — ingen lokal database.

## 1. Arkitektur

```mermaid
flowchart LR
    subgraph CP["Corpay One (kilde)"]
        L["GET /v2/expenses<br/>pr. state × type, pagineret"]
        D["GET /v3/expenses/{id}<br/>fuld detalje"]
    end
    subgraph S["sync.js (cron, fx hvert 15. min)"]
        M["Mapping<br/>beløb er brutto (inkl. moms) → grossAmt<br/>leverandør via vendor.externalId"]
    end
    subgraph NS["NetSuite (mål)"]
        B["Vendor Bill<br/>PUT eid:corpay-bill-{id}"]
        C["Vendor Credit<br/>PUT eid:corpay-credit-{id}"]
        P["Vendor Payment<br/>POST (externalId corpay-pay-{id})"]
    end
    L --> D --> M
    M --> B
    M --> C
    B --> P
```

## 2. Én kørsel

```mermaid
flowchart TD
    A["Start: node sync.js"] --> B["Indlæs config (.env)<br/>fail-fast hvis variabler mangler"]
    B --> C{"CORPAY_TOKEN sat?"}
    C -- nej --> C2["Hent token via refresh_token-grant<br/>identity.corpayone.com/connect/token"]
    C -- ja --> E
    C2 --> E["List expenses pr. state (Booked, Initialized, Paid)<br/>× type (Bill, Creditnote), 100 pr. side"]
    E --> F["Lookback-filter (klient-side):<br/>behold kun bilag hvor paymentDate/referenceDate<br/>er inden for CORPAY_LOOKBACK_DAYS (std. 90)"]
    F --> G["For hvert bilag-id (dedupleret):<br/>hent fuld detalje fra v3<br/>(150 ms pause pr. Corpay-kald)"]
    G --> H["processExpense — se diagram 3"]
    H --> I["SUMMARY bills=… credits=… payments=…<br/>settled=… skipped=… errors=…"]
    I --> J{"errors > 0?"}
    J -- ja --> K["exit 1"]
    J -- nej --> L["exit 0"]
```

Fejl på ét bilag stopper aldrig kørslen — de logges som `ERROR <kind> <id>` og tælles. Næste kørsel prøver igen (upserts er ufarlige at gentage).

## 3. Pr. bilag (processExpense)

```mermaid
flowchart TD
    A["Bilag (fuld detalje)"] --> B{"vendor.externalId =<br/>numerisk NetSuite-id?"}
    B -- nej --> SKIP["SKIP — logges,<br/>næste kørsel prøver igen"]
    B -- ja --> C{"Type?"}
    C -- "Creditnote" --> CR["PUT vendorCredit eid:corpay-credit-{id}<br/>åben kreditnota, brutto-linjer,<br/>ingen approvalStatus"]
    C -- "Bill" --> D{"Betalt?<br/>(state=Paid eller friendlyStatus=<br/>Paid/MarkedAsPaid, og paymentDate sat)"}
    D -- nej --> UP["PUT vendorBill eid:corpay-bill-{id}<br/>brutto-linjer + momskode,<br/>approvalStatus=Approved"]
    D -- ja --> E{"Findes vendorPayment<br/>eid:corpay-pay-{id} allerede?"}
    E -- ja --> SET["SETTLED — helt afsluttet,<br/>bill re-upsertes ALDRIG igen"]
    E -- nej --> UP2["PUT vendorBill (som ovenfor)<br/>internt id fås fra Location-header"]
    UP2 --> PAY["POST vendorPayment:<br/>bank efter valuta (NS_BANK_ACCOUNT_ID_&lt;CUR&gt;),<br/>apAcct, apply → doc = billens interne id,<br/>beløb = Corpay-beløbet"]
```

## 4. Nøgler og idempotens

| Corpay | NetSuite-record | externalId | Opdateres? |
|---|---|---|---|
| Bill | Vendor Bill | `corpay-bill-{id}` | Ja, upsert hver kørsel — indtil den er betalt (SETTLED) |
| Creditnote | Vendor Credit | `corpay-credit-{id}` | Ja, upsert hver kørsel |
| Betalt Bill | Vendor Payment | `corpay-pay-{id}` | Nej — oprettes én gang, røres aldrig igen |

- **Brutto-beløb:** Corpays beløb er inkl. moms. Linjer sendes som `grossAmt`, så NetSuite selv beregner netto/moms ud fra momskoden — bill-total = Corpay-beløb = betaling. Regningen lukkes helt.
- **Selvhelende:** Check/VCC-flows (friendlyStatus `CheckIssued`/`VccIssued`) får deres betaling, når Corpay skifter state til `Paid` — polling samler den op i en senere kørsel.
- **Genstart ufarlig:** afbrudt kørsel efterlader højst en bill uden betaling; næste kørsel opretter betalingen.

## Virker det?

Verificeret offline: `npm test` (stub'et Corpay + NetSuite, ingen netværk) dækker upsert-URL'er, brutto-beløb, 45-tegns trunkering af fakturanr., SKIP ved manglende leverandør-stempling, SETTLED-spring, lookback-filteret og en uafhængig efterregning af OAuth-signaturen. Mangler før produktion: en live røgtest mod Corpay staging + NetSuite sandbox med rigtige nøgler (formular-obligatoriske felter kan ikke ses via API'et).
