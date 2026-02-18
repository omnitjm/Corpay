# Azure Functions Deployment Guide

## Oversigt

Integrationen kører som Azure Functions med:
- **Timer-trigger** → synkroniserer hvert 15. minut (scheduled sync)
- **HTTP-trigger** → modtager webhooks fra CorpayOne (valgfrit)
- **Health endpoint** → tjek om funktionen kører
- **Manual sync** → trigger sync manuelt via HTTP

## Forudsætninger

1. En Azure-konto (opret via portal.azure.com med jeres Office 365-login)
2. Azure CLI installeret (`npm install -g azure-functions-core-tools@4`)
3. CorpayOne API credentials (client_id + client_secret)
4. NetSuite Token-Based Authentication credentials

## Trin 1: Opret Azure Function App

```bash
# Log ind i Azure
az login

# Opret resource group
az group create --name corpayone-integration-rg --location westeurope

# Opret storage account (påkrævet af Azure Functions)
az storage account create \
  --name corpayonestorage \
  --resource-group corpayone-integration-rg \
  --location westeurope \
  --sku Standard_LRS

# Opret Function App
az functionapp create \
  --name corpayone-netsuite-sync \
  --resource-group corpayone-integration-rg \
  --storage-account corpayonestorage \
  --consumption-plan-location westeurope \
  --runtime node \
  --runtime-version 22 \
  --functions-version 4
```

## Trin 2: Konfigurer miljøvariabler

```bash
az functionapp config appsettings set \
  --name corpayone-netsuite-sync \
  --resource-group corpayone-integration-rg \
  --settings \
    CORPAYONE_API_BASE_URL="https://api.corpayone.com" \
    CORPAYONE_CLIENT_ID="<dit-client-id>" \
    CORPAYONE_CLIENT_SECRET="<dit-client-secret>" \
    CORPAYONE_WEBHOOK_SECRET="<din-webhook-secret>" \
    NETSUITE_ACCOUNT_ID="<dit-netsuite-account-id>" \
    NETSUITE_CONSUMER_KEY="<din-consumer-key>" \
    NETSUITE_CONSUMER_SECRET="<din-consumer-secret>" \
    NETSUITE_TOKEN_KEY="<din-token-key>" \
    NETSUITE_TOKEN_SECRET="<din-token-secret>"
```

Eller gør det i Azure Portal: Function App → Configuration → Application settings.

## Trin 3: Deploy

### Option A: Via GitHub Actions (anbefalet)

1. Gå til Azure Portal → din Function App → Deployment Center → Get publish profile
2. Kopier indholdet af publish-profilen
3. Gå til GitHub → dit repo → Settings → Secrets → New repository secret
4. Navn: `AZURE_FUNCTIONAPP_PUBLISH_PROFILE`, værdi: publish-profilen
5. Push til `main` → GitHub Actions deployer automatisk

### Option B: Manuelt via CLI

```bash
npm run azure:build
cd dist
func azure functionapp publish corpayone-netsuite-sync
```

## Trin 4: Verificer

```bash
# Tjek health endpoint
curl https://corpayone-netsuite-sync.azurewebsites.net/api/health

# Trigger en manuel sync
curl -X POST "https://corpayone-netsuite-sync.azurewebsites.net/api/sync?code=<din-function-key>"
```

## Webhook URL (giv denne til CorpayOne)

```
https://corpayone-netsuite-sync.azurewebsites.net/api/webhooks/corpayone
```

## Pris

Med Azure Functions Consumption Plan:
- Første 1 million kald/måned: **gratis**
- 400.000 GB-s compute/måned: **gratis**
- Ved ~100 syncs/dag (96 timer-triggers + webhooks): **0 kr/måned**

## Logs

```bash
# Se live logs
func azure functionapp logstream corpayone-netsuite-sync

# Eller i Azure Portal: Function App → Monitor
```
