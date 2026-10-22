import { describe, expect, it, vi } from 'vitest';
import { defaultRules, type RuleRegistry } from '../../src/rules';
import { loadConfig } from '../../src/config';
import { ALL_DOCS, ASSESSOR, CLERK, FINANCE, LEAD, SYSTEM, readJson, rejection, setup } from './helpers';

const APPEAL_DAYS = 30;

describe('WorkflowEngine.runSystemTasks', () => {
  it('closes qualifying REJECTED claims and skips the rest without audit', async () => {
    const { engine, store, clock, seed, lines } = setup();
    const recently = { stateEnteredAt: '2026-03-20T00:00:00.000Z' };
    const expired = await seed('REJECTED');
    const acknowledged = await seed('REJECTED', recently);
    const waiting = await seed('REJECTED', recently);
    const elsewhere = await seed('APPROVED');
    await engine.acknowledge(acknowledged.id, CLERK);
    clock.advance({ days: APPEAL_DAYS });

    const result = await engine.runSystemTasks(SYSTEM);

    expect(result.processed).toEqual([
      { claimId: expired.id, transitionId: 'close_rejected', from: 'REJECTED', to: 'CLOSED', version: 2 },
      { claimId: acknowledged.id, transitionId: 'close_rejected', from: 'REJECTED', to: 'CLOSED', version: 3 },
    ]);
    expect(result.skipped).toEqual([
      {
        claimId: waiting.id,
        transitionId: 'close_rejected',
        reason: 'preconditions_not_met',
        message: 'Only 11 of 30 days elapsed since stateEnteredAt; memberAcknowledged must be true',
        failures: [
          expect.objectContaining({ rule: 'daysElapsed', path: 'any[0]' }),
          expect.objectContaining({ rule: 'eq', path: 'any[1]' }),
        ],
      },
    ]);

    const audit = await store.listAuditByClaim(expired.id);
    expect(audit.slice(1).map((e) => [e.type, e.transitionId, e.reason])).toEqual([
      ['TRANSITION', 'close_rejected', 'Rejected claim closed and archived'],
      ['SIDE_EFFECT', 'close_rejected', 'Side effect setField succeeded'],
      ['SIDE_EFFECT', 'close_rejected', 'Side effect notify succeeded'],
    ]);
    expect(audit[1]).toMatchObject({
      triggeredBy: { userId: SYSTEM, role: 'system' },
      timestamp: '2026-03-31T00:00:00.000Z',
      data: {},
    });
    expect(await store.getClaim(expired.id)).toMatchObject({
      status: 'CLOSED',
      data: { archivedAt: '2026-03-31T00:00:00.000Z' },
    });

    expect(await store.listAuditByClaim(waiting.id)).toHaveLength(1);
    expect((await store.getClaim(waiting.id))?.status).toBe('REJECTED');
    expect((await store.getClaim(elsewhere.id))?.version).toBe(1);
    expect(lines.filter((l) => l.startsWith('[NOTIFY'))).toHaveLength(2);
  });

  it('a second run finds nothing left to do', async () => {
    const { engine, clock, seed } = setup();
    await seed('REJECTED');
    clock.advance({ days: APPEAL_DAYS });

    expect((await engine.runSystemTasks(SYSTEM)).processed).toHaveLength(1);
    expect(await engine.runSystemTasks(SYSTEM)).toEqual({ processed: [], skipped: [] });
  });

  it('UNKNOWN_USER and UNAUTHORIZED_ROLE are thrown before touching any claim', async () => {
    const { engine, store, clock, seed } = setup();
    const claim = await seed('REJECTED');
    clock.advance({ days: APPEAL_DAYS });

    await rejection(engine.runSystemTasks('u-x'), 'UNKNOWN_USER');
    const error = await rejection(engine.runSystemTasks(FINANCE), 'UNAUTHORIZED_ROLE');
    expect(error.message).toBe('Action runSystemTasks requires role system; user u-finance-1 has role finance');
    expect((await store.getClaim(claim.id))?.status).toBe('REJECTED');
    expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
  });

  it("runs only system transitions, whatever the caller's role", async () => {
    const workflow = readJson('claims-workflow.json');
    workflow.actions.runSystemTasks.roles = ['system', 'team_lead'];
    const { engine, store, clock, seed } = setup({ config: loadConfig({ workflow, users: readJson('users.json') }) });
    const rejected = await seed('REJECTED');
    const submitted = await seed('SUBMITTED');
    // start_assessment is a team_lead transition whose preconditions already pass.
    const verified = await seed('DOCUMENTS_VERIFIED', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });
    clock.advance({ days: APPEAL_DAYS });

    const result = await engine.runSystemTasks(LEAD);

    expect(result).toEqual({
      processed: [{ claimId: rejected.id, transitionId: 'close_rejected', from: 'REJECTED', to: 'CLOSED', version: 2 }],
      skipped: [],
    });
    expect((await store.listAuditByClaim(rejected.id))[1].triggeredBy).toEqual({ userId: LEAD, role: 'team_lead' });
    expect((await store.getClaim(submitted.id))?.version).toBe(1);
    expect((await store.getClaim(verified.id))?.version).toBe(1);
  });

  it('skips a locked claim as busy without waiting, and leaves it for the next run', async () => {
    const { engine, store, clock, seed } = setup({ lockTimeoutMs: 10_000 });
    const locked = await seed('REJECTED');
    const free = await seed('REJECTED');
    clock.advance({ days: APPEAL_DAYS });

    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = store.withClaim(locked.id, () => held);

    const result = await engine.runSystemTasks(SYSTEM);
    expect(result.processed.map((p) => p.claimId)).toEqual([free.id]);
    expect(result.skipped).toEqual([
      {
        claimId: locked.id,
        transitionId: 'close_rejected',
        reason: 'busy',
        message: `Claim ${locked.id} is locked by another request`,
      },
    ]);

    release();
    await holder;
    expect((await engine.runSystemTasks(SYSTEM)).processed.map((p) => p.claimId)).toEqual([locked.id]);
  });

  it('re-checks the status under the lock', async () => {
    const { engine, store, clock, seed } = setup();
    const claim = await seed('REJECTED');
    clock.advance({ days: APPEAL_DAYS });
    const scanned = await store.listClaims();
    await engine.transition(claim.id, SYSTEM, { to: 'CLOSED' });
    vi.spyOn(store, 'listClaims').mockResolvedValueOnce(scanned);

    const result = await engine.runSystemTasks(SYSTEM);
    expect(result).toEqual({
      processed: [],
      skipped: [
        {
          claimId: claim.id,
          transitionId: 'close_rejected',
          reason: 'state_changed',
          message: 'Claim is in CLOSED, no longer in REJECTED',
        },
      ],
    });
    expect((await store.listAuditByClaim(claim.id)).filter((e) => e.type === 'TRANSITION')).toHaveLength(1);
  });

  it('an error on one claim rolls back only that claim', async () => {
    let broken = '';
    const daysElapsed = defaultRules.get('daysElapsed')!;
    const rules: RuleRegistry = new Map([
      ...defaultRules,
      [
        'daysElapsed',
        {
          ...daysElapsed,
          evaluate: (params, ctx) => {
            if (ctx.get('id') === broken) throw new Error('rule exploded');
            return daysElapsed.evaluate(params, ctx);
          },
        },
      ],
    ]);
    const { engine, store, clock, seed } = setup({ rules });
    const bad = await seed('REJECTED');
    const good = await seed('REJECTED');
    broken = bad.id;
    clock.advance({ days: APPEAL_DAYS });

    const result = await engine.runSystemTasks(SYSTEM);
    expect(result.processed.map((p) => p.claimId)).toEqual([good.id]);
    expect(result.skipped).toEqual([
      { claimId: bad.id, transitionId: 'close_rejected', reason: 'error', message: 'rule exploded' },
    ]);
    expect((await store.getClaim(bad.id))?.status).toBe('REJECTED');
    expect(await store.listAuditByClaim(bad.id)).toHaveLength(1);
  });

  it('two runs at once close each claim exactly once (in-memory case 29)', async () => {
    const { engine, store, clock, seed } = setup();
    const claims = await Promise.all(Array.from({ length: 10 }, () => seed('REJECTED')));
    clock.advance({ days: APPEAL_DAYS });

    const [a, b] = await Promise.all([engine.runSystemTasks(SYSTEM), engine.runSystemTasks(SYSTEM)]);

    expect(a.processed.length + b.processed.length).toBe(10);
    for (const skip of [...a.skipped, ...b.skipped]) expect(['busy', 'state_changed']).toContain(skip.reason);
    for (const claim of claims) {
      const audit = await store.listAuditByClaim(claim.id);
      expect(audit.filter((e) => e.type === 'TRANSITION' && e.transitionId === 'close_rejected')).toHaveLength(1);
      expect(audit.filter((e) => e.type === 'SIDE_EFFECT')).toHaveLength(2);
      expect(audit.map((e) => e.seq)).toEqual(audit.map((_, i) => i + 1));
    }
  });
});
