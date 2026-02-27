# CorpayOne → NetSuite Integration: Architecture Diagrams

## 1. High-Level Functional Overview

```mermaid
flowchart TB
    subgraph CORPAYONE["CorpayOne (Source System)"]
        C_VENDORS["Vendors"]
        C_EXPENSES["Expenses / Bills"]
        C_PAYMENTS["Payments"]
    end

    subgraph INTEGRATION["Integration Service"]
        SYNC_ENGINE["Sync Engine<br/>(Node.js / TypeScript)"]
        SQLITE[("SQLite DB<br/>Sync State Tracking")]
        MAPPER["Invoice Mapper<br/>+ GL Account Resolver"]
        MAPPING_DB[("Mapping Tables<br/>Accounts, Tax, Bank, Subsidiary")]
    end

    subgraph NETSUITE["NetSuite (Target System)"]
        NS_VENDORS["Vendors"]
        NS_BILLS["Vendor Bills"]
        NS_PAYMENTS["Vendor Payments"]
    end

    C_VENDORS -->|"Pull via REST API v3"| SYNC_ENGINE
    C_EXPENSES -->|"Pull via REST API v3"| SYNC_ENGINE
    C_PAYMENTS -->|"Pull via REST API v3"| SYNC_ENGINE

    SYNC_ENGINE <-->|"Track sync state"| SQLITE
    SYNC_ENGINE -->|"Map fields"| MAPPER
    MAPPER <-->|"Resolve GL accounts"| MAPPING_DB

    SYNC_ENGINE -->|"Create via SuiteTalk REST"| NS_VENDORS
    SYNC_ENGINE -->|"Create via SuiteTalk REST"| NS_BILLS
    SYNC_ENGINE -->|"Create via SuiteTalk REST"| NS_PAYMENTS

    style CORPAYONE fill:#e8f4fd,stroke:#1a73e8
    style INTEGRATION fill:#fff3e0,stroke:#e65100
    style NETSUITE fill:#e8f5e9,stroke:#2e7d32
```

## 2. Technical Architecture & Components

```mermaid
flowchart TB
    subgraph ENTRY["Entry Points"]
        CLI["CLI (index.ts)<br/>Modes: server | sync | full"]
        AZ_TIMER["Azure Timer Function<br/>scheduledSync (*/15 min)"]
        AZ_HTTP["Azure HTTP Function<br/>manualSync (POST)"]
        AZ_HEALTH["Azure HTTP Function<br/>health (GET)"]
    end

    subgraph SERVICES["Service Layer"]
        SCHEDULER["scheduler.ts<br/>node-cron: */N minutes"]
        BILL_SYNC["bill-sync.ts<br/>syncBills()"]
        PAY_SYNC["payment-sync.ts<br/>syncPayments()<br/>retryPendingPayments()"]
        VENDOR_SYNC["vendor-sync.ts<br/>ensureVendorInNetSuite()"]
    end

    subgraph MAPPING["Mapping Layer"]
        INV_MAPPER["invoice-mapper.ts<br/>mapExpenseToVendorBill()<br/>mapPaymentToVendorPayment()"]
        RESOLVERS["Resolvers:<br/>resolveAccountId()<br/>resolveTaxCode()<br/>resolveSubsidiary()<br/>resolveBankAccount()"]
    end

    subgraph CLIENTS["API Clients"]
        CORPAY_CLIENT["corpayone-client.ts<br/>OAuth2 Client Credentials<br/>GET /external/v3/expenses<br/>GET /external/v3/payments"]
        NS_CLIENT["netsuite-client.ts<br/>OAuth 1.0a HMAC-SHA256<br/>SuiteTalk REST API<br/>SuiteQL queries"]
    end

    subgraph DATA["Data Layer (SQLite via better-sqlite3)"]
        DB["db.ts<br/>CRUD for sync records"]
        SCHEMA["schema.ts<br/>synced_vendors<br/>synced_bills<br/>synced_payments<br/>sync_runs"]
        MAP_DB["mapping-db.ts<br/>account_mappings<br/>tax_code_mappings<br/>bank_account_config<br/>subsidiary_config<br/>integration_settings"]
    end

    subgraph CONFIG["Configuration"]
        ENV[".env / Azure App Settings<br/>API credentials, sync interval,<br/>lookback hours, DB path"]
        CFG["config.ts<br/>Typed config object"]
    end

    CLI --> SCHEDULER
    CLI --> BILL_SYNC
    CLI --> PAY_SYNC
    AZ_TIMER --> SCHEDULER
    AZ_HTTP --> BILL_SYNC

    SCHEDULER --> BILL_SYNC
    SCHEDULER --> PAY_SYNC
    BILL_SYNC --> VENDOR_SYNC
    BILL_SYNC --> INV_MAPPER
    PAY_SYNC --> INV_MAPPER

    INV_MAPPER --> RESOLVERS
    RESOLVERS --> MAP_DB

    VENDOR_SYNC --> CORPAY_CLIENT
    VENDOR_SYNC --> NS_CLIENT
    BILL_SYNC --> CORPAY_CLIENT
    BILL_SYNC --> NS_CLIENT
    PAY_SYNC --> CORPAY_CLIENT
    PAY_SYNC --> NS_CLIENT

    BILL_SYNC --> DB
    PAY_SYNC --> DB
    VENDOR_SYNC --> DB
    DB --> SCHEMA
    ENV --> CFG

    style ENTRY fill:#f3e5f5,stroke:#7b1fa2
    style SERVICES fill:#fff3e0,stroke:#e65100
    style MAPPING fill:#e3f2fd,stroke:#1565c0
    style CLIENTS fill:#fce4ec,stroke:#c62828
    style DATA fill:#e8f5e9,stroke:#2e7d32
    style CONFIG fill:#fff9c4,stroke:#f9a825
```

## 3. Complete Sync Cycle Flow (Scheduled / Incremental)

```mermaid
flowchart TD
    START(["Sync Triggered<br/>(cron / CLI / Azure Timer)"])
    --> CREATE_RUN["Create sync_run record<br/>(type: incremental or full)"]
    --> CALC_LOOKBACK["Calculate lookback window<br/>updatedSince = now - N hours"]

    CALC_LOOKBACK --> PHASE1

    subgraph PHASE1["Phase 1: Bill Sync"]
        FETCH_EXP["Fetch ALL expenses<br/>GET /external/v3/expenses<br/>(paginated, 100/page)"]
        --> LOOP_EXP{{"For each expense"}}

        LOOP_EXP --> CHK_STATE{"State syncable?<br/>Booked / Awaiting / Paid"}
        CHK_STATE -->|No| SKIP_EXP["Skip<br/>(Pending, Cancelled, etc.)"]
        CHK_STATE -->|Yes| CHK_LOCAL{"Already synced<br/>in local DB?<br/>Same state?"}
        CHK_LOCAL -->|"Yes, unchanged"| SKIP_EXP2["Skip (no change)"]
        CHK_LOCAL -->|"No or changed"| CHK_NS_BILL{"Vendor bill exists<br/>in NetSuite?<br/>(SuiteQL by externalId)"}
        CHK_NS_BILL -->|Yes| UPDATE_LOCAL["Update local DB<br/>status = synced"]
        CHK_NS_BILL -->|No| CHK_VENDOR{"Expense has<br/>vendor?"}
        CHK_VENDOR -->|No| SKIP_NO_V["Skip (no vendor)"]
        CHK_VENDOR -->|Yes| ENSURE_V["ensureVendorInNetSuite()"]

        ENSURE_V --> MAP_BILL["mapExpenseToVendorBill()<br/>Resolve GL account from<br/>category → mapping table"]
        MAP_BILL --> CREATE_BILL["POST /vendorBill<br/>to NetSuite"]
        CREATE_BILL --> RECORD_BILL["Upsert synced_bills<br/>status = synced"]
    end

    PHASE1 --> PHASE2

    subgraph PHASE2["Phase 2: Payment Sync"]
        FETCH_PAY["Fetch ALL payments<br/>GET /external/v3/payments<br/>(paginated, 100/page)"]
        --> LOOP_PAY{{"For each payment"}}

        LOOP_PAY --> CHK_COMPLETED{"status == completed?"}
        CHK_COMPLETED -->|No| SKIP_PAY["Skip"]
        CHK_COMPLETED -->|Yes| CHK_PAY_SYNCED{"Already synced<br/>in local DB?"}
        CHK_PAY_SYNCED -->|Yes| SKIP_PAY2["Skip"]
        CHK_PAY_SYNCED -->|No| CHK_NS_PAY{"Payment exists<br/>in NetSuite?<br/>(SuiteQL by externalId)"}
        CHK_NS_PAY -->|Yes| UPDATE_PAY_LOCAL["Update local DB"]
        CHK_NS_PAY -->|No| FIND_BILL{"Find synced bill<br/>in local DB"}
        FIND_BILL -->|"Not found"| PEND_PAY["Set status = pending<br/>(retry later)"]
        FIND_BILL -->|Found| FETCH_FULL_EXP["Fetch full expense<br/>for context"]
        FETCH_FULL_EXP --> MAP_PAY["mapPaymentToVendorPayment()<br/>Apply against NS bill"]
        MAP_PAY --> CREATE_PAY["POST /vendorPayment<br/>to NetSuite"]
        CREATE_PAY --> RECORD_PAY["Upsert synced_payments<br/>status = synced"]
    end

    PHASE2 --> PHASE3

    subgraph PHASE3["Phase 3: Retry Pending Payments"]
        GET_PENDING["SELECT * FROM synced_payments<br/>WHERE status = 'pending'"]
        --> RETRY_LOOP{{"For each pending"}}
        RETRY_LOOP --> RE_FETCH["Re-fetch payment<br/>from CorpayOne"]
        RE_FETCH --> RE_SYNC["Run syncSinglePayment()<br/>(same logic as Phase 2)"]
    end

    PHASE3 --> COMPLETE["Complete sync_run record<br/>Log stats: processed / synced / failed"]
    --> DONE(["Done"])

    style PHASE1 fill:#e8f4fd,stroke:#1a73e8
    style PHASE2 fill:#fff3e0,stroke:#e65100
    style PHASE3 fill:#fce4ec,stroke:#c62828
```

## 4. Vendor Resolution Flow

```mermaid
flowchart TD
    START(["ensureVendorInNetSuite(vendor)"])
    --> CHK_LOCAL{"Check local DB<br/>synced_vendors<br/>by corpayone_vendor_id"}
    CHK_LOCAL -->|"Found & synced"| RETURN_ID(["Return NS vendor ID"])

    CHK_LOCAL -->|"Not found / not synced"| SEARCH_EXT{"SuiteQL: find vendor<br/>by externalId =<br/>corpay-vendor-{id}"}
    SEARCH_EXT -->|Found| SAVE_LOCAL1["Save to local DB<br/>status = synced"]
    SAVE_LOCAL1 --> RETURN_ID

    SEARCH_EXT -->|"Not found"| SEARCH_NAME{"SuiteQL: find vendor<br/>by companyname"}
    SEARCH_NAME -->|Found| SAVE_LOCAL2["Save to local DB<br/>status = synced"]
    SAVE_LOCAL2 --> RETURN_ID

    SEARCH_NAME -->|"Not found"| CREATE_V["Create vendor in NetSuite<br/>POST /vendor<br/>with companyName, externalId,<br/>subsidiary"]
    CREATE_V -->|Success| SAVE_LOCAL3["Save to local DB<br/>status = synced"]
    SAVE_LOCAL3 --> RETURN_ID

    CREATE_V -->|Failure| SAVE_FAIL["Save to local DB<br/>status = failed"] --> ERROR(["Throw error"])

    style START fill:#f3e5f5,stroke:#7b1fa2
    style RETURN_ID fill:#e8f5e9,stroke:#2e7d32
    style ERROR fill:#fce4ec,stroke:#c62828
```

## 5. Invoice Mapping: CorpayOne Expense → NetSuite Vendor Bill

```mermaid
flowchart TD
    START(["mapExpenseToVendorBill(expense, vendorId)"])
    --> RESOLVE_SUB["resolveSubsidiary()<br/>1. mapping table<br/>2. env var fallback"]

    RESOLVE_SUB --> CHK_LINES{"expense.lines<br/>non-empty?"}

    CHK_LINES -->|Yes| MULTI["Multi-line mapping:<br/>For each CorpayOne line →<br/>1 NetSuite expense line"]
    MULTI --> RESOLVE_ACCT_M["resolveAccountId(line.category)<br/>1. category + subsidiary<br/>2. category only<br/>3. default mapping<br/>4. AP account env var"]
    RESOLVE_ACCT_M --> NS_LINE_M["NS Expense Line:<br/>account, amount, memo"]

    CHK_LINES -->|"No (empty)"| SINGLE["Single-line mapping:<br/>expense-level total"]
    SINGLE --> CHK_FX{"expense.fx<br/>exists?"}
    CHK_FX -->|Yes| USE_HOME["Use fx.homeAmount<br/>(home currency)"]
    CHK_FX -->|No| USE_AMT["Use expense.amount"]
    USE_HOME --> RESOLVE_ACCT_S
    USE_AMT --> RESOLVE_ACCT_S["resolveAccountId(expense.category)"]
    RESOLVE_ACCT_S --> NS_LINE_S["NS Expense Line:<br/>account, amount, memo"]

    NS_LINE_M --> BUILD
    NS_LINE_S --> BUILD

    BUILD["Build NetSuiteVendorBill:<br/>entity, externalId (corpay-{id}),<br/>memo, tranDate, dueDate,<br/>tranId (reference), subsidiary,<br/>expense.items[]"]
    --> DONE(["Return VendorBill"])

    style START fill:#f3e5f5,stroke:#7b1fa2
    style DONE fill:#e8f5e9,stroke:#2e7d32
```

## 6. GL Account Resolution (Fallback Chain)

```mermaid
flowchart LR
    INPUT(["Category name +<br/>Subsidiary ID"])
    --> S1{"1. category +<br/>subsidiary<br/>match?"}
    S1 -->|Yes| FOUND(["Use matched<br/>NS account ID"])
    S1 -->|No| S2{"2. category<br/>only match?"}
    S2 -->|Yes| FOUND
    S2 -->|No| S3{"3. Default mapping<br/>(is_default = 1)?"}
    S3 -->|Yes| FOUND
    S3 -->|No| S4["4. Env var fallback<br/>NETSUITE_AP_ACCOUNT_ID"]
    S4 --> FOUND

    style INPUT fill:#e3f2fd,stroke:#1565c0
    style FOUND fill:#e8f5e9,stroke:#2e7d32
```

## 7. Authentication Flows

```mermaid
flowchart LR
    subgraph CORPAY_AUTH["CorpayOne: OAuth 2.0 Client Credentials"]
        CA1["POST https://identity.corpayone.com/connect/token"]
        --> CA2["Body: grant_type=client_credentials<br/>client_id, client_secret<br/>scope: expenses.list expenses.read<br/>payments.all teams.vendors.all"]
        --> CA3["Response: access_token<br/>(cached until expires_in - 60s)"]
        --> CA4["Requests: Authorization: Bearer {token}"]
    end

    subgraph NS_AUTH["NetSuite: OAuth 1.0a (TBA)"]
        NA1["Per-request signing:<br/>consumer_key, token_key,<br/>consumer_secret, token_secret"]
        --> NA2["HMAC-SHA256 signature<br/>over method + URL + sorted params"]
        --> NA3["Authorization: OAuth realm=...,<br/>oauth_signature=..."]
    end

    style CORPAY_AUTH fill:#e8f4fd,stroke:#1a73e8
    style NS_AUTH fill:#e8f5e9,stroke:#2e7d32
```

## 8. Deployment Architecture

```mermaid
flowchart TB
    subgraph AZURE["Azure Functions (Option A)"]
        TIMER["Timer Trigger<br/>scheduledSync<br/>Every 15 min"]
        HTTP_SYNC["HTTP Trigger<br/>manualSync<br/>POST /api/manualSync"]
        HTTP_HEALTH["HTTP Trigger<br/>health<br/>GET /api/health"]
    end

    subgraph STANDALONE["Standalone Node.js (Option B)"]
        NODE["node dist/index.js server<br/>Built-in node-cron scheduler"]
    end

    subgraph SHARED["Shared Runtime"]
        ENGINE["Sync Engine"]
        DB[("SQLite DB<br/>./data/sync.db")]
    end

    subgraph EXTERNAL["External APIs"]
        CORPAY_API["CorpayOne API v3<br/>api.corpayone.com"]
        NS_API["NetSuite SuiteTalk REST<br/>{account}.suitetalk.api.netsuite.com"]
    end

    TIMER --> ENGINE
    HTTP_SYNC --> ENGINE
    NODE --> ENGINE
    ENGINE <--> DB
    ENGINE -->|"HTTPS (outbound only)"| CORPAY_API
    ENGINE -->|"HTTPS (outbound only)"| NS_API

    style AZURE fill:#e3f2fd,stroke:#1565c0
    style STANDALONE fill:#fff3e0,stroke:#e65100
    style SHARED fill:#f3e5f5,stroke:#7b1fa2
    style EXTERNAL fill:#fce4ec,stroke:#c62828
```

## Data Flow Summary

| Step | Source | Action | Target |
|------|--------|--------|--------|
| 1 | CorpayOne | Pull expenses (paginated) | Integration Service |
| 2 | Integration | Filter: Booked/Awaiting/Paid only | - |
| 3 | Integration | Check dedup (local DB + NetSuite) | SQLite + NetSuite |
| 4 | Integration | Resolve/create vendor | NetSuite |
| 5 | Integration | Map expense → vendor bill | - |
| 6 | Integration | Create vendor bill | NetSuite |
| 7 | CorpayOne | Pull payments (paginated) | Integration Service |
| 8 | Integration | Match payment → synced bill | SQLite |
| 9 | Integration | Create vendor payment (applied to bill) | NetSuite |
| 10 | Integration | Retry any pending payments | NetSuite |
