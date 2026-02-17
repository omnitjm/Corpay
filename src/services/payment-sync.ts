import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { logger } from '../logger';
import {
  upsertSyncedPayment,
  getSyncedPaymentByCorpayId,
  getSyncedBillByCorpayId,
} from '../database/db';
import {
  mapPaymentToVendorPayment,
  isSyncablePayment,
} from '../mapping/invoice-mapper';
import type { CorpayOneInvoice, CorpayOnePayment } from '../types/corpayone';

export interface PaymentSyncResult {
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
  errors: Array<{ paymentId: string; error: string }>;
}

/**
 * Synchronize payments from CorpayOne to NetSuite.
 *
 * For each completed payment in CorpayOne:
 * 1. Find the corresponding synced vendor bill
 * 2. Check if the payment has already been synced
 * 3. Create a vendor payment in NetSuite applied against the bill
 * 4. Track the sync status
 */
export async function syncPayments(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
  options: { updatedSince?: string } = {},
): Promise<PaymentSyncResult> {
  const result: PaymentSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  logger.info({ updatedSince: options.updatedSince }, 'Starting payment sync from CorpayOne to NetSuite');

  // Fetch payments from CorpayOne
  const payments = await corpayClient.getAllPayments({
    updatedSince: options.updatedSince,
  });

  logger.info({ paymentCount: payments.length }, 'Fetched payments from CorpayOne');

  for (const payment of payments) {
    result.processed++;

    try {
      await syncSinglePayment(payment, corpayClient, netsuiteClient, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({ paymentId: payment.id, error: errorMessage });
      logger.error(
        { paymentId: payment.id, error: errorMessage },
        'Failed to sync payment',
      );
    }
  }

  logger.info(
    {
      processed: result.processed,
      synced: result.synced,
      failed: result.failed,
      skipped: result.skipped,
    },
    'Payment sync completed',
  );

  return result;
}

/** Sync a single CorpayOne payment to NetSuite */
export async function syncSinglePayment(
  payment: CorpayOnePayment,
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
  result: PaymentSyncResult,
): Promise<void> {
  // Only sync completed payments
  if (!isSyncablePayment(payment)) {
    result.skipped++;
    logger.debug(
      { paymentId: payment.id, status: payment.status },
      'Skipping non-completed payment',
    );
    return;
  }

  // Check if already synced
  const existingSync = getSyncedPaymentByCorpayId(payment.id);
  if (existingSync?.status === 'synced' && existingSync.netsuite_payment_id) {
    result.skipped++;
    logger.debug({ paymentId: payment.id }, 'Payment already synced');
    return;
  }

  // Check if a vendor payment already exists in NetSuite
  const externalId = `corpay-pay-${payment.id}`;
  const existingPayment = await netsuiteClient.findVendorPaymentByExternalId(externalId);
  if (existingPayment) {
    upsertSyncedPayment(
      payment.id,
      payment.invoice_id,
      existingPayment.id,
      null,
      'synced',
      payment.status,
    );
    result.skipped++;
    return;
  }

  // Find the corresponding synced bill
  const syncedBill = getSyncedBillByCorpayId(payment.invoice_id);
  if (!syncedBill?.netsuite_vendor_bill_id || !syncedBill.netsuite_vendor_id) {
    // The bill hasn't been synced yet - mark payment as pending
    upsertSyncedPayment(
      payment.id,
      payment.invoice_id,
      null,
      null,
      'pending',
      payment.status,
      'Corresponding vendor bill not yet synced to NetSuite',
    );
    result.skipped++;
    logger.warn(
      { paymentId: payment.id, invoiceId: payment.invoice_id },
      'Skipping payment - vendor bill not yet synced',
    );
    return;
  }

  // Fetch the full invoice to get vendor details for the payment
  let invoice: CorpayOneInvoice;
  try {
    invoice = await corpayClient.getInvoice(payment.invoice_id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedPayment(
      payment.id,
      payment.invoice_id,
      null,
      syncedBill.netsuite_vendor_bill_id,
      'failed',
      payment.status,
      `Failed to fetch invoice: ${errorMessage}`,
    );
    throw error;
  }

  // Map to NetSuite vendor payment
  const vendorPayment = mapPaymentToVendorPayment(
    payment,
    invoice,
    syncedBill.netsuite_vendor_id,
    syncedBill.netsuite_vendor_bill_id,
  );

  // Create vendor payment in NetSuite
  try {
    const netsuitePaymentId = await netsuiteClient.createVendorPayment(vendorPayment);

    upsertSyncedPayment(
      payment.id,
      payment.invoice_id,
      netsuitePaymentId,
      syncedBill.netsuite_vendor_bill_id,
      'synced',
      payment.status,
    );

    result.synced++;
    logger.info(
      {
        corpayone_payment_id: payment.id,
        netsuite_payment_id: netsuitePaymentId,
        amount: payment.amount,
        currency: payment.currency,
      },
      'Successfully synced payment to NetSuite',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedPayment(
      payment.id,
      payment.invoice_id,
      null,
      syncedBill.netsuite_vendor_bill_id,
      'failed',
      payment.status,
      errorMessage,
    );
    throw error;
  }
}

/**
 * Retry syncing payments that were skipped because their bills weren't synced yet.
 * This should run after bill sync to pick up pending payments.
 */
export async function retryPendingPayments(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<PaymentSyncResult> {
  const result: PaymentSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  // This uses the database to find pending payments and retries them
  // by re-fetching the payment from CorpayOne and attempting sync
  const { getDatabase } = await import('../database/db');
  const db = getDatabase();

  const pendingPayments = db
    .prepare("SELECT * FROM synced_payments WHERE status = 'pending'")
    .all() as Array<{ corpayone_payment_id: string; corpayone_invoice_id: string }>;

  logger.info({ count: pendingPayments.length }, 'Retrying pending payments');

  for (const pending of pendingPayments) {
    result.processed++;
    try {
      const payment = await corpayClient.getPayment(pending.corpayone_payment_id);
      await syncSinglePayment(payment, corpayClient, netsuiteClient, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({
        paymentId: pending.corpayone_payment_id,
        error: errorMessage,
      });
    }
  }

  return result;
}
