import { HttpRequest, HttpResponseInit, InvocationContext, app } from '@azure/functions';
import crypto from 'crypto';
import { CorpayOneClient } from '../../src/clients/corpayone-client';
import { NetSuiteClient } from '../../src/clients/netsuite-client';
import { handleWebhookEvent } from '../../src/services/webhook-handler';
import { getDatabase, closeDatabase } from '../../src/database/db';
import type { CorpayOneWebhookEvent } from '../../src/types/corpayone';

/**
 * Azure Function: Webhook Endpoint (HTTP Trigger)
 *
 * Receives real-time events from CorpayOne (invoice.approved, payment.completed, etc.)
 * and processes them immediately.
 *
 * URL: https://<your-function-app>.azurewebsites.net/api/webhooks/corpayone
 */
async function webhook(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log('CorpayOne webhook received');

  try {
    getDatabase();

    // Verify webhook signature if secret is configured
    const webhookSecret = process.env.CORPAYONE_WEBHOOK_SECRET;
    if (webhookSecret) {
      const signature = request.headers.get('x-webhook-signature');
      const body = await request.text();

      if (!signature || !verifySignature(Buffer.from(body), signature, webhookSecret)) {
        context.warn('Invalid webhook signature');
        return { status: 401, jsonBody: { error: 'Invalid signature' } };
      }

      // Parse the verified body
      const event = JSON.parse(body) as CorpayOneWebhookEvent;
      return await processEvent(event, context);
    }

    // No secret configured — parse body directly
    const event = await request.json() as CorpayOneWebhookEvent;
    return await processEvent(event, context);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    context.error(`Webhook error: ${msg}`);
    return { status: 500, jsonBody: { error: 'Internal server error' } };
  } finally {
    closeDatabase();
  }
}

async function processEvent(
  event: CorpayOneWebhookEvent,
  context: InvocationContext,
): Promise<HttpResponseInit> {
  if (!event.type || !event.id) {
    return { status: 400, jsonBody: { error: 'Invalid webhook payload' } };
  }

  context.log(`Processing event: ${event.type} (${event.id})`);

  const corpayClient = new CorpayOneClient();
  const netsuiteClient = new NetSuiteClient();

  await handleWebhookEvent(event, corpayClient, netsuiteClient);

  context.log(`Event processed successfully: ${event.id}`);
  return { status: 200, jsonBody: { received: true, eventId: event.id } };
}

function verifySignature(payload: Buffer, signature: string, secret: string): boolean {
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  } catch {
    return false;
  }
}

app.http('webhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'webhooks/corpayone',
  handler: webhook,
});
