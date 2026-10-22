import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { FakeClock } from '../../src/clock';
import { loadConfig } from '../../src/config';
import { WorkflowEngine } from '../../src/engine';
import { WorkflowError, isWorkflowError, type ErrorCode } from '../../src/errors';
import type { Claim, NewClaim } from '../../src/model';
import { defaultRules, type RuleRegistry } from '../../src/rules';
import { createBuiltinSideEffects, type SideEffectHandler, type SideEffectRegistry } from '../../src/side-effects';
import { InMemoryWorkflowStore } from '../../src/store';

const configDir = resolve(__dirname, '../../../../config');
const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));
const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });

const T0 = '2026-03-01T00:00:00.000Z';
const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];

const CLERK = 'u-clerk-1';
const LEAD = 'u-lead-1';
const ASSESSOR = 'u-assessor-1';
const FINANCE = 'u-finance-1';
const SYSTEM = 'u-system';

/** Stand-ins for the real handlers; `failing` makes the named handler throw. */
function fakeSideEffects(failing: ReadonlySet<string> = new Set()): SideEffectRegistry {
  const guard = (name: string) => {
    if (failing.has(name)) throw new Error(`${name} exploded`);
  };
  const handlers: SideEffectHandler<any>[] = [
    {
      name: 'notify',
      params: z.object({ to: z.string(), template: z.string() }),
      run: ({ to }, ctx) => {
        guard('notify');
        return { result: { to, claimStatus: ctx.claim.status } };
      },
    },
    {
      name: 'setField',
      params: z.object({ field: z.string(), value: z.unknown() }),
      run: ({ field, value }, ctx) => {
        guard('setField');
        return { dataPatch: { [field]: value === '$now' ? ctx.now.toISOString() : value } };
      },
    },
    {
      name: 'createPaymentRequest',
      params: z.object({}),
      run: async (_params, ctx) => {
        guard('createPaymentRequest');
        const id = `pr-${ctx.claim.id}`;
        return {
          result: { paymentRequestId: id },
          dataPatch: { paymentRequest: { id, amount: ctx.claim.amount, createdAt: ctx.now.toISOString() } },
        };
      },
    },
    {
      name: 'triggerPaymentSystem',
      params: z.object({}),
      run: (_params, ctx) => {
        guard('triggerPaymentSystem');
        return { dataPatch: { paymentInitiatedAt: ctx.now.toISOString() } };
      },
    },
  ];
  return new Map(handlers.map((h) => [h.name, h]));
}

interface SetupOptions {
  lockTimeoutMs?: number;
  rules?: RuleRegistry;
  failing?: string[];
  sideEffects?: SideEffectRegistry;
}

function setup(options: SetupOptions = {}) {
  const store = new InMemoryWorkflowStore({ lockTimeoutMs: options.lockTimeoutMs ?? 500 });
  const clock = new FakeClock(T0);
  const engine = new WorkflowEngine({
    config,
    store,
    clock,
    rules: options.rules,
    sideEffects: options.sideEffects ?? fakeSideEffects(new Set(options.failing)),
  });

  const seed = (status = 'SUBMITTED', overrides: Partial<NewClaim> = {}): Promise<Claim> =>
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

describe('WorkflowEngine.transition: success', () => {
  it('moves the claim, bumps version, merges payload and records TRANSITION with clock time', async () => {
    const { engine, store, clock, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });
    clock.advance({ days: 2 });

    const result = await engine.transition(claim.id, ASSESSOR, {
      to: 'APPROVED',
      payload: { assessmentReport: 'All good' },
    });

    const at = '2026-03-03T00:00:00.000Z';
    expect(result.claim).toMatchObject({
      status: 'APPROVED',
      stateEnteredAt: at,
      version: 2,
      data: { assessmentReport: 'All good', assessorId: ASSESSOR },
    });
    expect(await store.getClaim(claim.id)).toEqual(result.claim);

    const [entry] = result.audit;
    expect(entry).toMatchObject({
      seq: 2,
      type: 'TRANSITION',
      timestamp: at,
      fromState: 'UNDER_ASSESSMENT',
      toState: 'APPROVED',
      transitionId: 'approve',
      triggeredBy: { userId: ASSESSOR, role: 'assessor' },
      reason: 'Assessor approved the claim for payment',
      data: { assessmentReport: 'All good' },
    });
    expect(await store.listAuditByClaim(claim.id)).toEqual([expect.objectContaining({ seq: 1 }), ...result.audit]);
  });

  it('reason: reasonField, then notes, then description (case 22)', async () => {
    const { engine, seed } = setup();
    const a = await seed('UNDER_ASSESSMENT');
    const b = await seed('UNDER_ASSESSMENT');
    const c = await seed('UNDER_ASSESSMENT');

    const rejected = await engine.transition(a.id, ASSESSOR, {
      to: 'REJECTED',
      payload: { assessmentReport: 'r', rejectionReason: 'Not covered' },
      notes: 'ignored for reason',
    });
    const withNotes = await engine.transition(b.id, ASSESSOR, {
      to: 'APPROVED',
      payload: { assessmentReport: 'r' },
      notes: 'Fast-tracked',
    });
    const plain = await engine.transition(c.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'r' } });

    expect(rejected.audit[0]).toMatchObject({ reason: 'Not covered', notes: 'ignored for reason' });
    expect(withNotes.audit[0]).toMatchObject({ reason: 'Fast-tracked', notes: 'Fast-tracked' });
    expect(plain.audit[0].reason).toBe('Assessor approved the claim for payment');
    expect(plain.audit[0]).not.toHaveProperty('notes');
  });

  it('accepts expectedVersion that matches', async () => {
    const { engine, seed } = setup();
    const claim = await seed();
    const result = await engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', expectedVersion: 1 });
    expect(result.claim.version).toBe(2);
  });

  it('replaces documents with the payload list (not appended) before evaluating preconditions', async () => {
    const { engine, seed } = setup();
    const claim = await seed('PENDING_INFO', { data: { documents: [...ALL_DOCS, 'old_letter'] } });

    const result = await engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { documents: ALL_DOCS } });
    expect(result.claim.data.documents).toEqual(ALL_DOCS);
  });
});

describe('WorkflowEngine.transition: side effects', () => {
  it('runs side effects in config order, applies dataPatch and records SIDE_EFFECT after TRANSITION', async () => {
    const { engine, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');

    const { claim: next, audit } = await engine.transition(claim.id, ASSESSOR, {
      to: 'APPROVED',
      payload: { assessmentReport: 'ok' },
    });

    expect(audit.map((e) => [e.seq, e.type, e.reason])).toEqual([
      [2, 'TRANSITION', 'Assessor approved the claim for payment'],
      [3, 'SIDE_EFFECT', 'Side effect notify succeeded'],
      [4, 'SIDE_EFFECT', 'Side effect createPaymentRequest succeeded'],
    ]);
    for (const entry of audit.slice(1)) {
      expect(entry).toMatchObject({
        transitionId: 'approve',
        fromState: 'UNDER_ASSESSMENT',
        toState: 'APPROVED',
        triggeredBy: { userId: ASSESSOR, role: 'assessor' },
        timestamp: T0,
      });
    }
    // notify saw the draft after the state change.
    expect(audit[1].data).toEqual({ name: 'notify', status: 'ok', result: { to: 'member', claimStatus: 'APPROVED' } });
    expect(audit[2].data).toEqual({
      name: 'createPaymentRequest',
      status: 'ok',
      result: { paymentRequestId: `pr-${claim.id}` },
    });
    expect(next.data.paymentRequest).toEqual({ id: `pr-${claim.id}`, amount: 1500, createdAt: T0 });
  });

  it('a later side effect sees the patch of an earlier one', async () => {
    const { engine, seed } = setup();
    const claim = await seed('DOCUMENTS_VERIFIED');
    const { claim: next } = await engine.transition(claim.id, LEAD, { to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
    expect(next.data.assessmentStartedAt).toBe(T0);
  });

  it('a failing handler is recorded as failed, its patch dropped, later handlers still run, no rollback (case 23)', async () => {
    const { engine, store, seed } = setup({ failing: ['notify'] });
    const claim = await seed('UNDER_ASSESSMENT');

    const { claim: next, audit } = await engine.transition(claim.id, ASSESSOR, {
      to: 'APPROVED',
      payload: { assessmentReport: 'ok' },
    });

    expect(audit.map((e) => e.reason)).toEqual([
      'Assessor approved the claim for payment',
      'Side effect notify failed: notify exploded',
      'Side effect createPaymentRequest succeeded',
    ]);
    expect(audit[1].data).toEqual({ name: 'notify', status: 'failed', error: 'notify exploded' });
    expect(next.status).toBe('APPROVED');
    expect((await store.getClaim(claim.id))?.status).toBe('APPROVED');
  });

  it('createPaymentRequest failing leaves the claim APPROVED without paymentRequest, so initiate_payment is blocked', async () => {
    const { engine, store, seed } = setup({ failing: ['createPaymentRequest'] });
    const claim = await seed('UNDER_ASSESSMENT');
    await engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } });

    const error = await rejection(engine.transition(claim.id, FINANCE, { to: 'PAYMENT_INITIATED' }), 'PRECONDITION_FAILED');
    expect(error.message).toBe('Payment request has not been created');
    expect((await store.getClaim(claim.id))?.data).not.toHaveProperty('paymentRequest');
  });

  it('a dataPatch writing a core field fails that side effect', async () => {
    const sideEffects = new Map(fakeSideEffects());
    sideEffects.set('triggerPaymentSystem', {
      name: 'triggerPaymentSystem',
      params: z.object({}),
      run: () => ({ dataPatch: { amount: 1 } }),
    });
    const { engine, seed } = setup({ sideEffects });
    const claim = await seed('APPROVED', { data: { paymentRequest: { id: 'pr-1' } } });

    const { claim: next, audit } = await engine.transition(claim.id, FINANCE, { to: 'PAYMENT_INITIATED' });
    expect(audit[1].reason).toBe('Side effect triggerPaymentSystem failed: Side effect triggerPaymentSystem may not write core fields: amount');
    expect(next.amount).toBe(1500);
  });
});

describe('WorkflowEngine.transition: errors without audit', () => {
  it('UNKNOWN_USER, checked before the claim (case 18)', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed();

    const error = await rejection(engine.transition(claim.id, 'u-x', { to: 'DOCUMENTS_VERIFIED' }), 'UNKNOWN_USER');
    expect(error.message).toBe('Unknown user u-x');
    await rejection(engine.transition('c-missing', 'u-x', { to: 'DOCUMENTS_VERIFIED' }), 'UNKNOWN_USER');
    expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
  });

  it('CLAIM_NOT_FOUND', async () => {
    const { engine, store } = setup();
    const error = await rejection(engine.transition('c-missing', CLERK, { to: 'DOCUMENTS_VERIFIED' }), 'CLAIM_NOT_FOUND');
    expect(error.message).toBe('Claim c-missing not found');
    expect(await store.listAllAudit()).toEqual([]);
  });

  it('CLAIM_BUSY when another transaction holds the lock past the timeout', async () => {
    const { engine, store, seed } = setup({ lockTimeoutMs: 50 });
    const claim = await seed();
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    const holder = store.withClaim(claim.id, () => held);

    await rejection(engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED' }), 'CLAIM_BUSY');
    release();
    await holder;
    expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
  });

  it('an error thrown inside the transaction rolls back everything, including audit', async () => {
    const rules: RuleRegistry = new Map([
      ...defaultRules,
      ['notEmpty', { ...defaultRules.get('notEmpty')!, evaluate: () => { throw new Error('rule exploded'); } }],
    ]);
    const { engine, store, seed } = setup({ rules });
    const claim = await seed('UNDER_ASSESSMENT');

    await expect(
      engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } }),
    ).rejects.toThrow('rule exploded');
    expect(await store.getClaim(claim.id)).toEqual(claim);
    expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
  });
});

describe('WorkflowEngine.transition: rejections are audited, then thrown', () => {
  /** Runs a rejected request and checks the invariants every rejection must keep. */
  async function rejected(
    env: ReturnType<typeof setup>,
    claim: Claim,
    userId: string,
    request: Parameters<WorkflowEngine['transition']>[2],
    code: ErrorCode,
  ) {
    const before = await env.store.listAuditByClaim(claim.id);
    const stored = await env.store.getClaim(claim.id);
    const error = await rejection(env.engine.transition(claim.id, userId, request), code);

    const after = await env.store.listAuditByClaim(claim.id);
    expect(after).toHaveLength(before.length + 1);
    const entry = after.at(-1)!;
    expect(entry).toMatchObject({
      seq: before.length + 1,
      type: 'TRANSITION_REJECTED',
      fromState: stored!.status,
      toState: request.to,
      reason: error.message,
      data: { code, payload: request.payload ?? {} },
    });
    expect(await env.store.getClaim(claim.id)).toEqual(stored);
    return { error, entry };
  }

  it('STALE_CLAIM: checked under the lock, no transitionId', async () => {
    const env = setup();
    const claim = await env.seed();
    const { error, entry } = await rejected(
      env,
      claim,
      CLERK,
      { to: 'DOCUMENTS_VERIFIED', expectedVersion: 0, notes: 'from an old screen' },
      'STALE_CLAIM',
    );
    expect(error.message).toBe(`Claim ${claim.id} was modified (version 1, expected 0); reload and retry`);
    expect(entry).not.toHaveProperty('transitionId');
    expect(entry).toMatchObject({ notes: 'from an old screen', data: { errors: [{ message: error.message }] } });
  });

  it('INVALID_TRANSITION: no such edge lists the allowed transitions (case 5)', async () => {
    const env = setup();
    const claim = await env.seed();
    const { error, entry } = await rejected(env, claim, ASSESSOR, { to: 'APPROVED' }, 'INVALID_TRANSITION');
    expect(error.message).toBe('Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)');
    expect(error.details).toMatchObject({
      allowed: [{ transitionId: 'verify_documents', to: 'DOCUMENTS_VERIFIED', roles: ['document_clerk'] }],
    });
    expect(entry).not.toHaveProperty('transitionId');
  });

  it('INVALID_TRANSITION: terminal state and unknown state (case 6)', async () => {
    const env = setup();
    const closed = await env.seed('CLOSED');
    const submitted = await env.seed();

    const terminal = await rejected(env, closed, SYSTEM, { to: 'SUBMITTED' }, 'INVALID_TRANSITION');
    expect(terminal.error.message).toBe('Claim is in terminal state CLOSED; no transitions allowed');

    const unknown = await rejected(env, submitted, CLERK, { to: 'FOO' }, 'INVALID_TRANSITION');
    expect(unknown.error.message).toBe(
      'Unknown state FOO. Known states: SUBMITTED, DOCUMENTS_VERIFIED, UNDER_ASSESSMENT, PENDING_INFO, ' +
        'APPROVED, REJECTED, PAYMENT_INITIATED, CLOSED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)',
    );
    expect(unknown.entry.toState).toBe('FOO');
  });

  it('UNAUTHORIZED_ROLE (case 15)', async () => {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT');
    const { error, entry } = await rejected(
      env,
      claim,
      CLERK,
      { to: 'APPROVED', payload: { assessmentReport: 'ok' } },
      'UNAUTHORIZED_ROLE',
    );
    expect(error.message).toBe('Transition approve requires role assessor; user u-clerk-1 has role document_clerk');
    expect(entry).toMatchObject({ transitionId: 'approve', triggeredBy: { userId: CLERK, role: 'document_clerk' } });
  });

  it('INVALID_PAYLOAD lists every field outside inputs (case 14)', async () => {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT');

    const one = await rejected(
      env,
      claim,
      ASSESSOR,
      { to: 'APPROVED', payload: { assessmentReport: 'ok', amount: 1 } },
      'INVALID_PAYLOAD',
    );
    expect(one.error.message).toBe('Field amount is not accepted by transition approve. Allowed: assessmentReport');

    const many = await rejected(
      env,
      claim,
      ASSESSOR,
      { to: 'APPROVED', payload: { status: 'CLOSED', extra: 1 } },
      'INVALID_PAYLOAD',
    );
    expect(many.error.message).toBe('Fields status, extra are not accepted by transition approve. Allowed: assessmentReport');
  });

  it('INVALID_PAYLOAD when payload is not an object', async () => {
    const env = setup();
    const claim = await env.seed('APPROVED', { data: { paymentRequest: { id: 'pr-1' } } });
    const { error } = await rejected(
      env,
      claim,
      FINANCE,
      { to: 'PAYMENT_INITIATED', payload: ['x'] as unknown as Record<string, unknown> },
      'INVALID_PAYLOAD',
    );
    expect(error.message).toBe('Payload of transition initiate_payment must be an object. Allowed: none');
  });

  it('PRECONDITION_FAILED stores every rule failure (cases 7, 9)', async () => {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT', { amount: 12000 });
    const { error, entry } = await rejected(env, claim, ASSESSOR, { to: 'APPROVED' }, 'PRECONDITION_FAILED');

    expect(error.message).toBe('assessmentReport is required; amount 12000 exceeds policyLimit 10000');
    expect(entry.data?.errors).toEqual([
      { rule: 'notEmpty', field: 'assessmentReport', path: 'all[0]', message: 'assessmentReport is required' },
      { rule: 'lte', field: 'amount', path: 'all[1]', message: 'amount 12000 exceeds policyLimit 10000' },
    ]);
  });

  it('PRECONDITION_FAILED is evaluated on the draft with the payload merged (case 12)', async () => {
    const env = setup();
    const claim = await env.seed('PENDING_INFO');
    const { error } = await rejected(
      env,
      claim,
      CLERK,
      { to: 'DOCUMENTS_VERIFIED', payload: { documents: ['claim_form'] } },
      'PRECONDITION_FAILED',
    );
    expect(error.message).toBe('Missing required documents: invoice, id_proof');
  });

  it('case 8: verify_documents with missing required documents lists them, from the claim or the payload', async () => {
    const env = setup();
    const claim = await env.seed('SUBMITTED', { data: { documents: ['claim_form'] } });

    const onClaim = await rejected(env, claim, CLERK, { to: 'DOCUMENTS_VERIFIED' }, 'PRECONDITION_FAILED');
    expect(onClaim.error.message).toBe('Missing required documents: invoice, id_proof');
    expect(onClaim.entry).toMatchObject({
      transitionId: 'verify_documents',
      data: {
        errors: [{ rule: 'containsAll', field: 'documents', path: '', message: 'Missing required documents: invoice, id_proof' }],
      },
    });

    const inPayload = await rejected(
      env,
      claim,
      CLERK,
      { to: 'DOCUMENTS_VERIFIED', payload: { documents: ['invoice'] } },
      'PRECONDITION_FAILED',
    );
    expect(inPayload.error.message).toBe('Missing required documents: claim_form, id_proof');
  });

  it('case 10: reject without rejectionReason, or with a blank one, is PRECONDITION_FAILED', async () => {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, rejectionReason: 'from an earlier attempt' } });

    for (const payload of [
      { assessmentReport: 'Not covered' },
      { assessmentReport: 'Not covered', rejectionReason: '' },
      { assessmentReport: 'Not covered', rejectionReason: '   ' },
    ]) {
      const { error, entry } = await rejected(env, claim, ASSESSOR, { to: 'REJECTED', payload }, 'PRECONDITION_FAILED');
      expect(error.message).toBe('rejectionReason must be provided in this request');
      expect(entry).toMatchObject({ transitionId: 'reject', data: { errors: [{ rule: 'providedInRequest', field: 'rejectionReason' }] } });
    }
  });

  it('case 11: info_received needs infoResponse or documents in this request; values already on the claim do not count', async () => {
    const env = setup();
    const claim = await env.seed('PENDING_INFO', { data: { documents: ALL_DOCS, infoResponse: 'old answer' } });

    const { error } = await rejected(env, claim, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: {} }, 'PRECONDITION_FAILED');
    expect(error.message).toBe('infoResponse must be provided in this request; documents must be provided in this request');

    const blank = await rejected(
      env,
      claim,
      CLERK,
      { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: ' ', documents: [] } },
      'PRECONDITION_FAILED',
    );
    expect(blank.error.message).toBe(
      'infoResponse must be provided in this request; documents must be provided in this request; ' +
        'Missing required documents: claim_form, invoice, id_proof',
    );

    const answered = await env.engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: 'new answer' } });
    expect(answered.claim).toMatchObject({ status: 'DOCUMENTS_VERIFIED', data: { infoResponse: 'new answer', documents: ALL_DOCS } });

    const other = await env.seed('PENDING_INFO');
    const withDocs = await env.engine.transition(other.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { documents: ALL_DOCS } });
    expect(withDocs.claim.status).toBe('DOCUMENTS_VERIFIED');
    expect(withDocs.claim.data).not.toHaveProperty('infoResponse');
  });

  it('close_rejected is blocked until the appeal period ends on the clock (cases 3, 13)', async () => {
    const env = setup();
    const claim = await env.seed('REJECTED');
    env.clock.advance({ days: 29 });

    const { error } = await rejected(env, claim, SYSTEM, { to: 'CLOSED' }, 'PRECONDITION_FAILED');
    expect(error.message).toBe('Only 29 of 30 days elapsed since stateEnteredAt; memberAcknowledged must be true');

    env.clock.advance({ days: 1 });
    const { claim: closed } = await env.engine.transition(claim.id, SYSTEM, { to: 'CLOSED' });
    expect(closed).toMatchObject({ status: 'CLOSED', data: { archivedAt: '2026-03-31T00:00:00.000Z' } });
  });

  it('CYCLE_LIMIT_EXCEEDED on the 4th request_info; rejected attempts do not count (cases 19, 20)', async () => {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });
    const requestInfo = (description?: string) =>
      env.engine.transition(claim.id, ASSESSOR, {
        to: 'PENDING_INFO',
        payload: description === undefined ? {} : { missingInfoDescription: description },
      });

    for (let round = 1; round <= 3; round++) {
      await rejection(requestInfo(), 'PRECONDITION_FAILED');
      await requestInfo(`round ${round}`);
      await env.engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: `answer ${round}` } });
      await env.engine.transition(claim.id, LEAD, { to: 'UNDER_ASSESSMENT' });
    }

    const { error, entry } = await rejected(
      env,
      claim,
      ASSESSOR,
      { to: 'PENDING_INFO', payload: { missingInfoDescription: 'round 4' } },
      'CYCLE_LIMIT_EXCEEDED',
    );
    expect(error.message).toBe('Maximum information requests exceeded — escalate to team lead');
    expect(entry.transitionId).toBe('request_info');

    const audit = await env.store.listAuditByClaim(claim.id);
    expect(audit.filter((e) => e.type === 'TRANSITION' && e.transitionId === 'request_info')).toHaveLength(3);
    expect(audit.map((e) => e.seq)).toEqual(audit.map((_, i) => i + 1));
  });
});

describe('WorkflowEngine.transition: concurrency (in-memory)', () => {
  it('approve and reject at once: one wins, the other is INVALID_TRANSITION and audited', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');

    const results = await Promise.allSettled([
      engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } }),
      engine.transition(claim.id, 'u-assessor-2', {
        to: 'REJECTED',
        payload: { assessmentReport: 'no', rejectionReason: 'Not covered' },
      }),
    ]);

    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const failure = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(isWorkflowError(failure.reason, 'INVALID_TRANSITION')).toBe(true);

    const audit = await store.listAuditByClaim(claim.id);
    expect(audit.filter((e) => e.type === 'TRANSITION')).toHaveLength(1);
    expect(audit.filter((e) => e.type === 'TRANSITION_REJECTED')).toHaveLength(1);
    expect(audit.map((e) => e.seq)).toEqual(audit.map((_, i) => i + 1));
  });
});

describe('WorkflowEngine.transition: built-in side effects', () => {
  it('a notify with an empty variable is sent, status ok, and the audit names the missing variable', async () => {
    const workflow = readJson('claims-workflow.json');
    workflow.transitions.find((t: { id: string }) => t.id === 'approve').sideEffects[0].params.template =
      'Claim {{id}} approved by {{assessorId}}';
    const custom = loadConfig({ workflow, users: readJson('users.json') });
    const lines: string[] = [];
    const store = new InMemoryWorkflowStore();
    const engine = new WorkflowEngine({
      config: custom,
      store,
      clock: new FakeClock(T0),
      sideEffects: createBuiltinSideEffects({ log: (l) => lines.push(l), paymentRequestId: () => 'pr-1' }),
    });
    const claim = await store.createClaim(
      {
        memberId: 'm-1',
        status: 'UNDER_ASSESSMENT',
        stateEnteredAt: T0,
        amount: 1500,
        policyLimit: 10000,
        createdAt: T0,
        createdBy: CLERK,
        data: {},
      },
      { type: 'CLAIM_CREATED', timestamp: T0, fromState: null, toState: 'UNDER_ASSESSMENT', triggeredBy: { userId: CLERK, role: 'document_clerk' }, reason: 'Claim created' },
    );

    const { audit } = await engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'ok' } });

    expect(audit[1]).toMatchObject({
      reason: 'Side effect notify succeeded',
      data: {
        name: 'notify',
        status: 'ok',
        result: { recipients: ['m-1'], message: `Claim ${claim.id} approved by `, missingVariables: ['assessorId'] },
      },
    });
    expect(lines[0]).toBe(`[NOTIFY → m-1] Claim ${claim.id} approved by `);
  });

  it('uses the built-in registry when sideEffects is omitted', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const store = new InMemoryWorkflowStore();
      const engine = new WorkflowEngine({ config, store, clock: new FakeClock(T0) });
      const claim = await store.createClaim(
        {
          memberId: 'm-1',
          status: 'SUBMITTED',
          stateEnteredAt: T0,
          amount: 1500,
          policyLimit: 10000,
          createdAt: T0,
          createdBy: CLERK,
          data: {},
        },
        { type: 'CLAIM_CREATED', timestamp: T0, fromState: null, toState: 'SUBMITTED', triggeredBy: { userId: CLERK, role: 'document_clerk' }, reason: 'Claim created' },
      );

      const { audit } = await engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { documents: ALL_DOCS } });
      expect(audit[1]).toMatchObject({ reason: 'Side effect notify succeeded' });
      expect(log).toHaveBeenCalledWith(expect.stringContaining('[NOTIFY → u-assessor-1, u-assessor-2]'));
    } finally {
      log.mockRestore();
    }
  });
});

describe('WorkflowEngine construction', () => {
  it('fails fast when a side effect in the config is not registered', () => {
    const sideEffects = new Map(fakeSideEffects());
    sideEffects.delete('createPaymentRequest');
    expect(() => new WorkflowEngine({ config, store: new InMemoryWorkflowStore(), sideEffects })).toThrow(
      'Unknown side effect createPaymentRequest in transition approve sideEffects[1]',
    );
  });

  it('fails fast when side effect params do not match the handler schema', () => {
    const sideEffects = new Map(fakeSideEffects());
    sideEffects.set('notify', { name: 'notify', params: z.object({ channel: z.string() }), run: () => ({}) });
    expect(() => new WorkflowEngine({ config, store: new InMemoryWorkflowStore(), sideEffects })).toThrow(
      'Invalid params for side effect notify in transition verify_documents sideEffects[0]',
    );
  });
});
