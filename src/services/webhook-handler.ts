import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { logger } from '../logger';
import { createSyncRun, completeSyncRun } from '../database/db';
import { syncSingleBill, type BillSyncResult } from './bill-sync';
import { syncSinglePayment, type PaymentSyncResult } from './payment-sync';
import type { CorpayOneWebhookEvent } from '../types/corpayone';

/**
 * Handle incoming webhook events from CorpayOne.
 *
 * Processes invoice and payment events in real-time, syncing
 * changes to NetSuite as they happen.
 */
export async function handleWebhookEvent(
  event: CorpayOneWebhookEvent,
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<void> {
  logger.info(
    { eventId: event.id, eventType: event.type },
    'Processing CorpayOne webhook event',
  );

  const syncRunId = createSyncRun('webhook');
  const billResult: BillSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };
  const paymentResult: PaymentSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  try {
    switch (event.type) {
      case 'invoice.created':
      case 'invoice.updated':
      case 'invoice.approved': {
        const invoiceId = event.data.invoice_id as string || event.data.id as string;
        if (!invoiceId) {
          logger.warn({ event }, 'Webhook event missing invoice ID');
          break;
        }

        const invoice = await corpayClient.getInvoice(invoiceId);
        await syncSingleBill(invoice, corpayClient, netsuiteClient, billResult);
        break;
      }

      case 'payment.created':
      case 'payment.completed': {
        const paymentId = event.data.payment_id as string || event.data.id as string;
        if (!paymentId) {
          logger.warn({ event }, 'Webhook event missing payment ID');
          break;
        }

        const payment = await corpayClient.getPayment(paymentId);
        await syncSinglePayment(payment, corpayClient, netsuiteClient, paymentResult);
        break;
      }

      case 'invoice.rejected':
      case 'invoice.deleted': {
        // Log but don't delete from NetSuite (avoid data loss)
        logger.info(
          { eventType: event.type, data: event.data },
          'Invoice rejected/deleted in CorpayOne - manual review may be needed in NetSuite',
        );
        break;
      }

      case 'payment.failed': {
        logger.warn(
          { eventType: event.type, data: event.data },
          'Payment failed in CorpayOne - manual review may be needed',
        );
        break;
      }

      default:
        logger.debug({ eventType: event.type }, 'Ignoring unhandled webhook event type');
    }

    completeSyncRun(syncRunId, {
      bills_processed: billResult.processed,
      bills_synced: billResult.synced,
      bills_failed: billResult.failed,
      payments_processed: paymentResult.processed,
      payments_synced: paymentResult.synced,
      payments_failed: paymentResult.failed,
    });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSyncRun(
      syncRunId,
      {
        bills_processed: billResult.processed,
        bills_synced: billResult.synced,
        bills_failed: billResult.failed,
        payments_processed: paymentResult.processed,
        payments_synced: paymentResult.synced,
        payments_failed: paymentResult.failed,
      },
      errorMessage,
    );
    throw error;
  }
}
