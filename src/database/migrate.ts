import { getDatabase, closeDatabase } from './db';
import { logger } from '../logger';

function migrate(): void {
  logger.info('Running database migration...');
  getDatabase(); // This initializes the database and runs the schema
  logger.info('Database migration completed successfully');
  closeDatabase();
}

migrate();
