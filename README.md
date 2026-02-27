# CorpayOne ↔ NetSuite Integration

Synchronizes vendor bills and payments from [CorpayOne](https://corpayone.dk) to [NetSuite](https://www.netsuite.com), keeping your AP data consistent across both systems.

## What it does

- **Vendor Bill Sync**: Approved invoices in CorpayOne are created as vendor bills in NetSuite
- **Payment Sync**: When bills are paid in CorpayOne, vendor payments are created in NetSuite and applied against the corresponding bill
- **Vendor Matching**: Automatically matches or creates vendors in NetSuite based on CorpayOne supplier data
- **Real-time Webhooks**: Receives CorpayOne webhook events for immediate sync
- **Scheduled Sync**: Periodic background sync to catch any missed events
- **Idempotent**: Uses external IDs to prevent duplicate records, safe to re-run

## Architecture

```
CorpayOne API                        NetSuite REST API
     │                                      ▲
     │  OAuth2                    OAuth 1.0a │
     ▼                                      │
┌─────────────────────────────────────────────────┐
│              Integration Service                │
│                                                 │
│  ┌──────────┐  ┌───────────┐  ┌──────────────┐ │
│  │ Webhook  │  │ Scheduler │  │  CLI (sync/  │ │
│  │ Server   │  │ (cron)    │  │  full)       │ │
│  └────┬─────┘  └─────┬─────┘  └──────┬───────┘ │
│       │              │               │          │
│       ▼              ▼               ▼          │
│  ┌──────────────────────────────────────────┐   │
│  │            Sync Services                 │   │
│  │  bill-sync → vendor-sync → payment-sync  │   │
│  └────────────────┬─────────────────────────┘   │
│                   │                             │
│  ┌────────────────▼─────────────────────────┐   │
│  │     SQLite (sync state tracking)         │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Data Flow

### Bills
1. Fetch approved/scheduled/paid invoices from CorpayOne
2. Match or create the vendor in NetSuite (by external ID → name → create)
3. Map invoice fields and line items to a NetSuite vendor bill (expense-based)
4. Create the vendor bill via NetSuite REST API with `externalId` = `corpay-{invoiceId}`

### Payments
1. Fetch completed payments from CorpayOne
2. Look up the synced vendor bill in the local database
3. Create a NetSuite vendor payment applied against that bill
4. Track with `externalId` = `corpay-pay-{paymentId}`

## Setup

### Prerequisites

- Node.js 18+
- CorpayOne API credentials (OAuth2 client ID and secret) — obtain from [developers.corpayone.com](https://developers.corpayone.com/)
- NetSuite Token-Based Authentication credentials — set up via Setup > Integration > Manage Integrations in NetSuite

### Install

```bash
npm install
```

### Configure

Copy `.env.example` to `.env` and fill in your credentials:

```bash
cp .env.example .env
```

Key configuration:

| Variable | Description |
|----------|-------------|
| `CORPAYONE_CLIENT_ID` | CorpayOne OAuth2 client ID |
| `CORPAYONE_CLIENT_SECRET` | CorpayOne OAuth2 client secret |
| `CORPAYONE_WEBHOOK_SECRET` | Secret for verifying webhook signatures |
| `NETSUITE_ACCOUNT_ID` | NetSuite account ID (e.g., `TSTDRV12345`) |
| `NETSUITE_CONSUMER_KEY` | NetSuite integration consumer key |
| `NETSUITE_CONSUMER_SECRET` | NetSuite integration consumer secret |
| `NETSUITE_TOKEN_KEY` | NetSuite TBA token key |
| `NETSUITE_TOKEN_SECRET` | NetSuite TBA token secret |
| `NETSUITE_SUBSIDIARY_ID` | Default subsidiary (multi-subsidiary accounts) |
| `NETSUITE_AP_ACCOUNT_ID` | Default AP account for expense lines |
| `NETSUITE_BANK_ACCOUNT_ID` | Bank account for vendor payments |

### Initialize Database

```bash
npm run migrate
```

## Usage

### Server Mode (default)

Runs the webhook server and scheduled sync together:

```bash
npm start
# or
npm run dev  # with ts-node for development
```

This starts:
- **Webhook server** on port 3000 (configurable) — point CorpayOne webhooks to `POST http://your-host:3000/webhooks/corpayone`
- **Scheduled sync** every 15 minutes (configurable)
- **Initial sync** on startup

### One-time Incremental Sync

Sync recent changes and exit:

```bash
node dist/index.js sync
```

### Full Sync

Sync all data (no time filter) and exit:

```bash
node dist/index.js full
```

## API Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/health` | GET | Health check |
| `/webhooks/corpayone` | POST | CorpayOne webhook receiver |
| `/status` | GET | Sync statistics and last run info |

## Webhook Events Handled

| Event | Action |
|-------|--------|
| `invoice.created` | Sync bill to NetSuite |
| `invoice.updated` | Re-sync bill to NetSuite |
| `invoice.approved` | Sync bill to NetSuite |
| `payment.created` | Sync payment to NetSuite |
| `payment.completed` | Sync payment to NetSuite |
| `invoice.rejected` | Log warning (no auto-delete in NetSuite) |
| `payment.failed` | Log warning |

## Sync Rules

- **Only approved+ invoices sync**: Draft, pending approval, and rejected invoices are skipped
- **Only completed payments sync**: Pending, processing, and failed payments are skipped
- **Idempotent**: External IDs prevent duplicate records across re-runs
- **Vendor auto-creation**: If a vendor doesn't exist in NetSuite, it's created automatically
- **Pending payment retry**: Payments for not-yet-synced bills are retried on the next sync cycle

## Development

```bash
npm run build    # Compile TypeScript
npm test         # Run tests
npm run dev      # Run with ts-node
```

## Project Structure

```
src/
├── clients/
│   ├── corpayone-client.ts    # CorpayOne API client (OAuth2)
│   └── netsuite-client.ts     # NetSuite REST API client (OAuth 1.0a)
├── database/
│   ├── db.ts                  # SQLite database operations
│   ├── schema.ts              # Database schema
│   └── migrate.ts             # Migration script
├── mapping/
│   └── invoice-mapper.ts      # CorpayOne → NetSuite data mapping
├── server/
│   └── webhook-server.ts      # Express webhook server
├── services/
│   ├── bill-sync.ts           # Vendor bill sync logic
│   ├── payment-sync.ts        # Payment sync logic
│   ├── vendor-sync.ts         # Vendor matching/creation
│   ├── webhook-handler.ts     # Webhook event processing
│   └── scheduler.ts           # Cron-based scheduled sync
├── types/
│   ├── corpayone.ts           # CorpayOne type definitions
│   ├── netsuite.ts            # NetSuite type definitions
│   └── sync.ts                # Sync tracking types
├── config.ts                  # Environment configuration
├── logger.ts                  # Pino logger
└── index.ts                   # Main entry point
```
