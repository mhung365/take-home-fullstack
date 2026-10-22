import { Inject, Injectable, Logger, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import type { PostgresEnv } from '@claims/store-postgres';
import { Pool } from 'pg';
import { PG_POOL } from './tokens';

/** Bounds how long a request waits for a pool connection when the DB is unreachable or the pool is exhausted. */
const CONNECTION_TIMEOUT_MS = 5000;

export function pgPoolProvider(env: PostgresEnv): Provider {
  return {
    provide: PG_POOL,
    useFactory: (): Pool => {
      const pool = new Pool({
        connectionString: env.databaseUrl,
        max: env.poolMax,
        connectionTimeoutMillis: CONNECTION_TIMEOUT_MS,
      });
      // Without a listener, an idle client dropped by the server crashes the process.
      const logger = new Logger('PgPool');
      pool.on('error', (error) => logger.error(`Idle client error: ${error.message}`));
      return pool;
    },
  };
}

@Injectable()
export class PgPoolLifecycle implements OnApplicationShutdown {
  private readonly logger = new Logger('PgPool');

  constructor(@Inject(PG_POOL) private readonly pool: Pool) {}

  async onApplicationShutdown(): Promise<void> {
    await this.pool.end();
    this.logger.log('Pool closed');
  }
}
