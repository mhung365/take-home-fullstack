/**
 * DESIGN 10, cases 26–31: the engine on the real config with PostgresWorkflowStore. Each case runs
 * ROUNDS times; within a round the requests are fired together with Promise.all, so each one runs
 * on its own pool connection and the row lock (not the event loop) decides the order.
 *
 * Case 32 (UPDATE/DELETE/TRUNCATE on audit_entries rejected by the triggers) is in audit-append-only.test.ts.
 */
import { isWorkflowError, type AuditEntry, type AuditType } from '@claims/engine';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ALL_DOCS, ASSESSOR, CLERK, LEAD, SYSTEM, setup } from '../../engine/test/engine/helpers';
import { PostgresWorkflowStore } from '../src/store';
import { createTestPool, resetDatabase } from './db';

const ROUNDS = 20;
const ASSESSOR_2 = 'u-assessor-2';
const LOCK_TIMEOUT_MS = 2000;

const pool = createTestPool();
afterAll(() => pool.end());

type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown };

/** Starts every request before awaiting any of them. */
function fireTogether<T>(requests: Array<() => Promise<T>>): Promise<Settled<T>[]> {
  return Promise.all(
    requests.map((request) =>
      request().then(
        (value): Settled<T> => ({ ok: true, value }),
        (error: unknown): Settled<T> => ({ ok: false, error }),
      ),
    ),
  );
}

/** 'ok', the WorkflowError code, or the message of an unexpected error (so it shows up in the diff). */
const outcome = (result: Settled<unknown>): string => {
  if (result.ok) return 'ok';
  if (isWorkflowError(result.error)) return result.error.code;
  return `unexpected: ${String(result.error)}`;
};

const countOf = (audit: AuditEntry[], type: AuditType, transitionId?: string) =>
  audit.filter((e) => e.type === type && (transitionId === undefined || e.transitionId === transitionId)).length;

function expectContiguousSeq(audit: AuditEntry[], label: string): void {
  expect(
    audit.map((e) => e.seq),
    `${label}: seq`,
  ).toEqual(audit.map((_, i) => i + 1));
  expect(new Set(audit.map((e) => e.id)).size, `${label}: distinct ids`).toBe(audit.length);
}

describe('concurrency on PostgreSQL (DESIGN 10, cases 26–31)', { timeout: 60_000 }, () => {
  let ctx: ReturnType<typeof setup>;

  beforeEach(async () => {
    await resetDatabase(pool);
    ctx = setup({ store: new PostgresWorkflowStore(pool, { lockTimeoutMs: LOCK_TIMEOUT_MS }) });
  });

  /** PENDING_INFO → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT, one sequential request at a time. */
  async function backToAssessment(claimId: string): Promise<void> {
    await ctx.engine.transition(claimId, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: 'sent' } });
    await ctx.engine.transition(claimId, LEAD, { to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
  }

  it('26: approve and reject at once — exactly one wins, the other is INVALID_TRANSITION', async () => {
    const winners = { approve: 0, reject: 0 };
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const { id } = await ctx.seed('UNDER_ASSESSMENT');

      const [approve, reject] = await fireTogether([
        () => ctx.engine.transition(id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'covered' } }),
        () =>
          ctx.engine.transition(id, ASSESSOR_2, {
            to: 'REJECTED',
            payload: { assessmentReport: 'not covered', rejectionReason: 'Policy exclusion' },
          }),
      ]);

      expect([outcome(approve), outcome(reject)].sort(), label).toEqual(['INVALID_TRANSITION', 'ok']);
      const won = approve.ok ? 'approve' : 'reject';
      winners[won]++;
      const [winnerState, loserState] = won === 'approve' ? ['APPROVED', 'REJECTED'] : ['REJECTED', 'APPROVED'];

      const audit = await ctx.store.listAuditByClaim(id);
      expectContiguousSeq(audit, label);
      expect(countOf(audit, 'TRANSITION'), label).toBe(1);
      expect(countOf(audit, 'TRANSITION_REJECTED'), label).toBe(1);
      expect(audit.find((e) => e.type === 'TRANSITION'), label).toMatchObject({ transitionId: won, toState: winnerState });
      // The loser waited for the lock, then saw the winner's state.
      expect(audit.find((e) => e.type === 'TRANSITION_REJECTED'), label).toMatchObject({
        fromState: winnerState,
        toState: loserState,
      });

      const sideEffects = audit.filter((e) => e.type === 'SIDE_EFFECT');
      expect(
        sideEffects.map((e) => [e.transitionId, e.data?.name, e.data?.status]),
        label,
      ).toEqual(
        won === 'approve'
          ? [
              ['approve', 'notify', 'ok'],
              ['approve', 'createPaymentRequest', 'ok'],
            ]
          : [['reject', 'notify', 'ok']],
      );

      const claim = await ctx.store.getClaim(id);
      expect(claim?.status, label).toBe(winnerState);
      expect(claim?.version, label).toBe(2);
      expect('paymentRequest' in (claim?.data ?? {}), label).toBe(won === 'approve');
    }
    expect(winners.approve + winners.reject).toBe(ROUNDS);
  });

  it('27: 5 request_info at once after 2 rounds — 1 succeeds, the 4th round is CYCLE_LIMIT_EXCEEDED', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const { id } = await ctx.seed('UNDER_ASSESSMENT');
      for (let i = 1; i <= 2; i++) {
        await ctx.engine.transition(id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: `info ${i}` } });
        await backToAssessment(id);
      }

      const results = await fireTogether(
        Array.from({ length: 5 }, (_, i) => () =>
          ctx.engine.transition(id, i % 2 ? ASSESSOR : ASSESSOR_2, {
            to: 'PENDING_INFO',
            payload: { missingInfoDescription: `concurrent ${i}` },
          }),
        ),
      );

      // The losers see PENDING_INFO under the lock, so they fail before the cycle check.
      expect(results.map(outcome).sort(), label).toEqual(['INVALID_TRANSITION', 'INVALID_TRANSITION', 'INVALID_TRANSITION', 'INVALID_TRANSITION', 'ok']);
      expect(countOf(await ctx.store.listAuditByClaim(id), 'TRANSITION', 'request_info'), label).toBe(3);

      await backToAssessment(id);
      const [fourth] = await fireTogether([
        () => ctx.engine.transition(id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: 'fourth' } }),
      ]);
      expect(outcome(fourth), label).toBe('CYCLE_LIMIT_EXCEEDED');
      expect((fourth as { error: Error }).error.message, label).toBe(
        'Maximum information requests exceeded — escalate to team lead',
      );

      const audit = await ctx.store.listAuditByClaim(id);
      expectContiguousSeq(audit, label);
      expect(countOf(audit, 'TRANSITION', 'request_info'), label).toBe(3);
      expect((await ctx.store.getClaim(id))?.status, label).toBe('UNDER_ASSESSMENT');
    }
  });

  it('28: two acknowledge at once — 1 MEMBER_ACKNOWLEDGED and 1 ACTION_REJECTED', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const { id } = await ctx.seed('REJECTED');

      const results = await fireTogether([
        () => ctx.engine.acknowledge(id, CLERK, 'member called'),
        () => ctx.engine.acknowledge(id, CLERK, 'member emailed'),
      ]);

      expect(results.map(outcome).sort(), label).toEqual(['ACTION_NOT_ALLOWED_IN_STATE', 'ok']);
      const audit = await ctx.store.listAuditByClaim(id);
      expectContiguousSeq(audit, label);
      expect(audit.map((e) => e.type), label).toEqual(['CLAIM_CREATED', 'MEMBER_ACKNOWLEDGED', 'ACTION_REJECTED']);
      expect(audit[2].reason, label).toMatch(/^Member acknowledgement already recorded at .+ by u-clerk-1$/);

      const claim = await ctx.store.getClaim(id);
      expect(claim?.version, label).toBe(2);
      expect(claim?.data, label).toMatchObject({ memberAcknowledged: true, memberAcknowledgedBy: CLERK });
    }
  });

  it('29: two runSystemTasks at once on 10 claims — each closed exactly once with one set of side effects', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const claims = await Promise.all(
        Array.from({ length: 10 }, () =>
          ctx.seed('REJECTED', { data: { documents: [...ALL_DOCS], memberAcknowledged: true } }),
        ),
      );
      const ids = claims.map((c) => c.id).sort();
      const notifiesBefore = ctx.lines.filter((l) => l.startsWith('[NOTIFY')).length;

      const [first, second] = await fireTogether([
        () => ctx.engine.runSystemTasks(SYSTEM),
        () => ctx.engine.runSystemTasks(SYSTEM),
      ]);
      if (!first.ok || !second.ok) throw new Error(`${label}: runSystemTasks failed: ${outcome(first.ok ? second : first)}`);

      const processed = [...first.value.processed, ...second.value.processed];
      expect(processed.map((p) => p.claimId).sort(), label).toEqual(ids);
      // The run that lost a claim either found it locked or found it already CLOSED.
      for (const skipped of [...first.value.skipped, ...second.value.skipped]) {
        expect(['busy', 'state_changed'], `${label}: ${skipped.claimId} ${skipped.message}`).toContain(skipped.reason);
      }

      for (const id of ids) {
        const audit = await ctx.store.listAuditByClaim(id);
        expectContiguousSeq(audit, `${label} ${id}`);
        expect(
          audit.map((e) => [e.type, e.transitionId, e.data?.name]),
          `${label} ${id}`,
        ).toEqual([
          ['CLAIM_CREATED', undefined, undefined],
          ['TRANSITION', 'close_rejected', undefined],
          ['SIDE_EFFECT', 'close_rejected', 'setField'],
          ['SIDE_EFFECT', 'close_rejected', 'notify'],
        ]);
        expect(await ctx.store.getClaim(id), `${label} ${id}`).toMatchObject({ status: 'CLOSED', version: 2 });
      }
      expect(ctx.lines.filter((l) => l.startsWith('[NOTIFY')).length - notifiesBefore, label).toBe(10);
    }
  });

  it('30: seq stays contiguous from 1 under a burst of mixed successful and rejected requests', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const { id } = await ctx.seed('UNDER_ASSESSMENT');
      const { engine } = ctx;

      const transitions = [
        () => engine.transition(id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } }),
        () => engine.transition(id, ASSESSOR_2, { to: 'REJECTED', payload: { assessmentReport: 'no', rejectionReason: 'excluded' } }),
        () => engine.transition(id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: 'bank details' } }),
        () => engine.transition(id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: 'sent' } }),
        () => engine.transition(id, ASSESSOR, { to: 'REJECTED', payload: { assessmentReport: 'no' } }),
        () => engine.transition(id, CLERK, { to: 'APPROVED', payload: { assessmentReport: 'ok' } }),
        () => engine.transition(id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: 'x', amount: 1 } }),
        () => engine.transition(id, ASSESSOR, { to: 'NOT_A_STATE' }),
        () => engine.transition(id, ASSESSOR_2, { to: 'APPROVED', payload: { assessmentReport: 'ok' }, expectedVersion: 1 }),
      ];
      const acknowledgements = [() => engine.acknowledge(id, CLERK), () => engine.acknowledge(id, CLERK)];

      const results = await fireTogether<unknown>([...transitions, ...acknowledgements]);
      const transitionResults = results.slice(0, transitions.length);
      const ackResults = results.slice(transitions.length);

      for (const result of results) {
        expect(result.ok || isWorkflowError(result.error), `${label}: ${outcome(result)}`).toBe(true);
      }
      const succeeded = results.filter((r) => r.ok).length;
      expect(succeeded, label).toBeGreaterThanOrEqual(1);

      const audit = await ctx.store.listAuditByClaim(id);
      expectContiguousSeq(audit, label);
      // Every request is audited exactly once: a success as TRANSITION / MEMBER_ACKNOWLEDGED, a rejection as *_REJECTED.
      expect(countOf(audit, 'TRANSITION'), label).toBe(transitionResults.filter((r) => r.ok).length);
      expect(countOf(audit, 'TRANSITION_REJECTED'), label).toBe(transitionResults.filter((r) => !r.ok).length);
      expect(countOf(audit, 'MEMBER_ACKNOWLEDGED'), label).toBe(ackResults.filter((r) => r.ok).length);
      expect(countOf(audit, 'ACTION_REJECTED'), label).toBe(ackResults.filter((r) => !r.ok).length);
      expect((await ctx.store.getClaim(id))?.version, label).toBe(1 + succeeded);
    }
  });

  it('31a: a stale expectedVersion is STALE_CLAIM, leaves the claim as the winner wrote it, and is audited', async () => {
    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const { id } = await ctx.seed('UNDER_ASSESSMENT');

      // Both were prepared against version 1; whichever locks second is stale.
      const results = await fireTogether([
        () => ctx.engine.transition(id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' }, expectedVersion: 1 }),
        () =>
          ctx.engine.transition(id, ASSESSOR_2, {
            to: 'PENDING_INFO',
            payload: { missingInfoDescription: 'bank details' },
            expectedVersion: 1,
          }),
      ]);

      expect(results.map(outcome).sort(), label).toEqual(['STALE_CLAIM', 'ok']);
      const winner = results.find((r) => r.ok) as { value: { claim: unknown } };
      const loser = results.find((r) => !r.ok) as { error: Error };
      expect(loser.error.message, label).toBe(`Claim ${id} was modified (version 2, expected 1); reload and retry`);
      expect(await ctx.store.getClaim(id), label).toEqual(winner.value.claim);

      const audit = await ctx.store.listAuditByClaim(id);
      expectContiguousSeq(audit, label);
      expect(audit.at(-1), label).toMatchObject({ type: 'TRANSITION_REJECTED', data: { code: 'STALE_CLAIM' } });
    }
  });

  it('31b: another connection holding the claim lock past lock_timeout makes requests CLAIM_BUSY, without audit', async () => {
    const shortTimeoutMs = 200;
    const { engine, seed, store } = setup({ store: new PostgresWorkflowStore(pool, { lockTimeoutMs: shortTimeoutMs }) });

    for (let round = 1; round <= ROUNDS; round++) {
      const label = `round ${round}`;
      const claim = await seed('UNDER_ASSESSMENT');

      const holder = await pool.connect();
      try {
        await holder.query('BEGIN');
        await holder.query('SELECT 1 FROM claims WHERE id = $1 FOR UPDATE', [claim.id]);

        const startedAt = Date.now();
        const results = await fireTogether<unknown>([
          () => engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } }),
          () => engine.transition(claim.id, ASSESSOR_2, { to: 'PENDING_INFO', payload: { missingInfoDescription: 'x' } }),
        ]);
        const elapsed = Date.now() - startedAt;

        expect(results.map(outcome), label).toEqual(['CLAIM_BUSY', 'CLAIM_BUSY']);
        // It waited for lock_timeout rather than failing fast, and didn't hang either.
        expect(elapsed, label).toBeGreaterThanOrEqual(shortTimeoutMs - 20);
        expect(elapsed, label).toBeLessThan(LOCK_TIMEOUT_MS);
      } finally {
        await holder.query('ROLLBACK');
        holder.release();
      }

      expect(await store.getClaim(claim.id), label).toEqual(claim);
      expect(await store.listAuditByClaim(claim.id), label).toHaveLength(1);

      // Once the other connection lets go, the same request goes through.
      const after = await engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } });
      expect(after.claim.version, label).toBe(2);
    }
  });
});
