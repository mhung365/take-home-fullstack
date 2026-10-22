import { describe, expect, it } from 'vitest';
import { ASSESSOR, CLERK, FINANCE, LEAD, SYSTEM, rejection, setup } from './helpers';

describe('WorkflowEngine.getAvailableTransitions', () => {
  it('lists every outgoing transition with roles, inputs and per-rule preview results', async () => {
    const { engine, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');

    const result = await engine.getAvailableTransitions(claim.id, ASSESSOR);

    expect(result).toMatchObject({ claimId: claim.id, status: 'UNDER_ASSESSMENT', version: 1 });
    expect(result.transitions.map((t) => [t.transitionId, t.to, t.enabled])).toEqual([
      ['approve', 'APPROVED', true],
      ['reject', 'REJECTED', true],
      ['request_info', 'PENDING_INFO', true],
    ]);

    const [approve, , requestInfo] = result.transitions;
    expect(approve).toMatchObject({
      description: 'Assessor approved the claim for payment',
      roles: ['assessor'],
      inputs: ['assessmentReport'],
      allowedForCurrentUser: true,
      preconditions: {
        passed: true,
        rules: [
          {
            rule: 'notEmpty',
            field: 'assessmentReport',
            path: 'all[0]',
            passed: true,
            requiresInput: true,
            message: 'assessmentReport is required',
          },
          expect.objectContaining({ rule: 'lte', field: 'amount', path: 'all[1]', passed: true }),
        ],
        tree: expect.objectContaining({ kind: 'all', passed: true }),
      },
    });
    expect(approve.preconditions.rules[1]).not.toHaveProperty('requiresInput');
    expect(approve).not.toHaveProperty('cycleLimit');

    expect(requestInfo.preconditions.rules).toEqual([
      expect.objectContaining({ rule: 'providedInRequest', passed: true, requiresInput: true }),
    ]);
    expect(requestInfo.cycleLimit).toEqual({ max: 3, used: 0, remaining: 3 });
  });

  it('a failing rule on a field outside inputs blocks the transition', async () => {
    const { engine, seed } = setup();
    const overLimit = await seed('UNDER_ASSESSMENT', { amount: 12000 });
    const noPayment = await seed('APPROVED');

    const [approve] = (await engine.getAvailableTransitions(overLimit.id, ASSESSOR)).transitions;
    expect(approve.enabled).toBe(false);
    expect(approve.preconditions.passed).toBe(false);
    expect(approve.preconditions.rules[1]).toEqual({
      rule: 'lte',
      field: 'amount',
      path: 'all[1]',
      passed: false,
      message: 'amount 12000 exceeds policyLimit 10000',
    });

    const [initiate] = (await engine.getAvailableTransitions(noPayment.id, FINANCE)).transitions;
    expect(initiate).toMatchObject({
      transitionId: 'initiate_payment',
      enabled: false,
      preconditions: { passed: false, rules: [{ passed: false, message: 'Payment request has not been created' }] },
    });
  });

  it('allowedForCurrentUser follows the role; false without a user', async () => {
    const { engine, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');

    for (const userId of [CLERK, undefined]) {
      const { transitions } = await engine.getAvailableTransitions(claim.id, userId);
      expect(transitions.every((t) => !t.allowedForCurrentUser && !t.enabled)).toBe(true);
      expect(transitions[0].preconditions.passed).toBe(true);
    }
  });

  it('close_rejected opens after acknowledge or once the appeal period ends', async () => {
    const { engine, clock, seed } = setup();
    const acknowledged = await seed('REJECTED');
    const waiting = await seed('REJECTED');

    const before = (await engine.getAvailableTransitions(waiting.id, SYSTEM)).transitions[0];
    expect(before).toMatchObject({ transitionId: 'close_rejected', enabled: false });
    expect(before.preconditions.rules.map((r) => r.message)).toEqual([
      'Only 0 of 30 days elapsed since stateEnteredAt',
      'memberAcknowledged must be true',
    ]);

    await engine.acknowledge(acknowledged.id, CLERK);
    const afterAck = await engine.getAvailableTransitions(acknowledged.id, SYSTEM);
    expect(afterAck.version).toBe(2);
    expect(afterAck.transitions[0].enabled).toBe(true);

    clock.advance({ days: 30 });
    expect((await engine.getAvailableTransitions(waiting.id, SYSTEM)).transitions[0].enabled).toBe(true);
  });

  it('counts successful transitions against cycleLimit and disables at the max', async () => {
    const { engine, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT', { data: { documents: ['claim_form', 'invoice', 'id_proof'], assessorId: ASSESSOR } });

    for (let round = 1; round <= 3; round++) {
      await rejection(engine.transition(claim.id, ASSESSOR, { to: 'PENDING_INFO' }), 'PRECONDITION_FAILED');
      await engine.transition(claim.id, ASSESSOR, { to: 'PENDING_INFO', payload: { missingInfoDescription: `r${round}` } });
      await engine.transition(claim.id, CLERK, { to: 'DOCUMENTS_VERIFIED', payload: { infoResponse: `a${round}` } });
      await engine.transition(claim.id, LEAD, { to: 'UNDER_ASSESSMENT' });

      const requestInfo = (await engine.getAvailableTransitions(claim.id, ASSESSOR)).transitions[2];
      expect(requestInfo.cycleLimit).toEqual({ max: 3, used: round, remaining: 3 - round });
      expect(requestInfo.enabled).toBe(round < 3);
    }
  });

  it('a terminal state has no transitions', async () => {
    const { engine, seed } = setup();
    const claim = await seed('CLOSED');
    expect(await engine.getAvailableTransitions(claim.id, SYSTEM)).toEqual({
      claimId: claim.id,
      status: 'CLOSED',
      version: 1,
      transitions: [],
    });
  });

  it('reads only: no audit, no version change', async () => {
    const { engine, store, seed } = setup();
    const claim = await seed('UNDER_ASSESSMENT');
    await engine.getAvailableTransitions(claim.id, ASSESSOR);
    expect(await store.getClaim(claim.id)).toEqual(claim);
    expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
  });

  it('CLAIM_NOT_FOUND and UNKNOWN_USER', async () => {
    const { engine, seed } = setup();
    const claim = await seed();
    await rejection(engine.getAvailableTransitions('c-missing', CLERK), 'CLAIM_NOT_FOUND');
    await rejection(engine.getAvailableTransitions(claim.id, 'u-x'), 'UNKNOWN_USER');
  });
});
