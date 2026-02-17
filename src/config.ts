import dotenv from 'dotenv';

dotenv.config();

function required(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

function optional(key: string, defaultValue: string): string {
  return process.env[key] || defaultValue;
}

export const config = {
  corpayone: {
    apiBaseUrl: optional('CORPAYONE_API_BASE_URL', 'https://api.corpayone.com'),
    clientId: required('CORPAYONE_CLIENT_ID'),
    clientSecret: required('CORPAYONE_CLIENT_SECRET'),
    webhookSecret: optional('CORPAYONE_WEBHOOK_SECRET', ''),
  },
  netsuite: {
    accountId: required('NETSUITE_ACCOUNT_ID'),
    consumerKey: required('NETSUITE_CONSUMER_KEY'),
    consumerSecret: required('NETSUITE_CONSUMER_SECRET'),
    tokenKey: required('NETSUITE_TOKEN_KEY'),
    tokenSecret: required('NETSUITE_TOKEN_SECRET'),
    subsidiaryId: optional('NETSUITE_SUBSIDIARY_ID', ''),
    apAccountId: optional('NETSUITE_AP_ACCOUNT_ID', ''),
    bankAccountId: optional('NETSUITE_BANK_ACCOUNT_ID', ''),
  },
  sync: {
    intervalMinutes: parseInt(optional('SYNC_INTERVAL_MINUTES', '15'), 10),
    lookbackHours: parseInt(optional('SYNC_LOOKBACK_HOURS', '24'), 10),
  },
  webhook: {
    port: parseInt(optional('WEBHOOK_PORT', '3000'), 10),
    host: optional('WEBHOOK_HOST', '0.0.0.0'),
  },
  database: {
    path: optional('DATABASE_PATH', './data/sync.db'),
  },
  logLevel: optional('LOG_LEVEL', 'info'),
} as const;
