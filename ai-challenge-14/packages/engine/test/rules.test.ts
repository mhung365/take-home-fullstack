import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { loadConfig, type Condition } from '../src/config';
import { evaluatePreconditions, type EvaluationContext } from '../src/rules';

const configDir = resolve(__dirname, '../../../config');
const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));

const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });

function transitionOf(transitionId: string) {
  const t = config.workflow.transitions.find((t) => t.id === transitionId);
  if (!t) throw new Error(`Unknown transition ${transitionId}`);
  return t;
}

function pre(transitionId: string): Condition {
  const { preconditions } = transitionOf(transitionId);
  if (!preconditions) throw new Error(`Transition ${transitionId} has no preconditions`);
  return preconditions;
}

const NOW = new Date('2026-03-31T00:00:00.000Z');
const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];

function ctx(overrides: Partial<EvaluationContext> = {}): EvaluationContext {
  return {
    view: {},
    payload: {},
    inputs: [],
    settings: config.workflow.settings,
    findUser: (id) => config.users.users.find((u) => u.id === id),
    now: NOW,
    ...overrides,
  };
}

const rule = (r: Record<string, unknown>) => r as Condition;

describe('precondition evaluation: combinators', () => {
  it('passes with no tree when a transition has no preconditions', () => {
    expect(evaluatePreconditions(undefined, ctx())).toEqual({ passed: true, failures: [], tree: null });
  });

  it('all: reports every failing rule, not just the first', () => {
    const result = evaluatePreconditions(pre('approve'), ctx({ view: { amount: 12000, policyLimit: 10000 } }));

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { rule: 'notEmpty', field: 'assessmentReport', path: 'all[0]', message: 'assessmentReport is required' },
      { rule: 'lte', field: 'amount', path: 'all[1]', message: 'amount 12000 exceeds policyLimit 10000' },
    ]);
  });

  it('all: passes when every rule passes', () => {
    const result = evaluatePreconditions(
      pre('approve'),
      ctx({ view: { amount: 10000, policyLimit: 10000, assessmentReport: 'Looks fine' } }),
    );

    expect(result).toMatchObject({ passed: true, failures: [] });
  });

  it('any: passes when one branch passes, and still evaluates every branch for the tree', () => {
    const result = evaluatePreconditions(
      pre('close_rejected'),
      ctx({ view: { stateEnteredAt: '2026-03-25T00:00:00.000Z', memberAcknowledged: true } }),
    );

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.tree).toMatchObject({
      kind: 'any',
      path: '',
      passed: true,
      children: [
        { kind: 'rule', rule: 'daysElapsed', path: 'any[0]', passed: false },
        { kind: 'rule', rule: 'eq', path: 'any[1]', passed: true },
      ],
    });
  });

  it('any: reports the failure of each branch when none passes', () => {
    const result = evaluatePreconditions(
      pre('close_rejected'),
      ctx({ view: { stateEnteredAt: '2026-03-19T00:00:00.000Z' } }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { rule: 'daysElapsed', field: 'stateEnteredAt', path: 'any[0]', message: 'Only 12 of 30 days elapsed since stateEnteredAt' },
      { rule: 'eq', field: 'memberAcknowledged', path: 'any[1]', message: 'memberAcknowledged must be true' },
    ]);
  });

  it('nested any inside all: failure paths point at the exact rule', () => {
    const result = evaluatePreconditions(pre('info_received'), ctx({ view: { documents: ['claim_form'] } }));

    expect(result.failures.map((f) => f.path)).toEqual(['all[0].any[0]', 'all[0].any[1]', 'all[1]']);
  });

  it('not: fails when the inner condition holds, using the inner pass message', () => {
    const condition = rule({ not: { rule: 'eq', field: 'memberAcknowledged', value: true } });

    expect(evaluatePreconditions(condition, ctx({ view: { memberAcknowledged: true } })).failures).toEqual([
      { rule: 'eq', field: 'memberAcknowledged', path: 'not', message: 'Condition must not hold: memberAcknowledged is true' },
    ]);
    expect(evaluatePreconditions(condition, ctx({ view: { memberAcknowledged: false } })).passed).toBe(true);
  });

  it('a single rule at the root has an empty path', () => {
    const result = evaluatePreconditions(pre('request_info'), ctx());

    expect(result.failures).toEqual([
      {
        rule: 'providedInRequest',
        field: 'missingInfoDescription',
        path: '',
        message: 'missingInfoDescription must be provided in this request',
      },
    ]);
  });

  it('custom message on a rule replaces the default message', () => {
    const result = evaluatePreconditions(pre('initiate_payment'), ctx({ view: {} }));

    expect(result.failures).toEqual([
      { rule: 'notEmpty', field: 'paymentRequest.id', path: '', message: 'Payment request has not been created' },
    ]);
  });

  it('throws on a rule that is not registered (config validation should have caught it)', () => {
    expect(() => evaluatePreconditions(rule({ rule: 'containsAny', field: 'documents' }), ctx())).toThrow(
      'Unknown rule containsAny',
    );
  });
});

describe('precondition rules', () => {
  describe('notEmpty', () => {
    const condition = rule({ rule: 'notEmpty', field: 'assessmentReport' });
    const passes = (value: unknown) => evaluatePreconditions(condition, ctx({ view: { assessmentReport: value } })).passed;

    it.each([undefined, null, '', '   ', [], {}])('treats %j as empty', (value) => {
      expect(passes(value)).toBe(false);
    });

    it.each(['Report', 0, false, ['x'], { id: 'p-1' }])('treats %j as present', (value) => {
      expect(passes(value)).toBe(true);
    });

    it('reads dot paths and fails when an intermediate object is missing', () => {
      const condition = rule({ rule: 'notEmpty', field: 'paymentRequest.id' });

      expect(evaluatePreconditions(condition, ctx({ view: { paymentRequest: { id: 'pr-1' } } })).passed).toBe(true);
      expect(evaluatePreconditions(condition, ctx({ view: { paymentRequest: null } })).failures[0].message).toBe(
        'paymentRequest.id is required',
      );
    });
  });

  describe('providedInRequest', () => {
    const condition = pre('confirm_payment');

    it('passes when the field is in this request payload', () => {
      expect(evaluatePreconditions(condition, ctx({ payload: { paymentReference: 'PAY-1' } })).passed).toBe(true);
    });

    it('fails when the value only exists on the claim from an earlier request', () => {
      const result = evaluatePreconditions(
        condition,
        ctx({ view: { paymentReference: 'PAY-OLD' }, payload: {} }),
      );

      expect(result.failures[0].message).toBe('paymentReference must be provided in this request');
    });

    it.each([null, '', '  ', [], {}])('treats %j in the payload as not provided', (value) => {
      expect(evaluatePreconditions(condition, ctx({ payload: { paymentReference: value } })).passed).toBe(false);
    });

    it('defaults to execute mode when mode is omitted: no requiresInput, even with inputs', () => {
      const result = evaluatePreconditions(condition, ctx({ inputs: ['paymentReference'] }));

      expect(result.tree).not.toHaveProperty('requiresInput');
    });
  });

  describe('containsAll', () => {
    const condition = pre('verify_documents');

    it('passes when the array contains every value from $settings', () => {
      expect(evaluatePreconditions(condition, ctx({ view: { documents: [...ALL_DOCS, 'extra'] } })).passed).toBe(true);
    });

    it('lists the missing values in order', () => {
      const result = evaluatePreconditions(condition, ctx({ view: { documents: ['claim_form'] } }));

      expect(result.failures[0].message).toBe('Missing required documents: invoice, id_proof');
    });

    it('accepts literal values instead of a ref', () => {
      const literal = rule({ rule: 'containsAll', field: 'documents', values: ['invoice'] });

      expect(evaluatePreconditions(literal, ctx({ view: { documents: ['invoice'] } })).passed).toBe(true);
    });

    it('fails with a type message when the field is not an array', () => {
      const result = evaluatePreconditions(condition, ctx({ view: { documents: 'claim_form' } }));

      expect(result.failures[0].message).toBe('documents must be an array, got string');
    });

    it('treats a missing field as an empty list', () => {
      const result = evaluatePreconditions(condition, ctx({ view: {} }));

      expect(result.failures[0].message).toBe('Missing required documents: claim_form, invoice, id_proof');
    });
  });

  describe('lte', () => {
    const condition = rule({ rule: 'lte', field: 'amount', ref: 'policyLimit' });

    it('passes on equality', () => {
      expect(evaluatePreconditions(condition, ctx({ view: { amount: 10000, policyLimit: 10000 } })).passed).toBe(true);
    });

    it('fails with both values in the message', () => {
      const result = evaluatePreconditions(condition, ctx({ view: { amount: 12000, policyLimit: 10000 } }));

      expect(result.failures[0].message).toBe('amount 12000 exceeds policyLimit 10000');
    });

    it('fails with a type message when either side is not a number', () => {
      expect(
        evaluatePreconditions(condition, ctx({ view: { amount: '12000', policyLimit: 10000 } })).failures[0].message,
      ).toBe('amount must be a number, got string');
      expect(evaluatePreconditions(condition, ctx({ view: { amount: 12000 } })).failures[0].message).toBe(
        'policyLimit must be a number, got undefined',
      );
    });
  });

  describe('eq', () => {
    const condition = rule({ rule: 'eq', field: 'memberAcknowledged', value: true });

    it('uses strict equality', () => {
      expect(evaluatePreconditions(condition, ctx({ view: { memberAcknowledged: true } })).passed).toBe(true);
      expect(evaluatePreconditions(condition, ctx({ view: { memberAcknowledged: 'true' } })).passed).toBe(false);
      expect(evaluatePreconditions(condition, ctx({ view: {} })).failures[0].message).toBe(
        'memberAcknowledged must be true',
      );
    });
  });

  describe('daysElapsed', () => {
    const condition = rule({ rule: 'daysElapsed', field: 'stateEnteredAt', days: '$settings.appealPeriodDays' });
    const evalAt = (stateEnteredAt: unknown) => evaluatePreconditions(condition, ctx({ view: { stateEnteredAt } }));

    it('passes once exactly N full days have elapsed', () => {
      expect(evalAt('2026-03-01T00:00:00.000Z').passed).toBe(true);
    });

    it('counts only full days', () => {
      expect(evalAt('2026-03-01T00:00:01.000Z').failures[0].message).toBe(
        'Only 29 of 30 days elapsed since stateEnteredAt',
      );
    });

    it('accepts a literal number of days', () => {
      const literal = rule({ rule: 'daysElapsed', field: 'stateEnteredAt', days: 10 });

      expect(evaluatePreconditions(literal, ctx({ view: { stateEnteredAt: '2026-03-19T00:00:00.000Z' } })).passed).toBe(
        true,
      );
    });

    it('uses ctx.now rather than the wall clock', () => {
      const later = ctx({ view: { stateEnteredAt: '2026-03-19T00:00:00.000Z' }, now: new Date('2026-04-30T00:00:00Z') });

      expect(evaluatePreconditions(condition, later).passed).toBe(true);
    });

    it('fails with a type message on a missing or invalid date', () => {
      expect(evalAt(undefined).failures[0].message).toBe('stateEnteredAt must be a valid date, got undefined');
      expect(evalAt('not-a-date').failures[0].message).toBe('stateEnteredAt must be a valid date, got "not-a-date"');
    });
  });

  describe('userHasRole', () => {
    const condition = pre('start_assessment');
    const evalWith = (assessorId: unknown) => evaluatePreconditions(condition, ctx({ view: { assessorId } }));

    it('passes when the user has the role', () => {
      expect(evalWith('u-assessor-2').passed).toBe(true);
    });

    it('fails when the user has another role', () => {
      expect(evalWith('u-finance-1').failures[0].message).toBe('assessorId u-finance-1 has role finance, expected assessor');
    });

    it('fails when the user does not exist or the field is empty', () => {
      expect(evalWith('u-ghost').failures[0].message).toBe('assessorId u-ghost is not a known user');
      expect(evalWith(undefined).failures[0].message).toBe('assessorId is required');
    });
  });
});

describe('preview mode', () => {
  it('providedInRequest passes with requiresInput so the UI can mark the field as required', () => {
    const result = preview('reject', { assessmentReport: 'Not covered' });

    expect(result).toEqual({
      passed: true,
      failures: [],
      tree: {
        kind: 'all',
        path: '',
        passed: true,
        children: [
          {
            kind: 'rule',
            rule: 'notEmpty',
            field: 'assessmentReport',
            path: 'all[0]',
            passed: true,
            message: 'assessmentReport is present',
          },
          {
            kind: 'rule',
            rule: 'providedInRequest',
            field: 'rejectionReason',
            path: 'all[1]',
            passed: true,
            requiresInput: true,
            message: 'rejectionReason must be provided in this request',
          },
        ],
      },
    });
  });

  it('an unsatisfied rule on an input field passes with requiresInput (reject with no report yet)', () => {
    const result = preview('reject', {});

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.tree).toMatchObject({
      children: [
        { rule: 'notEmpty', field: 'assessmentReport', passed: true, requiresInput: true, message: 'assessmentReport is required' },
        { rule: 'providedInRequest', field: 'rejectionReason', passed: true, requiresInput: true },
      ],
    });
  });

  it('a satisfied rule on an input field passes without requiresInput', () => {
    const result = preview('start_assessment', { assessorId: 'u-assessor-1' });

    expect(result.passed).toBe(true);
    expect(result.tree).not.toHaveProperty('requiresInput');
  });

  it('keeps the failure message on requiresInput so the UI can show what is missing', () => {
    const result = preview('verify_documents', { documents: ['claim_form'] });

    expect(result.passed).toBe(true);
    expect(result.tree).toMatchObject({
      passed: true,
      requiresInput: true,
      message: 'Missing required documents: invoice, id_proof',
    });
  });

  it('core fields are still evaluated normally (approve over the policy limit stays locked)', () => {
    const result = preview('approve', { amount: 12000, policyLimit: 10000 });

    expect(result.passed).toBe(false);
    expect(result.failures).toEqual([
      { rule: 'lte', field: 'amount', path: 'all[1]', message: 'amount 12000 exceeds policyLimit 10000' },
    ]);
    expect(result.tree).toMatchObject({ children: [{ rule: 'notEmpty', requiresInput: true }, {}] });
  });

  it('data fields that are not inputs of the transition are still evaluated normally', () => {
    const result = preview('initiate_payment', {});

    expect(result.passed).toBe(false);
    expect(result.failures[0].message).toBe('Payment request has not been created');
  });

  it('marks every providedInRequest branch of an any as requiresInput', () => {
    const result = preview('info_received', { documents: ALL_DOCS });

    expect(result.passed).toBe(true);
    expect(result.tree).toMatchObject({
      children: [
        {
          kind: 'any',
          children: [
            { rule: 'providedInRequest', field: 'infoResponse', requiresInput: true },
            { rule: 'providedInRequest', field: 'documents', requiresInput: true },
          ],
        },
        { rule: 'containsAll', passed: true },
      ],
    });
  });

  it('ignores inputs in execute mode', () => {
    const result = evaluatePreconditions(
      pre('reject'),
      ctx({ mode: 'execute', inputs: transitionOf('reject').inputs, view: {} }),
    );

    expect(result.passed).toBe(false);
    expect(result.failures.map((f) => f.field)).toEqual(['assessmentReport', 'rejectionReason']);
  });
});

function preview(transitionId: string, view: Record<string, unknown>) {
  return evaluatePreconditions(
    pre(transitionId),
    ctx({ mode: 'preview', inputs: transitionOf(transitionId).inputs, view }),
  );
}
