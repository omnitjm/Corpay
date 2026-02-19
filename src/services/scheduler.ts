import cron from 'node-cron';
import { config } from '../config';
import { logger } from '../logger';
import { CorpayOneClient } from '../clients/corpayone-client';
import { NetSuiteClient } from '../clients/netsuite-client';
import { syncBills } from './bill-sync';
import { syncPayments, retryPendingPayments } from './payment-sync';
import { createSyncRun, completeSyncRun } from '../database/db';

/**
 * Scheduled sync job that periodically synchronizes data
 * from CorpayOne to NetSuite.
 *
 * Runs at the configured interval (default: every 15 minutes).
 * Fetches invoices and payments updated since the last lookback period.
 */
export function startScheduler(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): cron.ScheduledTask {
  const intervalMinutes = config.sync.intervalMinutes;

  // Build a cron expression for the interval (e.g., "*/15 * * * *" for every 15 minutes)
  const cronExpression = `*/${intervalMinutes} * * * *`;

  logger.info(
    { intervalMinutes, cronExpression },
    'Starting sync scheduler',
  );

  const task = cron.schedule(cronExpression, async () => {
    await runScheduledSync(corpayClient, netsuiteClient);
  });

  return task;
}

/** Run a full incremental sync cycle */
export async function runScheduledSync(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<void> {
  const syncRunId = createSyncRun('incremental');

  try {
    logger.info('Starting scheduled incremental sync');

    // Calculate the lookback time
    const lookbackMs = config.sync.lookbackHours * 60 * 60 * 1000;
    const updatedSince = new Date(Date.now() - lookbackMs).toISOString();

    // Phase 1: Sync bills
    const billResult = await syncBills(corpayClient, netsuiteClient, {
      updatedSince,
    });

    // Phase 2: Sync payments
    const paymentResult = await syncPayments(corpayClient, netsuiteClient, {
      updatedSince,
    });

    // Phase 3: Retry pending payments (bills may have been synced in Phase 1)
    const retryResult = await retryPendingPayments(corpayClient, netsuiteClient);

    // Combine payment results
    const totalPayments = {
      processed: paymentResult.processed + retryResult.processed,
      synced: paymentResult.synced + retryResult.synced,
      failed: paymentResult.failed + retryResult.failed,
    };

    completeSyncRun(syncRunId, {
      bills_processed: billResult.processed,
      bills_synced: billResult.synced,
      bills_failed: billResult.failed,
      payments_processed: totalPayments.processed,
      payments_synced: totalPayments.synced,
      payments_failed: totalPayments.failed,
    });

    logger.info(
      {
        bills: {
          processed: billResult.processed,
          synced: billResult.synced,
          failed: billResult.failed,
        },
        payments: totalPayments,
      },
      'Scheduled sync completed',
    );
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSyncRun(
      syncRunId,
      {
        bills_processed: 0,
        bills_synced: 0,
        bills_failed: 0,
        payments_processed: 0,
        payments_synced: 0,
        payments_failed: 0,
      },
      errorMessage,
    );
    logger.error({ error: errorMessage }, 'Scheduled sync failed');
  }
}

/** Run a full sync (no lookback time filter) */
export async function runFullSync(
  corpayClient: CorpayOneClient,
  netsuiteClient: NetSuiteClient,
): Promise<void> {
  const syncRunId = createSyncRun('full');

  try {
    logger.info('Starting full sync');

    const billResult = await syncBills(corpayClient, netsuiteClient);
    const paymentResult = await syncPayments(corpayClient, netsuiteClient);
    const retryResult = await retryPendingPayments(corpayClient, netsuiteClient);

    const totalPayments = {
      processed: paymentResult.processed + retryResult.processed,
      synced: paymentResult.synced + retryResult.synced,
      failed: paymentResult.failed + retryResult.failed,
    };

    completeSyncRun(syncRunId, {
      bills_processed: billResult.processed,
      bills_synced: billResult.synced,
      bills_failed: billResult.failed,
      payments_processed: totalPayments.processed,
      payments_synced: totalPayments.synced,
      payments_failed: totalPayments.failed,
    });

    logger.info('Full sync completed');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    completeSyncRun(
      syncRunId,
      {
        bills_processed: 0,
        bills_synced: 0,
        bills_failed: 0,
        payments_processed: 0,
        payments_synced: 0,
        payments_failed: 0,
      },
      errorMessage,
    );
    logger.error({ error: errorMessage }, 'Full sync failed');
  }
}
