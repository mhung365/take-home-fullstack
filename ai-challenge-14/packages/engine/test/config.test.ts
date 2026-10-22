import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ConfigValidationError, loadConfig, validateConfig, type ConfigIssue } from '../src/config';
import { defaultSideEffects } from '../src/side-effects';

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
      // The rejection notice template reads rejectionReason, which no input provides anymore.
      {
        source: 'workflow',
        path: 'transitions[3].sideEffects[0].params.template',
        message:
          'Template variable {{rejectionReason}} is not a core field, an input, or a field written by an action or side effect',
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
      // confirm_payment loses its input: reasonField, providedInRequest and the notify template all fail
      expect(err.errors).toHaveLength(6);
      expect(err.message).toContain('Invalid workflow config (6 errors)');
      expect(err.message).toContain('[users] users[0].role');
    }
  });

  it('rejects rules that are not registered', () => {
    const raw = realConfig();
    transition(raw.workflow, 'approve').preconditions.all[0].rule = 'isFilled';

    expect(errorsOf(raw)).toEqual([
      {
        source: 'workflow',
        path: 'transitions[2].preconditions.all[0].rule',
        message:
          'Unknown rule isFilled. Known rules: notEmpty, providedInRequest, containsAll, lte, eq, daysElapsed, userHasRole',
      },
    ]);
  });

  it('rejects rule params that do not match the rule schema', () => {
    const raw = realConfig();
    delete transition(raw.workflow, 'approve').preconditions.all[0].field;
    delete transition(raw.workflow, 'verify_documents').preconditions.ref;
    transition(raw.workflow, 'info_received').preconditions.all[1].values = ['invoice'];

    const errors = errorsOf(raw);

    expect(errors.map((e) => e.path)).toEqual(
      expect.arrayContaining([
        'transitions[0].preconditions',
        'transitions[2].preconditions.all[0].field',
        'transitions[5].preconditions.all[1]',
      ]),
    );
    expect(errors.filter((e) => e.message.includes('exactly one of values or ref'))).toHaveLength(2);
  });

  it('rejects $settings references to unknown keys', () => {
    const raw = realConfig();
    transition(raw.workflow, 'verify_documents').preconditions.ref = '$settings.requiredDocs';

    expect(errorsOf(raw)).toEqual([
      {
        source: 'workflow',
        path: 'transitions[0].preconditions.ref',
        message: 'Unknown setting $settings.requiredDocs. Known settings: requiredDocuments, appealPeriodDays',
      },
    ]);
  });

  it('rejects userHasRole with an unknown role', () => {
    const raw = realConfig();
    transition(raw.workflow, 'start_assessment').preconditions.role = 'assesor';

    expect(errorsOf(raw)).toEqual([
      expect.objectContaining({
        path: 'transitions[1].preconditions.role',
        message: expect.stringContaining('Rule userHasRole uses unknown role assesor'),
      }),
    ]);
  });

  describe('side effects', () => {
    const sideEffect = (wf: any, id: string, index: number) => transition(wf, id).sideEffects[index];

    it('rejects side effects that are not registered', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'approve', 1).name = 'createPayment';

      expect(errorsOf(raw)).toEqual([
        {
          source: 'workflow',
          path: 'transitions[2].sideEffects[1].name',
          message:
            'Unknown side effect createPayment. Known side effects: notify, setField, createPaymentRequest, triggerPaymentSystem',
        },
      ]);
    });

    it('rejects params that do not match the handler schema, with paths into params', () => {
      const raw = realConfig();
      delete sideEffect(raw.workflow, 'verify_documents', 0).params.template;
      sideEffect(raw.workflow, 'approve', 0).params.to = 'everyone';
      sideEffect(raw.workflow, 'start_assessment', 0).params.typo = 1;
      sideEffect(raw.workflow, 'approve', 1).params = { amount: 1 };
      delete sideEffect(raw.workflow, 'info_received', 0).params.value;

      expect(errorsOf(raw).map((e) => e.path)).toEqual([
        'transitions[0].sideEffects[0].params.template',
        'transitions[1].sideEffects[0].params',
        'transitions[2].sideEffects[0].params.to',
        'transitions[2].sideEffects[1].params',
        'transitions[5].sideEffects[0].params.value',
      ]);
    });

    it('rejects template variables that are not core fields, inputs or side effect outputs', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'approve', 0).params.template = 'Claim {{id}} approved for {{amout}} ({{ payment.id }})';

      expect(errorsOf(raw)).toEqual([
        {
          source: 'workflow',
          path: 'transitions[2].sideEffects[0].params.template',
          message: 'Template variable {{amout}} is not a core field, an input, or a field written by an action or side effect',
        },
        {
          source: 'workflow',
          path: 'transitions[2].sideEffects[0].params.template',
          message:
            'Template variable {{payment.id}} is not a core field, an input, or a field written by an action or side effect',
        },
      ]);
    });

    it('accepts template variables from any transition input, createClaim inputs, side effect and acknowledge outputs', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'verify_documents', 0).params.template =
        '{{id}} {{status}} {{documents}} {{rejectionReason}} {{paymentRequest.id}} {{paymentInitiatedAt}} ' +
        '{{archivedAt}} {{memberAcknowledgedAt}} {{memberAcknowledgedBy}}';

      expect(validateConfig(raw)).toMatchObject({ ok: true });
    });

    it('checks notify recipients: role must exist, user field must be known', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'verify_documents', 0).params.to = 'role:asessor';
      sideEffect(raw.workflow, 'start_assessment', 1).params.to = 'user:assessor';

      expect(errorsOf(raw)).toEqual([
        {
          source: 'workflow',
          path: 'transitions[0].sideEffects[0].params.to',
          message: 'Notify recipient role:asessor uses unknown role asessor. Known roles: document_clerk, team_lead, assessor, finance, system',
        },
        {
          source: 'workflow',
          path: 'transitions[1].sideEffects[1].params.to',
          message:
            'Notify recipient user:assessor reads assessor, which is not a core field, an input, or a field written by an action or side effect',
        },
      ]);
    });

    it('rejects setField on a core field and $-values other than $now', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'start_assessment', 0).params.field = 'status';
      sideEffect(raw.workflow, 'close_rejected', 0).params.value = '$today';

      expect(errorsOf(raw)).toEqual([
        {
          source: 'workflow',
          path: 'transitions[1].sideEffects[0].params.field',
          message: expect.stringContaining('Side effect setField field status collides with core claim field'),
        },
        {
          source: 'workflow',
          path: 'transitions[8].sideEffects[0].params.value',
          message: 'Unknown special value $today; the only one supported is $now',
        },
      ]);
    });

    it('a field written by setField in one transition can be used in templates elsewhere', () => {
      const raw = realConfig();
      sideEffect(raw.workflow, 'close_rejected', 0).params.field = 'closedAt';
      sideEffect(raw.workflow, 'verify_documents', 0).params.template = 'Closed at {{closedAt}}';

      expect(validateConfig(raw)).toMatchObject({ ok: true });
    });

    it('reports every side effect error together with other config errors', () => {
      const raw = realConfig();
      raw.workflow.initialState = 'NEW';
      sideEffect(raw.workflow, 'approve', 1).name = 'pay';
      sideEffect(raw.workflow, 'reject', 0).params.template = '{{reason}}';
      sideEffect(raw.workflow, 'info_received', 0).params.field = 'amount';

      expect(errorsOf(raw)).toHaveLength(4);
    });

    it('uses the registry passed in options', () => {
      const raw = realConfig();
      transition(raw.workflow, 'approve').sideEffects.push({ name: 'audit_log', params: { level: 'info' } });

      expect(errorsOf(raw)[0].message).toContain('Unknown side effect audit_log');

      const sideEffects = new Map(defaultSideEffects);
      sideEffects.set('audit_log', {
        name: 'audit_log',
        params: z.strictObject({ level: z.enum(['info', 'warn']) }),
        run: () => ({}),
      });
      expect(validateConfig(raw, { sideEffects })).toMatchObject({ ok: true });
    });
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
