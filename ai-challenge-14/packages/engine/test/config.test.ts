import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigValidationError, loadConfig, validateConfig, type ConfigIssue } from '../src/config';

const configDir = resolve(__dirname, '../../../config');
const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));

// Fresh deep copies so each test can mutate freely.
function realConfig(): { workflow: any; users: any } {
  return { workflow: readJson('claims-workflow.json'), users: readJson('users.json') };
}

function errorsOf(raw: { workflow: unknown; users: unknown }): ConfigIssue[] {
  const result = validateConfig(raw);
  if (result.ok) throw new Error('Expected config to be rejected');
  return result.errors;
}

const transition = (wf: any, id: string) => wf.transitions.find((t: any) => t.id === id);

describe('config loader', () => {
  it('loads the real config without errors or warnings', () => {
    const config = loadConfig(realConfig());

    expect(config.workflow.initialState).toBe('SUBMITTED');
    expect(config.workflow.states).toHaveLength(8);
    expect(config.workflow.transitions.map((t) => t.id)).toEqual([
      'verify_documents',
      'start_assessment',
      'approve',
      'reject',
      'request_info',
      'info_received',
      'initiate_payment',
      'confirm_payment',
      'close_rejected',
    ]);
    expect(transition(config.workflow, 'request_info').cycleLimit).toEqual({
      max: 3,
      message: 'Maximum information requests exceeded — escalate to team lead',
    });
    expect(config.users.users.map((u) => u.id)).toEqual([
      'u-clerk-1',
      'u-lead-1',
      'u-assessor-1',
      'u-assessor-2',
      'u-finance-1',
      'u-system',
    ]);
    expect(config.warnings).toEqual([]);
  });

  it('rejects references to unknown states', () => {
    const raw = realConfig();
    raw.workflow.initialState = 'NEW';
    transition(raw.workflow, 'approve').to = 'APPROVEDD';
    transition(raw.workflow, 'reject').from = 'ASSESSING';
    raw.workflow.actions.acknowledge.allowedStates = ['DENIED'];

    const errors = errorsOf(raw);

    expect(errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: 'initialState', message: expect.stringContaining('unknown state NEW') }),
        expect.objectContaining({ path: 'transitions[2].to', message: expect.stringContaining('unknown state APPROVEDD') }),
        expect.objectContaining({ path: 'transitions[3].from', message: expect.stringContaining('unknown state ASSESSING') }),
        expect.objectContaining({
          path: 'actions.acknowledge.allowedStates[0]',
          message: expect.stringContaining('unknown state DENIED'),
        }),
      ]),
    );
    expect(errors[0].message).toContain('Known states: SUBMITTED, DOCUMENTS_VERIFIED');
  });

  it('rejects unknown roles in transitions, actions and users.json', () => {
    const raw = realConfig();
    transition(raw.workflow, 'approve').roles = ['assessor', 'manager'];
    raw.workflow.actions.createClaim.roles = ['member'];
    raw.users.users[0].role = 'clerk';

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({
        source: 'workflow',
        path: 'actions.createClaim.roles[0]',
        message: expect.stringContaining('unknown role member'),
      }),
      expect.objectContaining({
        source: 'workflow',
        path: 'transitions[2].roles[1]',
        message: expect.stringContaining('Transition approve uses unknown role manager'),
      }),
      expect.objectContaining({
        source: 'users',
        path: 'users[0].role',
        message: expect.stringContaining('User u-clerk-1 has unknown role clerk'),
      }),
    ]);
  });

  it('rejects reasonField that is not in inputs', () => {
    const raw = realConfig();
    transition(raw.workflow, 'reject').inputs = ['assessmentReport'];
    transition(raw.workflow, 'reject').preconditions = { rule: 'notEmpty', field: 'assessmentReport' };

    expect(errorsOf(raw)).toEqual([
      {
        source: 'workflow',
        path: 'transitions[3].reasonField',
        message: 'Transition reject reasonField rejectionReason is not in inputs (assessmentReport)',
      },
    ]);
  });

  it('rejects duplicate from → to pairs', () => {
    const raw = realConfig();
    raw.workflow.transitions.push({
      ...transition(raw.workflow, 'approve'),
      id: 'fast_approve',
    });

    expect(errorsOf(raw)).toEqual([
      {
        source: 'workflow',
        path: 'transitions[9]',
        message: 'Transition fast_approve duplicates UNDER_ASSESSMENT → APPROVED already defined by transition approve',
      },
    ]);
  });

  it('rejects duplicate transition ids', () => {
    const raw = realConfig();
    transition(raw.workflow, 'reject').id = 'approve';

    expect(errorsOf(raw)).toContainEqual(
      expect.objectContaining({ path: 'transitions[3].id', message: 'Duplicate transition id approve (also at transitions[2])' }),
    );
  });

  it('rejects transitions leaving a terminal state', () => {
    const raw = realConfig();
    raw.workflow.transitions.push({
      id: 'reopen',
      from: 'CLOSED',
      to: 'SUBMITTED',
      description: 'Reopen claim',
      roles: ['team_lead'],
    });

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({ path: 'transitions[9].from', message: 'Transition reopen leaves terminal state CLOSED' }),
    ]);
  });

  it('rejects inputs that collide with core claim fields', () => {
    const raw = realConfig();
    transition(raw.workflow, 'approve').inputs.push('amount');
    raw.workflow.actions.createClaim.inputs.push('status');

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({ path: 'actions.createClaim.inputs[1]', message: expect.stringContaining('input status collides') }),
      expect.objectContaining({ path: 'transitions[2].inputs[1]', message: expect.stringContaining('input amount collides') }),
    ]);
  });

  it('rejects providedInRequest on a field missing from inputs, including nested rules', () => {
    const raw = realConfig();
    transition(raw.workflow, 'info_received').inputs = ['infoResponse'];

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({
        path: 'transitions[5].preconditions.all[0].any[1].field',
        message: 'Transition info_received requires documents to be provided in request, but it is not in inputs (infoResponse)',
      }),
    ]);
  });

  it('rejects duplicate user ids', () => {
    const raw = realConfig();
    raw.users.users[1].id = 'u-clerk-1';

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({ source: 'users', path: 'users[1].id', message: 'Duplicate user id u-clerk-1 (also at users[0])' }),
    ]);
  });

  it('reports Zod schema errors with paths, including inside precondition trees', () => {
    const raw = realConfig();
    delete transition(raw.workflow, 'approve').description;
    transition(raw.workflow, 'request_info').cycleLimit.max = 0;
    transition(raw.workflow, 'approve').preconditions.all[1] = { field: 'amount' };
    raw.workflow.transitions[0].typo = true;
    raw.users.users[2] = { id: 'u-assessor-1', role: 'assessor' };

    const paths = errorsOf(raw).map((e) => `${e.source}:${e.path}`);

    expect(paths).toEqual(
      expect.arrayContaining([
        'workflow:transitions[0]',
        'workflow:transitions[2].description',
        'workflow:transitions[2].preconditions.all[1].rule',
        'workflow:transitions[4].cycleLimit.max',
        'users:users[2].name',
      ]),
    );
  });

  it('collects every error in one pass and throws them all from loadConfig', () => {
    const raw = realConfig();
    raw.workflow.initialState = 'NEW';
    transition(raw.workflow, 'approve').roles = ['manager'];
    transition(raw.workflow, 'confirm_payment').inputs = [];
    raw.users.users[0].role = 'clerk';

    expect(() => loadConfig(raw)).toThrow(ConfigValidationError);
    try {
      loadConfig(raw);
    } catch (e) {
      const err = e as ConfigValidationError;
      // confirm_payment loses its input: reasonField + providedInRequest both fail
      expect(err.errors).toHaveLength(5);
      expect(err.message).toContain('Invalid workflow config (5 errors)');
      expect(err.message).toContain('[users] users[0].role');
    }
  });

  it('warns about states unreachable from initialState without failing', () => {
    const raw = realConfig();
    raw.workflow.states.push({ id: 'ARCHIVED', description: 'Never reached' });

    const result = validateConfig(raw);

    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([
      { source: 'workflow', path: 'states[8]', message: 'State ARCHIVED is not reachable from SUBMITTED' },
    ]);
  });
});
