import { describe, expect, it } from 'vitest';
import type { AuditEntry } from '../../src/model';
import { ALL_DOCS, ASSESSOR, CLERK, FINANCE, LEAD, SYSTEM, T0, setup } from './helpers';

const at = (hours: number) => new Date(Date.parse(T0) + hours * 3_600_000).toISOString();

/** One row per entry, so a whole audit trail can be compared in one assertion. */
const rows = (audit: AuditEntry[]) =>
  audit.map((e) => [e.seq, e.type, e.transitionId ?? null, (e.data as { name?: string } | undefined)?.name ?? null]);

/** createClaim at T0, then one transition per hour up to CLOSED. */
async function happyPath() {
  const env = setup();
  const { engine, clock } = env;
  const step = async (userId: string, request: Parameters<typeof engine.transition>[2]) => {
    clock.advance({ hours: 1 });
    return engine.transition(claim.id, userId, request);
  };

  const claim = await engine.createClaim(CLERK, { memberId: 'm-1', amount: 1500, policyLimit: 10000, documents: ALL_DOCS });
  await step(CLERK, { to: 'DOCUMENTS_VERIFIED' });
  await step(LEAD, { to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR }, notes: 'Assigned to Carol' });
  await step(ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'Covered' } });
  await step(FINANCE, { to: 'PAYMENT_INITIATED' });
  const { claim: closed } = await step(FINANCE, {
    to: 'CLOSED',
    payload: { paymentReference: 'PAY-123' },
    notes: 'Paid by bank transfer',
  });

  return { ...env, claim, closed, audit: await env.store.listAuditByClaim(claim.id) };
}

describe('happy path', () => {
  it('case 1: createClaim through CLOSED writes 13 audit entries in order, all side effects ok, notify rendered', async () => {
    const { claim, closed, audit, lines } = await happyPath();

    expect(rows(audit)).toEqual([
      [1, 'CLAIM_CREATED', null, null],
      [2, 'TRANSITION', 'verify_documents', null],
      [3, 'SIDE_EFFECT', 'verify_documents', 'notify'],
      [4, 'TRANSITION', 'start_assessment', null],
      [5, 'SIDE_EFFECT', 'start_assessment', 'setField'],
      [6, 'SIDE_EFFECT', 'start_assessment', 'notify'],
      [7, 'TRANSITION', 'approve', null],
      [8, 'SIDE_EFFECT', 'approve', 'notify'],
      [9, 'SIDE_EFFECT', 'approve', 'createPaymentRequest'],
      [10, 'TRANSITION', 'initiate_payment', null],
      [11, 'SIDE_EFFECT', 'initiate_payment', 'triggerPaymentSystem'],
      [12, 'TRANSITION', 'confirm_payment', null],
      [13, 'SIDE_EFFECT', 'confirm_payment', 'notify'],
    ]);
    expect(audit[0]).toMatchObject({
      timestamp: T0,
      fromState: null,
      toState: 'SUBMITTED',
      triggeredBy: { userId: CLERK, role: 'document_clerk' },
    });
    expect(audit.filter((e) => e.type === 'SIDE_EFFECT').every((e) => e.data?.status === 'ok')).toBe(true);

    expect(lines).toEqual([
      `[NOTIFY → u-assessor-1, u-assessor-2] Claim ${claim.id} has verified documents and is ready for assessment`,
      `[SET_FIELD] ${claim.id}.assessmentStartedAt = "${at(2)}"`,
      `[NOTIFY → u-assessor-1] Claim ${claim.id} has been assigned to you for assessment`,
      `[NOTIFY → m-1] Claim ${claim.id} has been approved for 1500. Payment will be initiated shortly.`,
      `[PAYMENT] Created payment request pr-1 for claim ${claim.id} (amount 1500)`,
      `[PAYMENT] Triggered payment system for payment request pr-1 (claim ${claim.id})`,
      `[NOTIFY → m-1] Claim ${claim.id} has been paid. Payment reference: PAY-123`,
    ]);
    expect(audit[12].data).toMatchObject({
      result: { recipients: ['m-1'], message: `Claim ${claim.id} has been paid. Payment reference: PAY-123` },
    });

    expect(closed).toMatchObject({
      status: 'CLOSED',
      stateEnteredAt: at(5),
      version: 6,
      data: {
        documents: ALL_DOCS,
        assessorId: ASSESSOR,
        assessmentReport: 'Covered',
        assessmentStartedAt: at(2),
        paymentRequest: { id: 'pr-1', amount: 1500, createdAt: at(3) },
        paymentInitiatedAt: at(4),
        paymentReference: 'PAY-123',
      },
    });
  });

  it('case 22: every TRANSITION entry has timestamp, states, triggeredBy and reason by priority', async () => {
    const { audit } = await happyPath();

    const transitions = audit.filter((e) => e.type === 'TRANSITION');
    expect(
      transitions.map(({ transitionId, timestamp, fromState, toState, triggeredBy, reason }) => ({
        transitionId,
        timestamp,
        fromState,
        toState,
        triggeredBy,
        reason,
      })),
    ).toEqual([
      {
        transitionId: 'verify_documents',
        timestamp: at(1),
        fromState: 'SUBMITTED',
        toState: 'DOCUMENTS_VERIFIED',
        triggeredBy: { userId: CLERK, role: 'document_clerk' },
        reason: 'Document clerk confirmed all required documents are present',
      },
      {
        transitionId: 'start_assessment',
        timestamp: at(2),
        fromState: 'DOCUMENTS_VERIFIED',
        toState: 'UNDER_ASSESSMENT',
        triggeredBy: { userId: LEAD, role: 'team_lead' },
        reason: 'Assigned to Carol',
      },
      {
        transitionId: 'approve',
        timestamp: at(3),
        fromState: 'UNDER_ASSESSMENT',
        toState: 'APPROVED',
        triggeredBy: { userId: ASSESSOR, role: 'assessor' },
        reason: 'Assessor approved the claim for payment',
      },
      {
        transitionId: 'initiate_payment',
        timestamp: at(4),
        fromState: 'APPROVED',
        toState: 'PAYMENT_INITIATED',
        triggeredBy: { userId: FINANCE, role: 'finance' },
        reason: 'Finance initiated payment',
      },
      {
        transitionId: 'confirm_payment',
        timestamp: at(5),
        fromState: 'PAYMENT_INITIATED',
        toState: 'CLOSED',
        triggeredBy: { userId: FINANCE, role: 'finance' },
        reason: 'PAY-123',
      },
    ]);
    // reasonField wins over notes; notes are still kept.
    expect(transitions[4].notes).toBe('Paid by bank transfer');
    for (const entry of transitions) {
      expect(new Date(entry.timestamp).toISOString()).toBe(entry.timestamp);
      expect(entry.reason.trim()).not.toBe('');
    }
  });
});

describe('rejection path', () => {
  async function rejectFromAssessment() {
    const env = setup();
    const claim = await env.seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });
    env.clock.advance({ hours: 1 });
    const { claim: rejected } = await env.engine.transition(claim.id, ASSESSOR, {
      to: 'REJECTED',
      payload: { assessmentReport: 'Not covered by policy', rejectionReason: 'Pre-existing condition' },
    });
    expect(rejected).toMatchObject({ status: 'REJECTED', stateEnteredAt: at(1) });
    return { ...env, claim };
  }

  const rejectionNotice = (id: string) =>
    `[NOTIFY → m-1] Claim ${id} has been rejected: Pre-existing condition. ` +
    `To appeal, contact our claims office with claim ID ${id} before the appeal period ends.`;

  it('case 2: reject, member acknowledges, close_rejected closes the claim before the appeal period ends', async () => {
    const { engine, store, clock, claim, lines } = await rejectFromAssessment();

    clock.advance({ days: 2 });
    await engine.acknowledge(claim.id, CLERK, 'Member accepted the decision');
    clock.advance({ hours: 1 });
    const { claim: closed } = await engine.transition(claim.id, SYSTEM, { to: 'CLOSED' });

    const ackAt = '2026-03-03T01:00:00.000Z';
    const closeAt = '2026-03-03T02:00:00.000Z';
    const audit = await store.listAuditByClaim(claim.id);
    expect(
      audit.slice(1).map((e) => [e.seq, e.type, e.transitionId ?? null, e.fromState, e.toState, e.triggeredBy.userId, e.reason, e.timestamp]),
    ).toEqual([
      [2, 'TRANSITION', 'reject', 'UNDER_ASSESSMENT', 'REJECTED', ASSESSOR, 'Pre-existing condition', at(1)],
      [3, 'SIDE_EFFECT', 'reject', 'UNDER_ASSESSMENT', 'REJECTED', ASSESSOR, 'Side effect notify succeeded', at(1)],
      [4, 'MEMBER_ACKNOWLEDGED', null, 'REJECTED', 'REJECTED', CLERK, 'Member accepted the decision', ackAt],
      [5, 'TRANSITION', 'close_rejected', 'REJECTED', 'CLOSED', SYSTEM, 'Rejected claim closed and archived', closeAt],
      [6, 'SIDE_EFFECT', 'close_rejected', 'REJECTED', 'CLOSED', SYSTEM, 'Side effect setField succeeded', closeAt],
      [7, 'SIDE_EFFECT', 'close_rejected', 'REJECTED', 'CLOSED', SYSTEM, 'Side effect notify succeeded', closeAt],
    ]);

    expect(closed).toMatchObject({
      status: 'CLOSED',
      version: 4,
      data: {
        rejectionReason: 'Pre-existing condition',
        memberAcknowledged: true,
        memberAcknowledgedAt: ackAt,
        archivedAt: closeAt,
      },
    });
    expect(lines).toEqual([
      rejectionNotice(claim.id),
      `[SET_FIELD] ${claim.id}.archivedAt = "${closeAt}"`,
      `[NOTIFY → m-1] Claim ${claim.id} has been closed and archived`,
    ]);
  });

  it('case 3: reject, then runSystemTasks closes the claim once the appeal period since rejection ends', async () => {
    const { engine, store, clock, claim, lines } = await rejectFromAssessment();

    // 30 days after creation, but 1 hour short of 30 days after rejection.
    clock.advance({ days: 30, hours: -1 });
    const early = await engine.runSystemTasks(SYSTEM);
    expect(early.processed).toEqual([]);
    expect(early.skipped).toEqual([
      expect.objectContaining({
        claimId: claim.id,
        reason: 'preconditions_not_met',
        message: 'Only 29 of 30 days elapsed since stateEnteredAt; memberAcknowledged must be true',
      }),
    ]);

    clock.advance({ hours: 1 });
    const due = await engine.runSystemTasks(SYSTEM);
    expect(due).toEqual({
      processed: [{ claimId: claim.id, transitionId: 'close_rejected', from: 'REJECTED', to: 'CLOSED', version: 3 }],
      skipped: [],
    });

    const closeAt = '2026-03-31T01:00:00.000Z';
    const audit = await store.listAuditByClaim(claim.id);
    expect(
      audit.slice(1).map((e) => [e.seq, e.type, e.transitionId, e.triggeredBy.userId, e.reason, e.timestamp]),
    ).toEqual([
      [2, 'TRANSITION', 'reject', ASSESSOR, 'Pre-existing condition', at(1)],
      [3, 'SIDE_EFFECT', 'reject', ASSESSOR, 'Side effect notify succeeded', at(1)],
      [4, 'TRANSITION', 'close_rejected', SYSTEM, 'Rejected claim closed and archived', closeAt],
      [5, 'SIDE_EFFECT', 'close_rejected', SYSTEM, 'Side effect setField succeeded', closeAt],
      [6, 'SIDE_EFFECT', 'close_rejected', SYSTEM, 'Side effect notify succeeded', closeAt],
    ]);
    expect(await store.getClaim(claim.id)).toMatchObject({ status: 'CLOSED', data: { archivedAt: closeAt } });
    expect(await store.getClaim(claim.id)).not.toHaveProperty('data.memberAcknowledged');
    expect(lines).toEqual([
      rejectionNotice(claim.id),
      `[SET_FIELD] ${claim.id}.archivedAt = "${closeAt}"`,
      `[NOTIFY → m-1] Claim ${claim.id} has been closed and archived`,
    ]);
  });
});

describe('request info loop', () => {
  it('case 4: one request_info round, then approve through to CLOSED', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });

    await engine.transition(claim.id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: 'Discharge summary' } });
    await engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: 'Summary attached' } });
    await engine.transition(claim.id, LEAD, { to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
    await engine.transition(claim.id, ASSESSOR, { to: 'APPROVED', payload: { assessmentReport: 'Covered after review' } });
    await engine.transition(claim.id, FINANCE, { to: 'PAYMENT_INITIATED' });
    const { claim: closed } = await engine.transition(claim.id, FINANCE, {
      to: 'CLOSED',
      payload: { paymentReference: 'PAY-9' },
    });

    const audit = await store.listAuditByClaim(claim.id);
    expect(audit.filter((e) => e.type === 'TRANSITION').map((e) => [e.transitionId, e.fromState, e.toState])).toEqual([
      ['request_info', 'UNDER_ASSESSMENT', 'PENDING_INFO'],
      ['info_received', 'PENDING_INFO', 'DOCUMENTS_VERIFIED'],
      ['start_assessment', 'DOCUMENTS_VERIFIED', 'UNDER_ASSESSMENT'],
      ['approve', 'UNDER_ASSESSMENT', 'APPROVED'],
      ['initiate_payment', 'APPROVED', 'PAYMENT_INITIATED'],
      ['confirm_payment', 'PAYMENT_INITIATED', 'CLOSED'],
    ]);
    expect(audit[1].reason).toBe('Discharge summary');
    expect(audit.filter((e) => e.type === 'SIDE_EFFECT').every((e) => e.data?.status === 'ok')).toBe(true);
    expect(audit.filter((e) => e.type === 'TRANSITION_REJECTED')).toEqual([]);
    expect(audit.map((e) => e.seq)).toEqual(audit.map((_, i) => i + 1));

    expect(closed).toMatchObject({
      status: 'CLOSED',
      version: 7,
      data: {
        missingInfoDescription: 'Discharge summary',
        infoResponse: 'Summary attached',
        assessmentStartedAt: T0,
        paymentRequest: { id: 'pr-1' },
        paymentReference: 'PAY-9',
      },
    });
  });
});

describe('audit immutability through the engine', () => {
  const expectFrozen = (entry: AuditEntry) => {
    expect(Object.isFrozen(entry)).toBe(true);
    expect(Object.isFrozen(entry.triggeredBy)).toBe(true);
    if (entry.data) expect(Object.isFrozen(entry.data)).toBe(true);
    expect(() => {
      (entry as { reason: string }).reason = 'tampered';
    }).toThrow(TypeError);
    expect(() => {
      delete (entry as { reason?: string }).reason;
    }).toThrow(TypeError);
  };

  it('case 21: result.audit from transition and acknowledge is frozen; editing the returned array changes nothing stored', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');

    const rejected = await engine.transition(claim.id, ASSESSOR, {
      to: 'REJECTED',
      payload: { assessmentReport: 'r', rejectionReason: 'Not covered' },
      notes: 'note',
    });
    expect(rejected.audit).toHaveLength(2);
    rejected.audit.forEach(expectFrozen);
    expect(() => {
      (rejected.audit[0].data as { rejectionReason?: unknown }).rejectionReason = 'tampered';
    }).toThrow(TypeError);

    const acknowledged = await engine.acknowledge(claim.id, CLERK, 'Called in');
    expectFrozen(acknowledged.audit);

    const stored = await store.listAuditByClaim(claim.id);
    rejected.audit.pop();
    rejected.audit.push({ ...rejected.audit[0], seq: 99 });
    expect(await store.listAuditByClaim(claim.id)).toEqual(stored);
    expect(stored.map((e) => e.type)).toEqual(['CLAIM_CREATED', 'TRANSITION', 'SIDE_EFFECT', 'MEMBER_ACKNOWLEDGED']);
  });
});
