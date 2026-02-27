# CorpayOne → NetSuite Integration Flow

## High-Level Overview

```mermaid
flowchart LR
    C1[CorpayOne API\nv3 read-only] -->|expenses\nvendors\npayments| AZ[Azure Function\nScheduled every 15 min]
    AZ -->|vendor bills\nvendor payments\nvendors| NS[NetSuite\nSuiteREST API]
    AZ ---|sync state| DB[(SQLite DB)]
    AD[NetSuite Suitelet\nAdmin Dashboard] -.->|category → GL account\nbank account config\nsubsidiary config| DB
```

---

## Detailed Sync Flow

```mermaid
flowchart TD
    START([Timer Trigger\nevery 15 min]) --> AUTH[Authenticate with CorpayOne\nOAuth2 token refresh]
    AUTH --> FETCH[GET /external/v3/expenses\nFetch all expenses]

    FETCH --> LOOP{For each\nexpense}

    %% ── State check ──
    LOOP --> STATE{State syncable?\nBooked / Awaiting / Paid}
    STATE -->|No: Pending, Cancelled,\nPaused, Duplicate| SKIP1[Skip]
    SKIP1 --> LOOP

    %% ── Already synced? ──
    STATE -->|Yes| SYNCED{Already synced\nin local DB?}
    SYNCED -->|Yes, unchanged| SKIP2[Skip]
    SKIP2 --> LOOP

    %% ── Vendor ──
    SYNCED -->|No or updated| VENDOR{Vendor exists\nin NetSuite?}
    VENDOR -->|Yes| MAP
    VENDOR -->|No| CREATE_V[Create Vendor in NetSuite\ncompanyName + externalId]
    CREATE_V --> TRACK_V[Save vendor mapping\nin SQLite]
    TRACK_V --> MAP

    %% ── Bill mapping ──
    MAP[Map expense → Vendor Bill\n• Category → GL account\n• Lines → expense lines\n• FX → home amount]

    MAP --> CREATE_B[Create Vendor Bill\nin NetSuite via SuiteREST]
    CREATE_B --> TRACK_B[Save bill mapping\nin SQLite]
    TRACK_B --> LOOP

    %% ── Payments ──
    LOOP -->|All expenses\nprocessed| PAY_FETCH[Fetch payments\nfrom CorpayOne]
    PAY_FETCH --> PAY_LOOP{For each\npayment}

    PAY_LOOP --> PAY_STATUS{Status =\ncompleted?}
    PAY_STATUS -->|No| PAY_SKIP[Skip]
    PAY_SKIP --> PAY_LOOP

    PAY_STATUS -->|Yes| BILL_EXISTS{Matching bill\nalready synced?}
    BILL_EXISTS -->|No| PAY_PENDING[Mark as pending\nretry next run]
    PAY_PENDING --> PAY_LOOP

    BILL_EXISTS -->|Yes| PAY_MAP[Map payment → Vendor Payment\n• Link to NS bill\n• Currency → bank account]
    PAY_MAP --> CREATE_P[Create Vendor Payment\nin NetSuite via SuiteREST]
    CREATE_P --> TRACK_P[Save payment mapping\nin SQLite]
    TRACK_P --> PAY_LOOP

    PAY_LOOP -->|All payments\nprocessed| DONE([Sync Complete\nLog results])

    style START fill:#4A90D9,color:#fff
    style DONE fill:#27AE60,color:#fff
    style SKIP1 fill:#95A5A6,color:#fff
    style SKIP2 fill:#95A5A6,color:#fff
    style PAY_SKIP fill:#95A5A6,color:#fff
    style PAY_PENDING fill:#F39C12,color:#fff
    style CREATE_V fill:#8E44AD,color:#fff
    style CREATE_B fill:#27AE60,color:#fff
    style CREATE_P fill:#27AE60,color:#fff
```

---

## Data Mapping

```mermaid
flowchart LR
    subgraph CorpayOne["CorpayOne (source — read only)"]
        EXP[Expense]
        LINE[Expense Lines]
        VEND[Vendor\nid + name]
        CAT[Category\nname + number]
    end

    subgraph Mapping["Mapping Layer"]
        GL[Category → GL Account]
        BANK[Currency → Bank Account]
        SUB[Subsidiary Config]
    end

    subgraph NetSuite["NetSuite (target)"]
        VB[Vendor Bill]
        VBL[Expense Lines]
        VP[Vendor Payment]
        NV[Vendor]
    end

    EXP --> VB
    LINE --> VBL
    VEND --> NV
    CAT --> GL --> VBL
    BANK --> VP
    SUB --> VB
    SUB --> VP
```

---

## Vendor Lookup Logic

```mermaid
flowchart TD
    V_START([Need vendor in NetSuite]) --> V_CACHE{In local\nSQLite cache?}
    V_CACHE -->|Yes| V_DONE([Return NS vendor ID])
    V_CACHE -->|No| V_EXT{Find by externalId\nin NetSuite?}
    V_EXT -->|Found| V_SAVE[Cache in SQLite]
    V_SAVE --> V_DONE
    V_EXT -->|Not found| V_NAME{Find by\ncompany name?}
    V_NAME -->|Found| V_SAVE
    V_NAME -->|Not found| V_CREATE[Create new vendor\nin NetSuite]
    V_CREATE --> V_SAVE
```

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Azure Function                        │
│                  (Timer: every 15 min)                    │
│                                                          │
│  ┌─────────────┐   ┌──────────────┐   ┌──────────────┐ │
│  │  CorpayOne   │   │   Mapping    │   │   NetSuite   │ │
│  │   Client     │   │   Engine     │   │   Client     │ │
│  │             │   │              │   │              │ │
│  │ • getExpenses│   │ • category   │   │ • createBill │ │
│  │ • getPayments│   │   → GL acct  │   │ • createPay  │ │
│  │             │   │ • lines      │   │ • upsertVend │ │
│  │  OAuth2     │   │ • FX convert │   │  TBA OAuth1  │ │
│  └──────┬──────┘   └──────┬───────┘   └──────┬───────┘ │
│         │                 │                   │         │
│         └────────┬────────┘───────────────────┘         │
│                  │                                       │
│          ┌───────┴───────┐                               │
│          │   SQLite DB   │                               │
│          │               │                               │
│          │ • synced_bills│                               │
│          │ • synced_pays │                               │
│          │ • synced_vend │                               │
│          │ • sync_runs   │                               │
│          └───────────────┘                               │
└─────────────────────────────────────────────────────────┘

         ▲ READ only                    WRITE ▼
         │                              │
┌────────┴─────────┐          ┌────────┴──────────┐
│   CorpayOne API  │          │   NetSuite REST   │
│   v3 /expenses   │          │   SuiteREST API   │
└──────────────────┘          └───────────────────┘
```

---

## Key Design Decisions

| Decision | Why |
|---|---|
| **One-way sync** (CorpayOne → NetSuite) | CorpayOne is the source of truth for AP. NetSuite is the ERP target. |
| **Pull-based, no webhooks** | No open endpoints needed. Simpler security. Runs inside Azure VNET. |
| **SQLite for sync state** | Local to the function. No external DB dependency. Fast. |
| **Idempotent** | Every record gets an `externalId` (e.g. `corpay-exp-1001`). If it exists in NetSuite, skip. |
| **Category → GL account mapping** | Configured by admin in NetSuite Suitelet. Not hardcoded. |
| **Multi-line support** | If expense has lines → one NS line per CorpayOne line. If not → single line from total. |
| **No VAT from API** | CorpayOne v3 API has no VAT breakdown. Tax codes applied by NetSuite rules. |
| **Pending payment retry** | If a payment arrives before its bill is synced, mark pending. Retry next cycle. |
