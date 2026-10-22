import { afterAll } from 'vitest';
import { runStoreContract } from '../../engine/test/store/contract';
import { PostgresWorkflowStore } from '../src/store';
import { createTestPool, resetDatabase } from './db';

const pool = createTestPool();
afterAll(() => pool.end());

runStoreContract('postgres', async ({ lockTimeoutMs }) => {
  await resetDatabase(pool);
  return { store: new PostgresWorkflowStore(pool, { lockTimeoutMs }) };
});
