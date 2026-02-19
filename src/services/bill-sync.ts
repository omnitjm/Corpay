import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { logger } from '../logger';
import {
  upsertSyncedBill,
  getSyncedBillByCorpayId,
} from '../database/db';
import {
  mapExpenseToVendorBill,
  isSyncableStatus,
} from '../mapping/invoice-mapper';
import { ensureVendorInNetSuite } from './vendor-sync';
import type { CorpayOneExpense } from '../types/corpayone';

export interface BillSyncResult {
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
  errors: Array<{ expenseId: string; error: string }>;
}

/**
 * Synchronize vendor bills from CorpayOne to NetSuite.
 *
 * Fetches all expenses and syncs those in syncable states
 * (Booked = approved, Awaiting = ready for payment, Paid = settled).
 */
export async function syncBills(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<BillSyncResult> {
  const result: BillSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  logger.info('Starting bill sync from CorpayOne to NetSuite');

  const expenses = await corpayClient.getAllExpenses();
  logger.info({ expenseCount: expenses.length }, 'Fetched expenses from CorpayOne');

  for (const expense of expenses) {
    result.processed++;
    try {
      await syncSingleBill(expense, corpayClient, netsuiteClient, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({ expenseId: expense.id, error: errorMessage });
      logger.error({ expenseId: expense.id, error: errorMessage }, 'Failed to sync bill');
    }
  }

  logger.info(
    { processed: result.processed, synced: result.synced, failed: result.failed, skipped: result.skipped },
    'Bill sync completed',
  );

  return result;
}

/** Sync a single CorpayOne expense to NetSuite as a vendor bill */
export async function syncSingleBill(
  expense: CorpayOneExpense,
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
  result: BillSyncResult,
): Promise<void> {
  if (!isSyncableStatus(expense.state)) {
    result.skipped++;
    logger.debug({ expenseId: expense.id, state: expense.state }, 'Skipping expense with non-syncable state');
    return;
  }

  // Skip if already synced with the same state (no change)
  const existingSync = getSyncedBillByCorpayId(expense.id);
  if (existingSync?.status === 'synced' && existingSync.netsuite_vendor_bill_id) {
    if (existingSync.corpayone_status === expense.state) {
      result.skipped++;
      logger.debug({ expenseId: expense.id }, 'Expense already synced and state unchanged');
      return;
    }
  }

  // Check if vendor bill already exists in NetSuite
  const externalId = `corpay-${expense.id}`;
  const existingBill = await netsuiteClient.findVendorBillByExternalId(externalId);
  if (existingBill) {
    upsertSyncedBill(
      expense.id,
      existingBill.id,
      existingSync?.netsuite_vendor_id || null,
      'synced',
      expense.state,
      expense.issueDate,
    );
    result.skipped++;
    logger.debug({ expenseId: expense.id, netsuiteBillId: existingBill.id }, 'Vendor bill already exists in NetSuite');
    return;
  }

  if (!expense.vendor) {
    result.skipped++;
    logger.warn({ expenseId: expense.id }, 'Skipping expense with no vendor');
    return;
  }

  const netsuiteVendorId = await ensureVendorInNetSuite(expense.vendor, corpayClient, netsuiteClient);
  const vendorBill = mapExpenseToVendorBill(expense, netsuiteVendorId);

  try {
    const netsuiteBillId = await netsuiteClient.createVendorBill(vendorBill);

    upsertSyncedBill(
      expense.id,
      netsuiteBillId,
      netsuiteVendorId,
      'synced',
      expense.state,
      expense.issueDate,
    );

    result.synced++;
    logger.info(
      { corpayone_expense_id: expense.id, netsuite_vendor_bill_id: netsuiteBillId, amount: expense.amount, currency: expense.currency },
      'Successfully synced vendor bill to NetSuite',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedBill(expense.id, null, netsuiteVendorId, 'failed', expense.state, expense.issueDate, errorMessage);
    throw error;
  }
}
