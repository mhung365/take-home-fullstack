import { Pool } from 'pg';
import { migrate } from '../src/migrate';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://claims:claims@localhost:5432/claims_test';

/** resetDatabase drops everything, so refuse anything that isn't a *_test database. */
export function createTestPool(): Pool {
  const database = new URL(url).pathname.slice(1);
  if (!database.endsWith('_test')) {
    throw new Error(`TEST_DATABASE_URL must point to a *_test database, got "${database}"`);
  }
  return new Pool({ connectionString: url, max: 20 });
}

/** audit_entries rejects TRUNCATE/DELETE, so a clean slate means recreating the schema. */
export async function resetDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(client);
  } finally {
    client.release();
  }
}
