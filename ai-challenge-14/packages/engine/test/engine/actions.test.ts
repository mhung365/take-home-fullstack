import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FakeClock } from '../../src/clock';
import { loadConfig } from '../../src/config';
import { WorkflowEngine } from '../../src/engine';
import { WorkflowError, isWorkflowError, type ErrorCode } from '../../src/errors';
import type { Claim, NewClaim } from '../../src/model';
import { createBuiltinSideEffects } from '../../src/side-effects';
import { InMemoryWorkflowStore } from '../../src/store';

const configDir = resolve(__dirname, '../../../../config');
const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));
const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });

const T0 = '2026-03-01T00:00:00.000Z';
const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];

const CLERK = 'u-clerk-1';
const ASSESSOR = 'u-assessor-1';
const FINANCE = 'u-finance-1';
const SYSTEM = 'u-system';

function setup() {
  const store = new InMemoryWorkflowStore({ lockTimeoutMs: 500 });
  const clock = new FakeClock(T0);
  const engine = new WorkflowEngine({
    config,
    store,
    clock,
    sideEffects: createBuiltinSideEffects({ log: () => {}, paymentRequestId: () => 'pr-1' }),
  });

  const seed = (status = 'REJECTED', overrides: Partial<NewClaim> = {}): Promise<Claim> =>
    store.createClaim(
      {
        memberId: 'm-1',
        status,
        stateEnteredAt: T0,
        amount: 1500,
        policyLimit: 10000,
        createdAt: T0,
        createdBy: CLERK,
        data: { documents: [...ALL_DOCS] },
        ...overrides,
      },
      {
        type: 'CLAIM_CREATED',
        timestamp: T0,
        fromState: null,
        toState: status,
        triggeredBy: { userId: CLERK, role: 'document_clerk' },
        reason: 'Claim created',
      },
    );

  return { store, clock, engine, seed };
}

async function rejection(promise: Promise<unknown>, code: ErrorCode): Promise<WorkflowError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isWorkflowError(error, code)) {
    throw new Error(`Expected WorkflowError ${code}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  return error;
}

describe('WorkflowEngine.createClaim', () => {
  it('creates the claim in initialState with CLAIM_CREATED as seq 1', async () => {
    const { engine, store, clock } = setup();
    clock.advance({ hours: 3 });
    const at = '2026-03-01T03:00:00.000Z';

    const claim = await engine.createClaim(CLERK, { memberId: 'm-7', amount: 1200, policyLimit: 5000, documents: ['invoice'] });

    expect(claim).toEqual({
      id: expect.any(String),
      memberId: 'm-7',
      status: 'SUBMITTED',
      stateEnteredAt: at,
      amount: 1200,
      policyLimit: 5000,
      createdAt: at,
      createdBy: CLERK,
      version: 1,
      data: { documents: ['invoice'] },
    });
    expect(await store.getClaim(claim.id)).toEqual(claim);
    expect(await store.listAuditByClaim(claim.id)).toEqual([
      expect.objectContaining({
        seq: 1,
        type: 'CLAIM_CREATED',
        timestamp: at,
        fromState: null,
        toState: 'SUBMITTED',
        triggeredBy: { userId: CLERK, role: 'document_clerk' },
        reason: 'Claim created',
        data: { memberId: 'm-7', amount: 1200, policyLimit: 5000, documents: ['invoice'] },
      }),
    ]);
  });

  it('gives concurrent creations distinct ids', async () => {
    const { engine } = setup();
    const claims = await Promise.all(
      Array.from({ length: 5 }, () => engine.createClaim(CLERK, { memberId: 'm-1', amount: 1, policyLimit: 1 })),
    );
    expect(new Set(claims.map((c) => c.id)).size).toBe(5);
  });

  it('does not keep a reference to the caller input', async () => {
    const { engine, store } = setup();
    const documents = ['invoice'];
    const claim = await engine.createClaim(CLERK, { memberId: 'm-1', amount: 1, policyLimit: 1, documents });
    documents.push('tampered');
    expect((await store.getClaim(claim.id))?.data.documents).toEqual(['invoice']);
  });

  it('UNKNOWN_USER and UNAUTHORIZED_ROLE (case 16), without writing anything', async () => {
    const { engine, store } = setup();
    const input = { memberId: 'm-1', amount: 1, policyLimit: 1 };

    await rejection(engine.createClaim('u-x', input), 'UNKNOWN_USER');
    const error = await rejection(engine.createClaim(ASSESSOR, input), 'UNAUTHORIZED_ROLE');
    expect(error.message).toBe('Action createClaim requires role document_clerk; user u-assessor-1 has role assessor');
    expect(await store.listClaims()).toEqual([]);
    expect(await store.listAllAudit()).toEqual([]);
  });

  it('INVALID_PAYLOAD for fields outside core + inputs, core fields the engine owns included', async () => {
    const { engine, store } = setup();
    const error = await rejection(
      engine.createClaim(CLERK, { memberId: 'm-1', amount: 1, policyLimit: 1, status: 'APPROVED', extra: 1 }),
      'INVALID_PAYLOAD',
    );
    expect(error.message).toBe(
      'Fields status, extra are not accepted by action createClaim. Allowed: memberId, amount, policyLimit, documents',
    );
    expect(await store.listClaims()).toEqual([]);
  });

  it('VALIDATION_ERROR lists every bad core value', async () => {
    const { engine, store } = setup();
    const error = await rejection(
      engine.createClaim(CLERK, { memberId: '  ', amount: 0, policyLimit: '10' as unknown as number }),
      'VALIDATION_ERROR',
    );
    expect(error.message).toBe('memberId is required; amount must be a positive number, got 0; policyLimit must be a positive number, got "10"');
    expect(error.details?.errors).toEqual([
      { field: 'memberId', message: 'memberId is required' },
      { field: 'amount', message: 'amount must be a positive number, got 0' },
      { field: 'policyLimit', message: 'policyLimit must be a positive number, got "10"' },
    ]);

    await rejection(engine.createClaim(CLERK, { amount: 1, policyLimit: 1 } as never), 'VALIDATION_ERROR');
    await rejection(engine.createClaim(CLERK, { memberId: 'm', amount: Number.NaN, policyLimit: 1 }), 'VALIDATION_ERROR');
    await rejection(engine.createClaim(CLERK, ['x'] as never), 'VALIDATION_ERROR');
    expect(await store.listClaims()).toEqual([]);
  });
});

describe('WorkflowEngine.acknowledge', () => {
  it('writes the ACKNOWLEDGE_FIELDS into data, bumps version and records MEMBER_ACKNOWLEDGED', async () => {
    const { engine, store, clock, seed } = setup();
    const claim = await seed();
    clock.advance({ days: 2 });
    const at = '2026-03-03T00:00:00.000Z';

    const result = await engine.acknowledge(claim.id, CLERK, 'Member called in', 1);

    expect(result.claim).toMatchObject({
      status: 'REJECTED',
      stateEnteredAt: T0,
      version: 2,
      data: { documents: ALL_DOCS, memberAcknowledged: true, memberAcknowledgedAt: at, memberAcknowledgedBy: CLERK },
    });
    expect(await store.getClaim(claim.id)).toEqual(result.claim);
    expect(result.audit).toMatchObject({
      seq: 2,
      type: 'MEMBER_ACKNOWLEDGED',
      timestamp: at,
      fromState: 'REJECTED',
      toState: 'REJECTED',
      triggeredBy: { userId: CLERK, role: 'document_clerk' },
      reason: 'Member called in',
      notes: 'Member called in',
      data: { memberAcknowledged: true, memberAcknowledgedAt: at, memberAcknowledgedBy: CLERK },
    });
    expect(result.audit).not.toHaveProperty('transitionId');
  });

  it('reason defaults to the action description without notes', async () => {
    const { engine, seed } = setup();
    const claim = await seed();
    const { audit } = await engine.acknowledge(claim.id, CLERK);
    expect(audit.reason).toBe('Member acknowledgement recorded');
    expect(audit).not.toHaveProperty('notes');
  });

  it('lets close_rejected run before the appeal period ends (case 2)', async () => {
    const { engine, seed } = setup();
    const claim = await seed();
    await engine.acknowledge(claim.id, CLERK);
    const { claim: closed } = await engine.transition(claim.id, SYSTEM, { to: 'CLOSED' });
    expect(closed.status).toBe('CLOSED');
  });

  it('UNKNOWN_USER and CLAIM_NOT_FOUND are thrown without audit', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed();
    await rejection(engine.acknowledge(claim.id, 'u-x'), 'UNKNOWN_USER');
    await rejection(engine.acknowledge('c-missing', CLERK), 'CLAIM_NOT_FOUND');
    expect(await store.listAllAudit()).toHaveLength(1);
  });

  describe('rejections are audited as ACTION_REJECTED, then thrown', () => {
    async function rejected(
      env: ReturnType<typeof setup>,
      claim: Claim,
      userId: string,
      code: ErrorCode,
      notes?: string,
      expectedVersion?: number,
    ) {
      const before = await env.store.listAuditByClaim(claim.id);
      const stored = await env.store.getClaim(claim.id);
      const error = await rejection(env.engine.acknowledge(claim.id, userId, notes, expectedVersion), code);

      const after = await env.store.listAuditByClaim(claim.id);
      expect(after).toHaveLength(before.length + 1);
      const entry = after.at(-1)!;
      expect(entry).toMatchObject({
        seq: before.length + 1,
        type: 'ACTION_REJECTED',
        fromState: stored!.status,
        toState: stored!.status,
        reason: error.message,
        data: { action: 'acknowledge', code, errors: [{ message: error.message }] },
      });
      expect(await env.store.getClaim(claim.id)).toEqual(stored);
      return { error, entry };
    }

    it('STALE_CLAIM, keeping notes', async () => {
      const env = setup();
      const claim = await env.seed();
      const { error, entry } = await rejected(env, claim, CLERK, 'STALE_CLAIM', 'old screen', 0);
      expect(error.message).toBe(`Claim ${claim.id} was modified (version 1, expected 0); reload and retry`);
      expect(entry.notes).toBe('old screen');
    });

    it('UNAUTHORIZED_ROLE (case 17)', async () => {
      const env = setup();
      const claim = await env.seed();
      const { error, entry } = await rejected(env, claim, FINANCE, 'UNAUTHORIZED_ROLE');
      expect(error.message).toBe('Action acknowledge requires role document_clerk; user u-finance-1 has role finance');
      expect(entry.triggeredBy).toEqual({ userId: FINANCE, role: 'finance' });
    });

    it('ACTION_NOT_ALLOWED_IN_STATE outside allowedStates (case 17)', async () => {
      const env = setup();
      const claim = await env.seed('APPROVED');
      const { error } = await rejected(env, claim, CLERK, 'ACTION_NOT_ALLOWED_IN_STATE');
      expect(error.message).toBe('Action acknowledge is only allowed in states: REJECTED (current: APPROVED)');
    });

    it('ACTION_NOT_ALLOWED_IN_STATE on a second acknowledge, naming the first (case 17)', async () => {
      const env = setup();
      const claim = await env.seed();
      await env.engine.acknowledge(claim.id, CLERK);
      env.clock.advance({ hours: 1 });

      const { error } = await rejected(env, claim, CLERK, 'ACTION_NOT_ALLOWED_IN_STATE');
      expect(error.message).toBe(`Member acknowledgement already recorded at ${T0} by ${CLERK}`);
      expect((await env.store.getClaim(claim.id))?.data.memberAcknowledgedAt).toBe(T0);
    });
  });

  it('two acknowledges at once: one MEMBER_ACKNOWLEDGED, one ACTION_REJECTED (in-memory case 28)', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed();

    const results = await Promise.allSettled([engine.acknowledge(claim.id, CLERK), engine.acknowledge(claim.id, CLERK)]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isWorkflowError(failure.reason, 'ACTION_NOT_ALLOWED_IN_STATE')).toBe(true);

    const audit = await store.listAuditByClaim(claim.id);
    expect(audit.map((e) => e.type)).toEqual(['CLAIM_CREATED', 'MEMBER_ACKNOWLEDGED', 'ACTION_REJECTED']);
    expect((await store.getClaim(claim.id))?.version).toBe(2);
  });
});
