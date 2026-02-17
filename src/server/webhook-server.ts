import express from 'express';
import crypto from 'crypto';
import { config } from '../config';
import { logger } from '../logger';
import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { handleWebhookEvent } from '../services/webhook-handler';
import type { CorpayOneWebhookEvent } from '../types/corpayone';

/**
 * Creates an Express server to receive CorpayOne webhook events.
 *
 * The server:
 * - Validates webhook signatures when a secret is configured
 * - Processes events asynchronously to avoid timeouts
 * - Provides a health check endpoint
 */
export function createWebhookServer(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): express.Application {
  const app = express();

  // Parse JSON body with raw body for signature verification
  app.use(
    express.json({
      verify: (req: express.Request & { rawBody?: Buffer }, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );

  // Health check endpoint
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', service: 'corpayone-netsuite-integration' });
  });

  // CorpayOne webhook endpoint
  app.post('/webhooks/corpayone', async (req, res) => {
    try {
      // Verify webhook signature if secret is configured
      if (config.corpayone.webhookSecret) {
        const signature = req.headers['x-webhook-signature'] as string;
        if (!verifyWebhookSignature(
          (req as express.Request & { rawBody?: Buffer }).rawBody || Buffer.from(''),
          signature,
          config.corpayone.webhookSecret,
        )) {
          logger.warn('Invalid webhook signature');
          res.status(401).json({ error: 'Invalid signature' });
          return;
        }
      }

      const event = req.body as CorpayOneWebhookEvent;

      if (!event.type || !event.id) {
        res.status(400).json({ error: 'Invalid webhook payload' });
        return;
      }

      logger.info(
        { eventId: event.id, eventType: event.type },
        'Received CorpayOne webhook',
      );

      // Respond immediately to acknowledge receipt, then process asynchronously
      res.status(200).json({ received: true, eventId: event.id });

      // Process the event asynchronously
      handleWebhookEvent(event, corpayClient, netsuiteClient).catch((error) => {
        logger.error(
          { eventId: event.id, error: error instanceof Error ? error.message : String(error) },
          'Failed to process webhook event',
        );
      });
    } catch (error) {
      logger.error(
        { error: error instanceof Error ? error.message : String(error) },
        'Webhook endpoint error',
      );
      res.status(500).json({ error: 'Internal server error' });
    }
  });

  // Sync status endpoint
  app.get('/status', (_req, res) => {
    try {
      const { getDatabase } = require('../database/db');
      const db = getDatabase();

      const billStats = db
        .prepare(
          `SELECT status, COUNT(*) as count FROM synced_bills GROUP BY status`,
        )
        .all();

      const paymentStats = db
        .prepare(
          `SELECT status, COUNT(*) as count FROM synced_payments GROUP BY status`,
        )
        .all();

      const lastRun = db
        .prepare(
          `SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1`,
        )
        .get();

      res.json({
        bills: billStats,
        payments: paymentStats,
        lastSyncRun: lastRun,
      });
    } catch (error) {
      res.status(500).json({
        error: 'Failed to fetch status',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  });

  return app;
}

/** Verify CorpayOne webhook signature using HMAC-SHA256 */
function verifyWebhookSignature(
  payload: Buffer,
  signature: string,
  secret: string,
): boolean {
  if (!signature) return false;

  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex');

  try {
    return crypto.timingSafeEqual(
      Buffer.from(signature),
      Buffer.from(expectedSignature),
    );
  } catch {
    return false;
  }
}

/** Start the webhook server */
export function startWebhookServer(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): void {
  const app = createWebhookServer(corpayClient, netsuiteClient);

  app.listen(config.webhook.port, config.webhook.host, () => {
    logger.info(
      { host: config.webhook.host, port: config.webhook.port },
      'Webhook server started',
    );
  });
}
