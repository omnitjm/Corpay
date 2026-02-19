import { config } from './config';
import { logger } from './logger';
import { CorpayOneClient } from './clients/corpayone-client';
import { NetSuiteClient } from './clients/netsuite-client';
import { startScheduler, runFullSync, runScheduledSync } from './services/scheduler';
import { getDatabase, closeDatabase } from './database/db';

/**
 * CorpayOne → NetSuite Integration
 *
 * Synchronizes vendor bills and payments from CorpayOne to NetSuite.
 * One-way, pull-based: only outgoing HTTPS calls, no incoming traffic.
 *
 * Modes:
 *   - "server" (default): Runs scheduled sync on a timer
 *   - "sync":    Runs a single incremental sync and exits
 *   - "full":    Runs a full sync (all data) and exits
 */
async function main(): Promise<void> {
  const mode = process.argv[2] || 'server';

  logger.info({ mode }, 'CorpayOne-NetSuite integration starting');

  // Initialize database
  getDatabase();

  // Initialize API clients
  const corpayClient = new CorpayOneClient();
  const netsuiteClient = new NetSuiteClient();

  switch (mode) {
    case 'server': {
      // Start scheduled sync for periodic reconciliation
      const scheduler = startScheduler(corpayClient, netsuiteClient);

      logger.info(
        { syncIntervalMinutes: config.sync.intervalMinutes },
        'Integration running: scheduled sync every N minutes',
      );

      // Run an initial sync on startup
      logger.info('Running initial sync on startup...');
      await runScheduledSync(corpayClient, netsuiteClient);

      // Handle graceful shutdown
      const shutdown = (): void => {
        logger.info('Shutting down...');
        scheduler.stop();
        closeDatabase();
        process.exit(0);
      };

      process.on('SIGTERM', shutdown);
      process.on('SIGINT', shutdown);
      break;
    }

    case 'sync': {
      // Run a single incremental sync
      await runScheduledSync(corpayClient, netsuiteClient);
      closeDatabase();
      logger.info('Incremental sync completed');
      break;
    }

    case 'full': {
      // Run a full sync (all data, no time filter)
      await runFullSync(corpayClient, netsuiteClient);
      closeDatabase();
      logger.info('Full sync completed');
      break;
    }

    default:
      logger.error({ mode }, 'Unknown mode. Use: server, sync, or full');
      process.exit(1);
  }
}

main().catch((error) => {
  logger.fatal({ error: error instanceof Error ? error.message : String(error) }, 'Fatal error');
  closeDatabase();
  process.exit(1);
});
