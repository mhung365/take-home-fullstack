import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresWorkflowStore } from '../src/store';
import { createTestPool, resetDatabase } from './db';

const pool = createTestPool();
afterAll(() => pool.end());

describe('audit_entries is append-only at the database level (DESIGN 10, case 32)', () => {
  let claimId: string;

  beforeEach(async () => {
    await resetDatabase(pool);
    const store = new PostgresWorkflowStore(pool);
    const claim = await store.createClaim(
      {
        memberId: 'm-1',
        status: 'SUBMITTED',
        stateEnteredAt: '2026-03-01T00:00:00.000Z',
        amount: 100,
        policyLimit: 1000,
        createdAt: '2026-03-01T00:00:00.000Z',
        createdBy: 'u-clerk-1',
        data: {},
      },
      {
        type: 'CLAIM_CREATED',
        timestamp: '2026-03-01T00:00:00.000Z',
        fromState: null,
        toState: 'SUBMITTED',
        triggeredBy: { userId: 'u-clerk-1', role: 'document_clerk' },
        reason: 'Claim created',
      },
    );
    claimId = claim.id;
  });

  it.each([
    ['UPDATE', `UPDATE audit_entries SET reason = 'tampered'`],
    ['DELETE', 'DELETE FROM audit_entries'],
    ['TRUNCATE', 'TRUNCATE audit_entries'],
    ['TRUNCATE', 'TRUNCATE claims CASCADE'],
  ])('rejects hand-written %s (%s)', async (op, sql) => {
    await expect(pool.query(sql)).rejects.toThrow(`audit_entries is append-only: ${op} is not allowed`);

    const { rows } = await pool.query('SELECT claim_id, seq, reason FROM audit_entries');
    expect(rows).toEqual([{ claim_id: claimId, seq: 1, reason: 'Claim created' }]);
  });

  it('rejects deleting a claim that has audit entries', async () => {
    await expect(pool.query('DELETE FROM claims WHERE id = $1', [claimId])).rejects.toThrow(/foreign key/);
  });
});
