import { HttpRequest, HttpResponseInit, InvocationContext, app } from '@azure/functions';
import { CorpayOneClient } from '../../src/clients/corpayone-client';
import { NetSuiteClient } from '../../src/clients/netsuite-client';
import { runScheduledSync, runFullSync } from '../../src/services/scheduler';
import { getDatabase, closeDatabase } from '../../src/database/db';

/**
 * Azure Function: Manual Sync Trigger (HTTP Trigger)
 *
 * Allows triggering a sync manually via HTTP call.
 * Useful for testing or when you need an immediate sync.
 *
 * URL: POST https://<your-function-app>.azurewebsites.net/api/sync
 * Query params:
 *   ?mode=full   → Full sync (all data)
 *   ?mode=sync   → Incremental sync (default)
 *
 * Protected by function-level auth key.
 */
async function manualSync(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  const mode = request.query.get('mode') || 'sync';
  context.log(`Manual sync triggered (mode: ${mode})`);

  try {
    getDatabase();

    const corpayClient = new CorpayOneClient();
    const netsuiteClient = new NetSuiteClient();

    if (mode === 'full') {
      await runFullSync(corpayClient, netsuiteClient);
    } else {
      await runScheduledSync(corpayClient, netsuiteClient);
    }

    context.log('Manual sync completed');
    return {
      status: 200,
      jsonBody: { success: true, mode, completedAt: new Date().toISOString() },
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    context.error(`Manual sync failed: ${msg}`);
    return { status: 500, jsonBody: { error: msg } };
  } finally {
    closeDatabase();
  }
}

app.http('manualSync', {
  methods: ['POST'],
  authLevel: 'function',
  route: 'sync',
  handler: manualSync,
});
