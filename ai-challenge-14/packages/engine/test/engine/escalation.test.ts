import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig } from '../../src/config';
import { ALL_DOCS, ASSESSOR, CLERK, LEAD, SYSTEM, readJson, rejection, setup } from './helpers';

const examplePath = resolve(__dirname, '../../../../examples/with-escalation.json');
const readExample = () => JSON.parse(readFileSync(examplePath, 'utf8'));
const config = loadConfig({ workflow: readExample(), users: readJson('users.json') });

const NEW_TRANSITIONS = ['escalate', 'return_to_assessment', 'reject_escalated'];

function escalationSetup() {
  const env = setup({ config });
  const assessed = () => env.seed('UNDER_ASSESSMENT', { data: { documents: ALL_DOCS, assessorId: ASSESSOR } });
  const escalate = (claimId: string, escalationReason = 'Possible duplicate claim') =>
    env.engine.transition(claimId, ASSESSOR, { to: 'ESCALATED', payload: { escalationReason } });
  return { ...env, assessed, escalate };
}

describe('examples/with-escalation.json (case 25)', () => {
  it('case 25: is the main config plus one state and three transitions, and loads without warnings', () => {
    const example = readExample();
    expect(example.states.filter((s: { id: string }) => s.id === 'ESCALATED')).toHaveLength(1);
    expect(example.transitions.slice(-3).map((t: { id: string }) => t.id)).toEqual(NEW_TRANSITIONS);

    example.states = example.states.filter((s: { id: string }) => s.id !== 'ESCALATED');
    example.transitions = example.transitions.filter((t: { id: string }) => !NEW_TRANSITIONS.includes(t.id));
    expect(example).toEqual(readJson('claims-workflow.json'));

    expect(config.warnings).toEqual([]);
    expect(config.workflow.states.map((s) => s.id)).toContain('ESCALATED');
  });

  it('case 25: UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED, escalationReason stored in data', async () => {
    const { engine, store, clock, lines, assessed, escalate } = escalationSetup();
    const claim = await assessed();

    const escalated = await escalate(claim.id);
    expect(escalated.claim).toMatchObject({ status: 'ESCALATED', data: { escalationReason: 'Possible duplicate claim' } });
    expect(escalated.audit[0]).toMatchObject({ transitionId: 'escalate', reason: 'Possible duplicate claim' });

    const options = await engine.getAvailableTransitions(claim.id, LEAD);
    expect(options.transitions.map((t) => [t.transitionId, t.to, t.enabled])).toEqual([
      ['return_to_assessment', 'UNDER_ASSESSMENT', true],
      ['reject_escalated', 'REJECTED', true],
    ]);

    await engine.transition(claim.id, LEAD, { to: 'REJECTED', payload: { rejectionReason: 'Duplicate of an approved claim' } });
    await engine.acknowledge(claim.id, CLERK);
    clock.advance({ hours: 1 });
    const { claim: closed } = await engine.transition(claim.id, SYSTEM, { to: 'CLOSED' });
    expect(closed.status).toBe('CLOSED');

    const audit = await store.listAuditByClaim(claim.id);
    expect(audit.filter((e) => e.type === 'TRANSITION').map((e) => [e.transitionId, e.fromState, e.toState, e.reason])).toEqual([
      ['escalate', 'UNDER_ASSESSMENT', 'ESCALATED', 'Possible duplicate claim'],
      ['reject_escalated', 'ESCALATED', 'REJECTED', 'Duplicate of an approved claim'],
      ['close_rejected', 'REJECTED', 'CLOSED', 'Rejected claim closed and archived'],
    ]);
    expect(audit.filter((e) => e.type === 'SIDE_EFFECT').every((e) => e.data?.status === 'ok')).toBe(true);
    expect(lines.slice(0, 2)).toEqual([
      `[NOTIFY → u-lead-1] Claim ${claim.id} has been escalated for review: Possible duplicate claim`,
      `[NOTIFY → m-1] Claim ${claim.id} has been rejected: Duplicate of an approved claim. ` +
        `To appeal, contact our claims office with claim ID ${claim.id} before the appeal period ends.`,
    ]);
  });

  it('case 25: the second return_to_assessment is CYCLE_LIMIT_EXCEEDED and audited', async () => {
    const { engine, store, clock, lines, assessed, escalate } = escalationSetup();
    const claim = await assessed();

    await escalate(claim.id);
    clock.advance({ hours: 1 });
    const returned = await engine.transition(claim.id, LEAD, {
      to: 'UNDER_ASSESSMENT',
      payload: { assessorId: 'u-assessor-2' },
    });
    expect(returned.claim).toMatchObject({
      status: 'UNDER_ASSESSMENT',
      data: { assessorId: 'u-assessor-2', assessmentStartedAt: '2026-03-01T01:00:00.000Z' },
    });
    expect(lines).toContain(`[NOTIFY → u-assessor-2] Claim ${claim.id} has been returned to you for assessment`);

    await engine.transition(claim.id, 'u-assessor-2', { to: 'ESCALATED', payload: { escalationReason: 'Still unclear' } });
    const [returnAgain] = (await engine.getAvailableTransitions(claim.id, LEAD)).transitions;
    expect(returnAgain).toMatchObject({ cycleLimit: { max: 1, used: 1, remaining: 0 }, enabled: false });

    const before = await store.getClaim(claim.id);
    const error = await rejection(
      engine.transition(claim.id, LEAD, { to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } }),
      'CYCLE_LIMIT_EXCEEDED',
    );
    expect(error.message).toBe('Claim has already been returned to assessment once — team lead must decide');
    expect(await store.getClaim(claim.id)).toEqual(before);

    const audit = await store.listAuditByClaim(claim.id);
    expect(audit.at(-1)).toMatchObject({
      type: 'TRANSITION_REJECTED',
      transitionId: 'return_to_assessment',
      fromState: 'ESCALATED',
      toState: 'UNDER_ASSESSMENT',
      reason: error.message,
      data: { code: 'CYCLE_LIMIT_EXCEEDED' },
    });

    const { claim: rejected } = await engine.transition(claim.id, LEAD, {
      to: 'REJECTED',
      payload: { rejectionReason: 'Could not be verified' },
    });
    expect(rejected.status).toBe('REJECTED');
  });
});
