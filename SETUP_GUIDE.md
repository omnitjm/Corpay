# CorpayOne → NetSuite Integration: Setup Guide

This guide walks you through setting up the CorpayOne-NetSuite integration from scratch. It covers authentication (without 2FA), the NetSuite configuration dashboard, and how to run your first sync.

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [NetSuite Authentication (Token-Based, No 2FA Required)](#netsuite-authentication-token-based-no-2fa-required)
3. [CorpayOne API Setup](#corpayone-api-setup)
4. [Install & Configure the Integration](#install--configure-the-integration)
5. [Deploy the NetSuite Configuration Dashboard](#deploy-the-netsuite-configuration-dashboard)
6. [Configure Mappings in NetSuite](#configure-mappings-in-netsuite)
7. [Run the Integration](#run-the-integration)
8. [Run the Demo](#run-the-demo)
9. [API Reference](#api-reference)
10. [Troubleshooting](#troubleshooting)

---

## Prerequisites

- **Node.js** 18+ and npm
- **NetSuite** account with Administrator or Full Access role
- **CorpayOne** account with API access enabled
- A server or cloud environment to host the integration middleware

---

## NetSuite Authentication (Token-Based, No 2FA Required)

NetSuite supports **Token-Based Authentication (TBA)** which uses OAuth 1.0a consumer/token key pairs. This does **not** require 2FA or interactive login — it is designed specifically for server-to-server integrations.

### Step 1: Enable Token-Based Authentication

1. In NetSuite, go to **Setup → Company → Enable Features**
2. Click the **SuiteCloud** tab
3. Check **Token-Based Authentication**
4. Click **Save**

### Step 2: Create an Integration Record

1. Go to **Setup → Integration → Manage Integrations → New**
2. Fill in:
   - **Name**: `CorpayOne Integration`
   - **State**: `Enabled`
3. Under **Authentication**:
   - Check **Token-Based Authentication**
   - Uncheck **TBA: Authorization Flow** (not needed for server apps)
   - Uncheck **Authorization Code Grant** (not needed)
4. Click **Save**
5. **Copy the Consumer Key and Consumer Secret** — these are shown only once!

### Step 3: Create an Access Token

1. Go to **Setup → Users/Roles → Access Tokens → New**
2. Fill in:
   - **Application Name**: Select `CorpayOne Integration`
   - **User**: Select the user account the integration should act as
   - **Role**: Select a role with appropriate permissions (see next step)
   - **Token Name**: `CorpayOne Server Token`
3. Click **Save**
4. **Copy the Token ID and Token Secret** — these are shown only once!

### Step 4: Create a Dedicated Integration Role (Recommended)

Instead of using the Administrator role, create a dedicated role with minimal permissions:

1. Go to **Setup → Users/Roles → Manage Roles → New**
2. Name it `CorpayOne Integration Role`
3. Under **Permissions → Transactions**, add:
   - Vendor Bill: Full
   - Vendor Payment: Full
   - Find Transaction: View
4. Under **Permissions → Lists**, add:
   - Vendor: Full
   - Subsidiary: View
   - Account: View
   - Tax Code: View
   - Currency: View
5. Under **Permissions → Setup**, add:
   - SuiteScript: Full (for the Suitelet dashboard)
   - REST Web Services: Full
   - Log in using Access Tokens: Full
   - User Access Tokens: Full
6. Click **Save**

> **Why TBA and not OAuth 2.0 or user login?** Token-Based Authentication uses a static set of keys (consumer key/secret + token key/secret) that never expire unless revoked. It does **not** require a browser login, 2FA, or session management. This is the recommended approach for all server-to-server integrations in NetSuite.

### Summary of NetSuite Credentials

| Credential | Where to Find |
|---|---|
| **Account ID** | Setup → Company → Company Information (e.g., `1234567` or `1234567_SB1` for sandbox) |
| **Consumer Key** | From the Integration Record (Step 2) |
| **Consumer Secret** | From the Integration Record (Step 2) |
| **Token Key (ID)** | From the Access Token (Step 3) |
| **Token Secret** | From the Access Token (Step 3) |

---

## CorpayOne API Setup

1. Log in to your CorpayOne admin dashboard
2. Navigate to **Settings → API / Integrations**
3. Create a new API application:
   - **Name**: `NetSuite Integration`
   - **Type**: Server-to-server (OAuth2 Client Credentials)
4. Copy the **Client ID** and **Client Secret**
5. (Optional) Set up a webhook endpoint:
   - **URL**: `https://your-server.com/webhooks/corpayone`
   - **Events**: `invoice.created`, `invoice.updated`, `invoice.approved`, `payment.created`, `payment.completed`
   - Copy the **Webhook Secret** for signature verification

---

## Install & Configure the Integration

### 1. Clone and install

```bash
git clone <repository-url>
cd Corpay
npm install
```

### 2. Create your `.env` file

```bash
cp .env.example .env
```

### 3. Fill in your credentials

```env
# CorpayOne
CORPAYONE_API_BASE_URL=https://api.corpayone.com
CORPAYONE_CLIENT_ID=your_client_id
CORPAYONE_CLIENT_SECRET=your_client_secret
CORPAYONE_WEBHOOK_SECRET=your_webhook_secret

# NetSuite (Token-Based Auth — no 2FA needed!)
NETSUITE_ACCOUNT_ID=1234567
NETSUITE_CONSUMER_KEY=your_consumer_key
NETSUITE_CONSUMER_SECRET=your_consumer_secret
NETSUITE_TOKEN_KEY=your_token_key
NETSUITE_TOKEN_SECRET=your_token_secret

# Fallbacks — the dashboard mappings take priority over these
NETSUITE_SUBSIDIARY_ID=1
NETSUITE_AP_ACCOUNT_ID=400
NETSUITE_BANK_ACCOUNT_ID=152

# Sync settings
SYNC_INTERVAL_MINUTES=15
SYNC_LOOKBACK_HOURS=24

# Webhook server
WEBHOOK_PORT=3000
WEBHOOK_HOST=0.0.0.0

# Database
DATABASE_PATH=./data/sync.db

# Logging
LOG_LEVEL=info
```

### 4. Build

```bash
npm run build
```

---

## Deploy the NetSuite Configuration Dashboard

The integration includes a SuiteScript 2.1 Suitelet that provides a configuration dashboard directly inside NetSuite. This is how admins map CorpayOne accounts and tax codes to NetSuite, similar to how the Pleo NetSuite SuiteApp works.

### Option A: Manual Upload

1. In NetSuite, go to **Documents → Files → File Cabinet**
2. Create a folder: `SuiteScripts/CorpayOne`
3. Upload these files from `netsuite-suitescript/`:
   - `corpay_config_suitelet.js`
   - `corpay_config_client.js`
4. Go to **Customization → Scripting → Scripts → New**
5. Select the uploaded `corpay_config_suitelet.js`
6. Fill in:
   - **Name**: `CorpayOne Configuration`
   - **ID**: `customscript_corpay_config`
7. Under **Parameters**, create a script parameter:
   - **ID**: `custscript_corpay_api_url`
   - **Type**: Free-form text
   - **Default Value**: `http://your-integration-server:3000`
8. Click **Save** then **Deploy Script**
9. Configure the deployment:
   - **Status**: Released
   - **Audience**: Administrators
10. Click **Save**

### Option B: SuiteCloud Development Framework (SDF)

```bash
cd netsuite-suitescript
suitecloud project:deploy
```

### Accessing the Dashboard

After deployment, find the Suitelet at:
**Customization → Scripting → Script Deployments → CorpayOne Configuration**

You can also create a custom center link under **Customization → Centers and Tabs** so it appears in the NetSuite navigation menu.

---

## Configure Mappings in NetSuite

Open the CorpayOne Configuration Suitelet. The dashboard has five tabs:

### Tab 1: Subsidiary

Maps which NetSuite subsidiary CorpayOne transactions book into.

| Field | Description |
|---|---|
| **NetSuite Subsidiary** | Select from your subsidiaries dropdown |
| **CorpayOne Entity ID** | Optional — for multi-entity CorpayOne accounts |
| **Default** | Check to make this the primary subsidiary |

### Tab 2: Account Mapping

Maps CorpayOne account codes (from invoice line items) to NetSuite GL accounts.

| Field | Description |
|---|---|
| **CorpayOne Account Code** | The `account_code` from CorpayOne line items (e.g., `5010`) |
| **CorpayOne Label** | Human-readable label (e.g., "IT Equipment") |
| **NetSuite GL Account** | The target expense account in NetSuite (dropdown) |
| **Subsidiary** | Optional subsidiary-specific override |
| **Default** | Fallback account when no code matches |

**Example mappings:**

| CorpayOne Code | Label | NetSuite Account |
|---|---|---|
| `5010` | IT Equipment | 201 - IT Equipment |
| `5020` | Office Supplies | 202 - Office Supplies |
| `6100` | Cloud Services | 301 - Cloud & Hosting |
| `DEFAULT` | Default | 400 - Accounts Payable |

### Tab 3: Tax Code Mapping

Maps CorpayOne VAT rates to NetSuite tax codes.

| Field | Description |
|---|---|
| **CorpayOne VAT Rate (%)** | The VAT percentage (e.g., 25 for Danish Moms) |
| **Label** | Human-readable (e.g., "DK Moms 25%") |
| **NetSuite Tax Code** | The NetSuite tax code record (dropdown) |
| **Country Code** | Optional — two-letter country code (e.g., `DK`, `DE`) |
| **Subsidiary** | Optional subsidiary-specific override |
| **Default** | Fallback tax code |

**Example mappings:**

| VAT Rate | Label | Country | NetSuite Tax Code |
|---|---|---|---|
| 25% | DK Moms 25% | DK | DK-S-25 |
| 19% | DE USt 19% | DE | DE-S-19 |
| 20% | GB VAT 20% | GB | GB-S-20 |

### Tab 4: Bank Account

Configures which NetSuite bank account receives CorpayOne payments.

| Field | Description |
|---|---|
| **NetSuite Bank Account** | Select a bank account (Type: Bank) |
| **Currency** | Currency for this bank account |
| **Subsidiary** | Optional subsidiary-specific |
| **Default** | Fallback bank account |

**Example configuration:**

| Currency | NetSuite Bank Account |
|---|---|
| DKK | CorpayOne Bank (DKK) [Default] |
| EUR | CorpayOne Bank (EUR) |
| GBP | CorpayOne Bank (GBP) |

### Tab 5: Settings

| Setting | Default | Description |
|---|---|---|
| Sync Interval (minutes) | 15 | How often to poll CorpayOne for changes |
| Auto-create Vendors | Yes | Automatically create vendors in NetSuite |
| Upload Attachments | No | Upload invoice PDFs to NetSuite File Cabinet |
| Integration API URL | http://localhost:3000 | URL of the middleware server |

Click **Save Configuration** to push all mappings to the integration server.

---

## Run the Integration

### Server Mode (recommended for production)

```bash
npm start
```

This starts:
- **Webhook server** on port 3000 — receives real-time CorpayOne events
- **Scheduled sync** every 15 minutes — polls for changes
- **Initial sync** on startup — catches up on any missed data

### Single Sync (one-off)

```bash
# Incremental sync (last 24 hours)
node dist/index.js sync

# Full sync (all data)
node dist/index.js full
```

### Health Check

```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"corpayone-netsuite-integration"}
```

### Sync Status

```bash
curl http://localhost:3000/status
```

---

## Run the Demo

To see the full integration flow without any real API credentials:

```bash
npx ts-node demo/run-demo.ts
```

The demo simulates all 7 steps with mock data:
1. Configure mapping (account codes, tax codes, bank accounts, subsidiaries)
2. Fetch invoices from CorpayOne
3. Sync vendors to NetSuite
4. Sync vendor bills with mapped accounts and tax codes
5. Sync payments with mapped bank accounts
6. Handle a real-time webhook event
7. Show final sync status

---

## API Reference

### Configuration Endpoints (`/api/config/*`)

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/config/account-mappings` | List all account mappings |
| `POST` | `/api/config/account-mappings` | Create/update account mapping |
| `DELETE` | `/api/config/account-mappings/:id` | Delete account mapping |
| `GET` | `/api/config/tax-code-mappings` | List all tax code mappings |
| `POST` | `/api/config/tax-code-mappings` | Create/update tax code mapping |
| `DELETE` | `/api/config/tax-code-mappings/:id` | Delete tax code mapping |
| `GET` | `/api/config/bank-accounts` | List bank account configs |
| `POST` | `/api/config/bank-accounts` | Create/update bank account config |
| `DELETE` | `/api/config/bank-accounts/:id` | Delete bank account config |
| `GET` | `/api/config/subsidiaries` | List subsidiary configs |
| `POST` | `/api/config/subsidiaries` | Create/update subsidiary config |
| `DELETE` | `/api/config/subsidiaries/:id` | Delete subsidiary config |
| `GET` | `/api/config/settings` | Get all integration settings |
| `PUT` | `/api/config/settings/:key` | Update a setting |
| `GET` | `/api/config/summary` | Full configuration summary |

### Webhook

| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/webhooks/corpayone` | Receive CorpayOne webhook events |

### Example: Create an Account Mapping via API

```bash
curl -X POST http://localhost:3000/api/config/account-mappings \
  -H 'Content-Type: application/json' \
  -d '{
    "corpayone_account_code": "5010",
    "corpayone_label": "IT Equipment",
    "netsuite_account_id": "201",
    "netsuite_account_name": "IT Equipment"
  }'
```

### Example: Set a Bank Account for EUR Payments

```bash
curl -X POST http://localhost:3000/api/config/bank-accounts \
  -H 'Content-Type: application/json' \
  -d '{
    "netsuite_bank_account_id": "153",
    "netsuite_bank_account_name": "CorpayOne Bank (EUR)",
    "currency": "EUR"
  }'
```

---

## Troubleshooting

### "Missing required environment variable"

Ensure all required variables are set in `.env`:
- `CORPAYONE_CLIENT_ID`, `CORPAYONE_CLIENT_SECRET`
- `NETSUITE_ACCOUNT_ID`, `NETSUITE_CONSUMER_KEY`, `NETSUITE_CONSUMER_SECRET`, `NETSUITE_TOKEN_KEY`, `NETSUITE_TOKEN_SECRET`

### NetSuite 401 / Invalid Login

- Verify Token-Based Auth credentials are correct
- Ensure the integration record is **Enabled**
- Ensure the access token is **Active** (not revoked)
- Verify the role has the required permissions
- Check the Account ID format (use underscore for sandbox: `1234567_SB1`)

### Bills not syncing

- Only invoices with status `approved`, `scheduled`, `paid`, or `partially_paid` are synced
- Draft, pending_approval, rejected, and cancelled invoices are skipped
- Check `/status` endpoint for error details
- Verify account mappings are configured (unmapped accounts fall back to the default AP account)

### Payments stuck as "pending"

- Payments only sync when their corresponding bill has been synced first
- Pending payments are automatically retried on the next sync cycle
- Only `completed` payments are synced

### Tax codes not appearing on bill lines

- Verify tax code mappings are configured for the invoice's VAT rates
- Tax codes are matched by: VAT rate + country code + subsidiary
- If no match is found, the tax code field is omitted (NetSuite uses its default)

### Suitelet not loading

- Verify `custscript_corpay_api_url` points to your integration server
- The server must be reachable from NetSuite's cloud
- Check execution log: **Customization → Scripting → Script Execution Log**
