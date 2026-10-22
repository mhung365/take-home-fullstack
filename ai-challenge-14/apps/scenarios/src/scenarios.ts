import type { AuditEntry, AuditType, Claim } from '@claims/engine';
import type { ScenarioContext } from './context';

const CLERK = 'u-clerk-1';
const LEAD = 'u-lead-1';
const ASSESSOR = 'u-assessor-1';
const ASSESSOR_2 = 'u-assessor-2';
const FINANCE = 'u-finance-1';
const SYSTEM = 'u-system';

const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];
const CYCLE_MESSAGE = 'Maximum information requests exceeded — escalate to team lead';

export interface Scenario {
  id: string;
  title: string;
  summary: string;
  run(ctx: ScenarioContext): Promise<void>;
  /** Runs on the claim and audit read back from the database after run. */
  verify(ctx: ScenarioContext, claim: Claim, audit: AuditEntry[]): void;
}

const count = (audit: AuditEntry[], type: AuditType, transitionId?: string) =>
  audit.filter((e) => e.type === type && (transitionId === undefined || e.transitionId === transitionId)).length;

const types = (audit: AuditEntry[]) => audit.map((e) => e.type).join(', ');

function expectStatus(ctx: ScenarioContext, claim: Claim, status: string): void {
  ctx.check(`Claim status in DB is ${status}`, claim.status === status, `status ${claim.status}, version ${claim.version}`);
}

function expectAllSideEffectsOk(ctx: ScenarioContext, audit: AuditEntry[]): void {
  const failed = audit.filter((e) => e.type === 'SIDE_EFFECT' && e.data?.status !== 'ok');
  ctx.check('Every SIDE_EFFECT entry has status ok', failed.length === 0, `${failed.length} failed`);
}

function expectRejectionAudited(ctx: ScenarioContext, audit: AuditEntry[], code: string, times = 1): void {
  const found = audit.filter((e) => e.type === 'TRANSITION_REJECTED' && e.data?.code === code).length;
  ctx.check(`Audit has ${times} TRANSITION_REJECTED with code ${code}`, found === times, `found ${found}`);
}

async function toUnderAssessment(ctx: ScenarioContext, input: { amount?: number; policyLimit?: number } = {}) {
  await ctx.createClaim(CLERK, { memberId: 'm-1001', amount: 1500, policyLimit: 10000, documents: ALL_DOCS, ...input });
  await ctx.transition({ userId: CLERK, to: 'DOCUMENTS_VERIFIED', notes: 'Originals checked at the counter' });
  await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
}

async function approveAndPay(ctx: ScenarioContext, paymentReference: string) {
  await ctx.transition({
    userId: ASSESSOR,
    to: 'APPROVED',
    payload: { assessmentReport: 'Treatment and invoice match the policy coverage' },
  });
  await ctx.transition({ userId: FINANCE, to: 'PAYMENT_INITIATED' });
  await ctx.transition({ userId: FINANCE, to: 'CLOSED', payload: { paymentReference } });
}

export const SCENARIOS: Scenario[] = [
  {
    id: '1',
    title: 'Happy path',
    summary: 'SUBMITTED → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT → APPROVED → PAYMENT_INITIATED → CLOSED',
    async run(ctx) {
      await toUnderAssessment(ctx);
      await approveAndPay(ctx, 'PAY-2026-0001');
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'CLOSED');
      ctx.check(
        'Audit has 13 entries: 1 CLAIM_CREATED, 5 TRANSITION, 7 SIDE_EFFECT',
        audit.length === 13 &&
          count(audit, 'CLAIM_CREATED') === 1 &&
          count(audit, 'TRANSITION') === 5 &&
          count(audit, 'SIDE_EFFECT') === 7,
        types(audit),
      );
      expectAllSideEffectsOk(ctx, audit);
      const paymentRequest = claim.data.paymentRequest as { id?: string } | undefined;
      ctx.check('createPaymentRequest stored paymentRequest.id', typeof paymentRequest?.id === 'string', paymentRequest?.id);
      ctx.check('paymentReference stored on the claim', claim.data.paymentReference === 'PAY-2026-0001');
    },
  },
  {
    id: '2',
    title: 'Rejection path',
    summary:
      'SUBMITTED → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT → REJECTED → CLOSED. The system job closes the claim once the ' +
      '30-day appeal period has elapsed, measured on the fake clock (stateEnteredAt is never edited).',
    async run(ctx) {
      await toUnderAssessment(ctx);
      await ctx.transition({
        userId: ASSESSOR,
        to: 'REJECTED',
        payload: {
          assessmentReport: 'Procedure is cosmetic',
          rejectionReason: 'Cosmetic procedures are excluded under policy section 4.2',
        },
      });
      ctx.advanceClock(29);
      await ctx.runSystemTasks(SYSTEM, { skipped: 'preconditions_not_met' });
      ctx.advanceClock(1);
      await ctx.runSystemTasks(SYSTEM, { processed: 'CLOSED' });
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'CLOSED');
      const rejected = audit.find((e) => e.type === 'TRANSITION' && e.transitionId === 'reject');
      ctx.check(
        'reject entry uses rejectionReason as reason',
        rejected?.reason === 'Cosmetic procedures are excluded under policy section 4.2',
        rejected?.reason,
      );
      const closed = audit.find((e) => e.type === 'TRANSITION' && e.transitionId === 'close_rejected');
      ctx.check(
        'close_rejected triggered by u-system (system)',
        closed?.triggeredBy.userId === SYSTEM && closed.triggeredBy.role === 'system',
      );
      ctx.check(
        'Closed 30 days after entering REJECTED',
        rejected !== undefined &&
          closed !== undefined &&
          Date.parse(closed.timestamp) - Date.parse(rejected.timestamp) >= 30 * 24 * 60 * 60 * 1000,
        `${rejected?.timestamp} → ${closed?.timestamp}`,
      );
      ctx.check(
        'Skipped system run left no audit entry',
        count(audit, 'TRANSITION_REJECTED') === 0,
        `${count(audit, 'TRANSITION_REJECTED')} TRANSITION_REJECTED`,
      );
      ctx.check('archivedAt set by setField', typeof claim.data.archivedAt === 'string', String(claim.data.archivedAt));
      expectAllSideEffectsOk(ctx, audit);
    },
  },
  {
    id: '3',
    title: 'Request more info loop',
    summary:
      'SUBMITTED → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT → PENDING_INFO → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT → ' +
      'APPROVED → PAYMENT_INITIATED → CLOSED',
    async run(ctx) {
      await toUnderAssessment(ctx);
      await ctx.transition({
        userId: ASSESSOR,
        to: 'PENDING_INFO',
        payload: { missingInfoDescription: 'Please send the itemised hospital bill' },
      });
      await ctx.transition({
        userId: CLERK,
        to: 'DOCUMENTS_VERIFIED',
        payload: { infoResponse: 'Itemised bill received by email', documents: [...ALL_DOCS, 'itemised_bill'] },
      });
      // The assessor assigned in the first round is kept, so no assessorId this time.
      await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT' });
      await approveAndPay(ctx, 'PAY-2026-0003');
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'CLOSED');
      ctx.check('8 TRANSITION entries', count(audit, 'TRANSITION') === 8, `${count(audit, 'TRANSITION')}`);
      ctx.check('request_info used once', count(audit, 'TRANSITION', 'request_info') === 1);
      ctx.check(
        'documents replaced by the info_received payload',
        JSON.stringify(claim.data.documents) === JSON.stringify([...ALL_DOCS, 'itemised_bill']),
        JSON.stringify(claim.data.documents),
      );
      const resets = audit.filter(
        (e) => e.type === 'SIDE_EFFECT' && e.transitionId === 'info_received' && e.data?.name === 'setField',
      );
      ctx.check('info_received reset the assessment timer (setField assessmentStartedAt = null)', resets.length === 1);
      expectAllSideEffectsOk(ctx, audit);
    },
  },
  {
    id: '4',
    title: 'Invalid transition',
    summary: 'SUBMITTED → APPROVED is rejected with a message listing the transitions allowed from SUBMITTED.',
    async run(ctx) {
      await ctx.createClaim(CLERK, { memberId: 'm-1004', amount: 800, policyLimit: 10000, documents: ALL_DOCS });
      await ctx.transition(
        { userId: ASSESSOR, to: 'APPROVED', payload: { assessmentReport: 'Looks fine' } },
        {
          code: 'INVALID_TRANSITION',
          message: 'Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)',
        },
      );
      await ctx.transition(
        { userId: CLERK, to: 'PAID' },
        { code: 'INVALID_TRANSITION', message: 'Unknown state PAID. Known states: SUBMITTED, DOCUMENTS_VERIFIED' },
      );
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'SUBMITTED');
      ctx.check('Claim version unchanged (1)', claim.version === 1, `version ${claim.version}`);
      expectRejectionAudited(ctx, audit, 'INVALID_TRANSITION', 2);
      ctx.check('No TRANSITION entry', count(audit, 'TRANSITION') === 0);
    },
  },
  {
    id: '5',
    title: 'Unauthorized role',
    summary:
      'An assessor tries the clerk-only verify_documents and a clerk tries the team-lead-only start_assessment; ' +
      'both are rejected, and the right role then succeeds.',
    async run(ctx) {
      await ctx.createClaim(CLERK, { memberId: 'm-1005', amount: 2300, policyLimit: 10000, documents: ALL_DOCS });
      await ctx.transition(
        { userId: ASSESSOR, to: 'DOCUMENTS_VERIFIED' },
        {
          code: 'UNAUTHORIZED_ROLE',
          message: 'Transition verify_documents requires role document_clerk; user u-assessor-1 has role assessor',
        },
      );
      await ctx.transition({ userId: CLERK, to: 'DOCUMENTS_VERIFIED' });
      await ctx.transition(
        { userId: CLERK, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } },
        {
          code: 'UNAUTHORIZED_ROLE',
          message: 'Transition start_assessment requires role team_lead; user u-clerk-1 has role document_clerk',
        },
      );
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'DOCUMENTS_VERIFIED');
      ctx.check('Only the clerk transition changed the claim (version 2)', claim.version === 2, `version ${claim.version}`);
      expectRejectionAudited(ctx, audit, 'UNAUTHORIZED_ROLE', 2);
      const rejected = audit.filter((e) => e.type === 'TRANSITION_REJECTED');
      ctx.check(
        'Rejected entries record who tried and with which role',
        rejected[0]?.triggeredBy.role === 'assessor' && rejected[1]?.triggeredBy.role === 'document_clerk',
        rejected.map((e) => `${e.triggeredBy.userId} (${e.triggeredBy.role})`).join(', '),
      );
    },
  },
  {
    id: '6',
    title: 'Precondition failures',
    summary:
      'Documents missing at verification, then an approval for an amount above the policy limit. Both are rejected ' +
      'with the failing rule spelled out, and neither changes the claim.',
    async run(ctx) {
      await ctx.createClaim(CLERK, { memberId: 'm-1006', amount: 12000, policyLimit: 10000, documents: ['claim_form'] });
      await ctx.transition(
        { userId: CLERK, to: 'DOCUMENTS_VERIFIED' },
        { code: 'PRECONDITION_FAILED', message: 'Missing required documents: invoice, id_proof' },
      );
      await ctx.transition({ userId: CLERK, to: 'DOCUMENTS_VERIFIED', payload: { documents: ALL_DOCS } });
      await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
      await ctx.transition(
        { userId: ASSESSOR, to: 'APPROVED', payload: { assessmentReport: 'Treatment is covered' } },
        { code: 'PRECONDITION_FAILED', message: 'amount 12000 exceeds policyLimit 10000' },
      );
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'UNDER_ASSESSMENT');
      expectRejectionAudited(ctx, audit, 'PRECONDITION_FAILED', 2);
      ctx.check('No payment request was created', claim.data.paymentRequest === undefined);
      ctx.check(
        'Rejected approve did not store its assessmentReport',
        claim.data.assessmentReport === undefined,
        JSON.stringify(claim.data.assessmentReport),
      );
    },
  },
  {
    id: '7',
    title: 'Cycle limit exceeded',
    summary:
      'Three full UNDER_ASSESSMENT → PENDING_INFO → DOCUMENTS_VERIFIED → UNDER_ASSESSMENT loops succeed; the 4th ' +
      'request_info is rejected.',
    async run(ctx) {
      await toUnderAssessment(ctx);
      for (let round = 1; round <= 3; round++) {
        await ctx.transition({
          userId: ASSESSOR,
          to: 'PENDING_INFO',
          payload: { missingInfoDescription: `Round ${round}: please send the discharge summary` },
        });
        await ctx.transition({
          userId: CLERK,
          to: 'DOCUMENTS_VERIFIED',
          payload: { infoResponse: `Round ${round}: discharge summary received` },
        });
        await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT' });
      }
      const fourth = await ctx.transition(
        {
          userId: ASSESSOR,
          to: 'PENDING_INFO',
          payload: { missingInfoDescription: 'Round 4: please send the specialist referral' },
        },
        { code: 'CYCLE_LIMIT_EXCEEDED', message: CYCLE_MESSAGE },
      );
      ctx.check(
        'Message is exactly the configured one',
        !fourth.ok && fourth.message === CYCLE_MESSAGE,
        fourth.ok ? 'succeeded' : fourth.message,
      );
    },
    verify(ctx, claim, audit) {
      expectStatus(ctx, claim, 'UNDER_ASSESSMENT');
      ctx.check(
        'request_info succeeded exactly 3 times',
        count(audit, 'TRANSITION', 'request_info') === 3,
        `${count(audit, 'TRANSITION', 'request_info')}`,
      );
      expectRejectionAudited(ctx, audit, 'CYCLE_LIMIT_EXCEEDED');
    },
  },
  {
    id: '8',
    title: 'Concurrent requests on the same claim',
    summary:
      'Two assessors approve and reject the same claim at the same moment. Both requests are started before either ' +
      'is awaited, each on its own connection; the row lock (SELECT … FOR UPDATE) serializes them, so the second one ' +
      're-reads the claim after the first commits and is rejected against the new state.',
    async run(ctx) {
      await toUnderAssessment(ctx);
      const [approve, reject] = await ctx.concurrently(
        [
          { userId: ASSESSOR, to: 'APPROVED', payload: { assessmentReport: 'Covered' } },
          {
            userId: ASSESSOR_2,
            to: 'REJECTED',
            payload: { assessmentReport: 'Not covered', rejectionReason: 'Pre-existing condition' },
          },
        ],
        'INVALID_TRANSITION',
      );
      const loser = [approve, reject].find((o) => !o.ok);
      const winnerState = approve.ok ? 'APPROVED' : 'REJECTED';
      ctx.check(
        'Loser was evaluated against the winner\'s committed state',
        loser !== undefined && !loser.ok && loser.message.startsWith(`Cannot transition ${winnerState} →`),
        loser && !loser.ok ? loser.message : undefined,
      );
    },
    verify(ctx, claim, audit) {
      const fromAssessment = audit.filter((e) => e.type === 'TRANSITION' && e.fromState === 'UNDER_ASSESSMENT');
      ctx.check('Exactly 1 TRANSITION out of UNDER_ASSESSMENT', fromAssessment.length === 1, `${fromAssessment.length}`);
      const winner = fromAssessment[0];
      if (winner) expectStatus(ctx, claim, winner.toState!);
      expectRejectionAudited(ctx, audit, 'INVALID_TRANSITION');
      const sideEffects = audit.filter((e) => e.type === 'SIDE_EFFECT' && e.fromState === 'UNDER_ASSESSMENT');
      ctx.check(
        'Only the winner\'s side effects ran',
        sideEffects.length > 0 && sideEffects.every((e) => e.transitionId === winner?.transitionId),
        sideEffects.map((e) => `${e.transitionId}:${String(e.data?.name)}`).join(', '),
      );
      ctx.check(
        'paymentRequest exists only if approve won',
        (claim.data.paymentRequest !== undefined) === (winner?.transitionId === 'approve'),
      );
    },
  },
];
