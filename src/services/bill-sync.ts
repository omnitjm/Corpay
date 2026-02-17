import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { logger } from '../logger';
import {
  upsertSyncedBill,
  getSyncedBillByCorpayId,
} from '../database/db';
import {
  mapInvoiceToVendorBill,
  isSyncableStatus,
} from '../mapping/invoice-mapper';
import { ensureVendorInNetSuite } from './vendor-sync';
import type { CorpayOneInvoice } from '../types/corpayone';

export interface BillSyncResult {
  processed: number;
  synced: number;
  failed: number;
  skipped: number;
  errors: Array<{ invoiceId: string; error: string }>;
}

/**
 * Synchronize vendor bills from CorpayOne to NetSuite.
 *
 * For each approved/payable invoice in CorpayOne:
 * 1. Ensure the vendor exists in NetSuite
 * 2. Check if the bill has already been synced
 * 3. Create the vendor bill in NetSuite
 * 4. Track the sync status in the local database
 */
export async function syncBills(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
  options: { updatedSince?: string } = {},
): Promise<BillSyncResult> {
  const result: BillSyncResult = {
    processed: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  logger.info({ updatedSince: options.updatedSince }, 'Starting bill sync from CorpayOne to NetSuite');

  // Fetch invoices from CorpayOne
  const invoices = await corpayClient.getAllInvoices({
    updatedSince: options.updatedSince,
  });

  logger.info({ invoiceCount: invoices.length }, 'Fetched invoices from CorpayOne');

  for (const invoice of invoices) {
    result.processed++;

    try {
      await syncSingleBill(invoice, corpayClient, netsuiteClient, result);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      result.failed++;
      result.errors.push({ invoiceId: invoice.id, error: errorMessage });
      logger.error(
        { invoiceId: invoice.id, error: errorMessage },
        'Failed to sync bill',
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
    'Bill sync completed',
  );

  return result;
}

/** Sync a single CorpayOne invoice to NetSuite */
export async function syncSingleBill(
  invoice: CorpayOneInvoice,
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
  result: BillSyncResult,
): Promise<void> {
  // Check if the invoice status is syncable
  if (!isSyncableStatus(invoice.status)) {
    result.skipped++;
    logger.debug(
      { invoiceId: invoice.id, status: invoice.status },
      'Skipping invoice with non-syncable status',
    );
    return;
  }

  // Check if already synced
  const existingSync = getSyncedBillByCorpayId(invoice.id);
  if (existingSync?.status === 'synced' && existingSync.netsuite_vendor_bill_id) {
    // Check if the CorpayOne status has changed since last sync
    if (existingSync.corpayone_status === invoice.status &&
        existingSync.corpayone_updated_at === invoice.updated_at) {
      result.skipped++;
      logger.debug(
        { invoiceId: invoice.id },
        'Invoice already synced and unchanged',
      );
      return;
    }
  }

  // Also check if a vendor bill already exists in NetSuite by external ID
  const externalId = `corpay-${invoice.id}`;
  const existingBill = await netsuiteClient.findVendorBillByExternalId(externalId);
  if (existingBill) {
    // Bill already exists in NetSuite, update our tracking
    upsertSyncedBill(
      invoice.id,
      existingBill.id,
      existingSync?.netsuite_vendor_id || null,
      'synced',
      invoice.status,
      invoice.updated_at,
    );
    result.skipped++;
    logger.debug(
      { invoiceId: invoice.id, netsuiteBillId: existingBill.id },
      'Vendor bill already exists in NetSuite',
    );
    return;
  }

  // Ensure vendor exists in NetSuite
  const netsuiteVendorId = await ensureVendorInNetSuite(
    invoice.vendor,
    corpayClient,
    netsuiteClient,
  );

  // Map CorpayOne invoice to NetSuite vendor bill
  const vendorBill = mapInvoiceToVendorBill(invoice, netsuiteVendorId);

  // Create vendor bill in NetSuite
  try {
    const netsuiteBillId = await netsuiteClient.createVendorBill(vendorBill);

    upsertSyncedBill(
      invoice.id,
      netsuiteBillId,
      netsuiteVendorId,
      'synced',
      invoice.status,
      invoice.updated_at,
    );

    result.synced++;
    logger.info(
      {
        corpayone_invoice_id: invoice.id,
        netsuite_vendor_bill_id: netsuiteBillId,
        amount: invoice.total_amount,
        currency: invoice.currency,
      },
      'Successfully synced vendor bill to NetSuite',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedBill(
      invoice.id,
      null,
      netsuiteVendorId,
      'failed',
      invoice.status,
      invoice.updated_at,
      errorMessage,
    );
    throw error;
  }
}
