import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { config } from '../config';
import { logger } from '../logger';
import {
  upsertSyncedVendor,
  getSyncedVendorByCorpayId,
} from '../database/db';
import type { CorpayOneVendor } from '../types/corpayone';

/**
 * Ensures a CorpayOne vendor exists in NetSuite.
 * Looks up by external ID first, then by name, and creates if not found.
 *
 * Returns the NetSuite internal vendor ID.
 */
export async function ensureVendorInNetSuite(
  vendor: CorpayOneVendor,
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<string> {
  // Check local sync database first
  const syncedVendor = getSyncedVendorByCorpayId(vendor.id);
  if (syncedVendor?.netsuite_vendor_id && syncedVendor.status === 'synced') {
    return syncedVendor.netsuite_vendor_id;
  }

  // Try to find vendor in NetSuite by external ID
  const externalId = `corpay-vendor-${vendor.id}`;
  let nsVendor = await netsuiteClient.findVendorByExternalId(externalId);

  if (nsVendor?.id) {
    upsertSyncedVendor(vendor.id, vendor.name, nsVendor.id, 'synced');
    logger.info(
      { corpayone_vendor_id: vendor.id, netsuite_vendor_id: nsVendor.id },
      'Found existing vendor in NetSuite by external ID',
    );
    return nsVendor.id;
  }

  // Try to find by name
  nsVendor = await netsuiteClient.findVendorByName(vendor.name);
  if (nsVendor?.id) {
    upsertSyncedVendor(vendor.id, vendor.name, nsVendor.id, 'synced');
    logger.info(
      { corpayone_vendor_id: vendor.id, netsuite_vendor_id: nsVendor.id },
      'Found existing vendor in NetSuite by name',
    );
    return nsVendor.id;
  }

  // Create new vendor in NetSuite
  try {
    const newVendorId = await netsuiteClient.createVendor({
      companyName: vendor.name,
      externalId,
      email: vendor.email,
      phone: vendor.phone,
      taxIdNum: vendor.vat_number || vendor.registration_number,
      subsidiary: config.netsuite.subsidiaryId
        ? { id: config.netsuite.subsidiaryId }
        : undefined,
    });

    upsertSyncedVendor(vendor.id, vendor.name, newVendorId, 'synced');
    logger.info(
      { corpayone_vendor_id: vendor.id, netsuite_vendor_id: newVendorId },
      'Created new vendor in NetSuite',
    );
    return newVendorId;
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    upsertSyncedVendor(vendor.id, vendor.name, null, 'failed', errorMessage);
    throw error;
  }
}
