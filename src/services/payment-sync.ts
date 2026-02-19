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
import type { CorpayOneExpense, CorpayOnePayment } from '../types/corpayone';

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
 * For each completed payment: find the corresponding synced vendor bill
 * and create a vendor payment in NetSuite applied against it.
 */
export async function syncPayments(
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

  logger.info('Starting payment sync from CorpayOne to NetSuite');

  const payments = await corpayClient.getAllPayments();
  logger.info({ paymentCount: payments.length }, 'Fetched payments from CorpayOne');

  for (const payment of payments) {
    result.processed++;
    try {
      await syncSinglePayment(payment, corpayClient, netsuiteClient, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({ paymentId: payment.id, error: errorMessage });
      logger.error({ paymentId: payment.id, error: errorMessage }, 'Failed to sync payment');
    }
  }

  logger.info(
    { processed: result.processed, synced: result.synced, failed: result.failed, skipped: result.skipped },
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
  if (!isSyncablePayment(payment)) {
    result.skipped++;
    logger.debug({ paymentId: payment.id, status: payment.status }, 'Skipping non-completed payment');
    return;
  }

  const existingSync = getSyncedPaymentByCorpayId(payment.id);
  if (existingSync?.status === 'synced' && existingSync.netsuite_payment_id) {
    result.skipped++;
    logger.debug({ paymentId: payment.id }, 'Payment already synced');
    return;
  }

  const externalId = `corpay-pay-${payment.id}`;
  const existingPayment = await netsuiteClient.findVendorPaymentByExternalId(externalId);
  if (existingPayment) {
    upsertSyncedPayment(payment.id, payment.expense_id, existingPayment.id, null, 'synced', payment.status);
    result.skipped++;
    return;
  }

  // Find the corresponding synced bill
  const syncedBill = getSyncedBillByCorpayId(payment.expense_id);
  if (!syncedBill?.netsuite_vendor_bill_id || !syncedBill.netsuite_vendor_id) {
    upsertSyncedPayment(
      payment.id,
      payment.expense_id,
      null,
      null,
      'pending',
      payment.status,
      'Corresponding vendor bill not yet synced to NetSuite',
    );
    result.skipped++;
    logger.warn({ paymentId: payment.id, expenseId: payment.expense_id }, 'Skipping payment — vendor bill not yet synced');
    return;
  }

  // Fetch the full expense to get context for the payment memo
  let expense: CorpayOneExpense;
  try {
    expense = await corpayClient.getExpense(payment.expense_id);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedPayment(
      payment.id,
      payment.expense_id,
      null,
      syncedBill.netsuite_vendor_bill_id,
      'failed',
      payment.status,
      `Failed to fetch expense: ${errorMessage}`,
    );
    throw error;
  }

  const vendorPayment = mapPaymentToVendorPayment(
    payment,
    expense,
    syncedBill.netsuite_vendor_id,
    syncedBill.netsuite_vendor_bill_id,
  );

  try {
    const netsuitePaymentId = await netsuiteClient.createVendorPayment(vendorPayment);

    upsertSyncedPayment(
      payment.id,
      payment.expense_id,
      netsuitePaymentId,
      syncedBill.netsuite_vendor_bill_id,
      'synced',
      payment.status,
    );

    result.synced++;
    logger.info(
      { corpayone_payment_id: payment.id, netsuite_payment_id: netsuitePaymentId, amount: payment.amount, currency: payment.currency },
      'Successfully synced payment to NetSuite',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedPayment(
      payment.id,
      payment.expense_id,
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
 * Retry payments that were skipped because their bills weren't synced yet.
 * Should run after bill sync.
 */
export async function retryPendingPayments(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<PaymentSyncResult> {
  const result: PaymentSyncResult = { processed: 0, synced: 0, failed: 0, skipped: 0, errors: [] };

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
      result.errors.push({ paymentId: pending.corpayone_payment_id, error: errorMessage });
    }
  }

  return result;
}
