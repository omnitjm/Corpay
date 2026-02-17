import pino from 'pino';
import { config } from './config';

export const logger = pino({
  level: config.logLevel,
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino/file', options: { destination: 1 } }
      : undefined,
});
