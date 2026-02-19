import { InvocationContext, Timer, app } from '@azure/functions';
import { CorpayOneClient } from '../../src/clients/corpayone-client';
import { NetSuiteClient } from '../../src/clients/netsuite-client';
import { runScheduledSync } from '../../src/services/scheduler';
import { getDatabase, closeDatabase } from '../../src/database/db';

/**
 * Azure Function: Scheduled Sync (Timer Trigger)
 *
 * Runs every 15 minutes to sync invoices and payments
 * from CorpayOne to NetSuite.
 *
 * Cron: "0 */15 * * * *" = every 15 minutes
 */
async function scheduledSync(myTimer: Timer, context: InvocationContext): Promise<void> {
  context.log('CorpayOne → NetSuite scheduled sync starting');

  try {
    // Ensure env vars are loaded (Azure sets them automatically)
    getDatabase();

    const corpayClient = new CorpayOneClient();
    const netsuiteClient = new NetSuiteClient();

    await runScheduledSync(corpayClient, netsuiteClient);

    context.log('Scheduled sync completed successfully');
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    context.error(`Scheduled sync failed: ${msg}`);
    throw error; // Azure will mark the invocation as failed
  } finally {
    closeDatabase();
  }
}

app.timer('scheduledSync', {
  schedule: '0 */15 * * * *',
  runOnStartup: false,
  handler: scheduledSync,
});
