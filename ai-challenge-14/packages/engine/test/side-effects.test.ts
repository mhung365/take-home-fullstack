import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../src/config';
import type { Claim } from '../src/model';
import {
  createBuiltinSideEffects,
  defaultSideEffects,
  renderTemplate,
  templateVariables,
  type SideEffectContext,
} from '../src/side-effects';

const configDir = resolve(__dirname, '../../../config');
const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));
const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });

const NOW = new Date('2026-03-05T10:00:00.000Z');

function context(data: Record<string, unknown> = {}, overrides: Partial<Claim> = {}): SideEffectContext {
  const claim: Claim = {
    id: 'c-7',
    memberId: 'm-1',
    status: 'APPROVED',
    stateEnteredAt: NOW.toISOString(),
    amount: 1500,
    policyLimit: 10000,
    createdAt: '2026-03-01T00:00:00.000Z',
    createdBy: 'u-clerk-1',
    version: 3,
    data,
    ...overrides,
  };
  const { data: _data, ...core } = claim;
  return {
    claim,
    view: { ...claim.data, ...core },
    transition: { id: 'approve', from: 'UNDER_ASSESSMENT', to: 'APPROVED' },
    triggeredBy: { userId: 'u-assessor-1', role: 'assessor' },
    settings: config.workflow.settings,
    users: config.users.users,
    now: NOW,
  };
}

function setup() {
  const lines: string[] = [];
  let next = 0;
  const registry = createBuiltinSideEffects({ log: (line) => lines.push(line), paymentRequestId: () => `pr-${++next}` });
  const run = async (name: string, params: Record<string, unknown>, ctx: SideEffectContext) => {
    const handler = registry.get(name)!;
    return handler.run(handler.params.parse(params), ctx);
  };
  return { registry, lines, run };
}

describe('templates', () => {
  it('lists variables, including dot paths and padded names, once each', () => {
    expect(templateVariables('Claim {{id}} for {{ amount }}: {{paymentRequest.id}} / {{id}}')).toEqual([
      'id',
      'amount',
      'paymentRequest.id',
    ]);
  });

  it('renders strings as is, other values as JSON, and missing values as empty', () => {
    const view = { id: 'c-1', amount: 1500, ok: true, zero: 0, docs: ['a', 'b'], pr: { id: 'pr-1' }, none: null };
    expect(renderTemplate('{{id}} {{amount}} {{ok}} {{zero}} {{docs}} {{pr.id}} [{{none}}] [{{missing}}]', view)).toEqual({
      text: 'c-1 1500 true 0 ["a","b"] pr-1 [] []',
      missing: ['none', 'missing'],
    });
  });

  it('reports each variable that rendered empty once, including empty strings and missing dot paths', () => {
    const view = { id: 'c-1', blank: '', pr: {} };
    expect(renderTemplate('{{blank}} {{pr.id}} {{id}} {{blank}}', view)).toEqual({ text: '  c-1 ', missing: ['blank', 'pr.id'] });
  });
});

describe('notify', () => {
  it('sends to the member, renders core and data fields, and logs the line', async () => {
    const { run, lines } = setup();
    const outcome = await run(
      'notify',
      { to: 'member', template: 'Claim {{id}} rejected: {{rejectionReason}}' },
      context({ rejectionReason: 'Not covered' }),
    );

    expect(outcome).toEqual({
      result: { to: 'member', recipients: ['m-1'], message: 'Claim c-7 rejected: Not covered' },
    });
    expect(lines).toEqual(['[NOTIFY → m-1] Claim c-7 rejected: Not covered']);
  });

  it('still sends when a variable has no value, and records missingVariables in the result', async () => {
    const { run, lines } = setup();
    const outcome = await run(
      'notify',
      { to: 'member', template: 'Claim {{id}} rejected: {{rejectionReason}}. Ref {{paymentReference}}' },
      context({ rejectionReason: '' }),
    );

    expect(outcome.result).toEqual({
      to: 'member',
      recipients: ['m-1'],
      message: 'Claim c-7 rejected: . Ref ',
      missingVariables: ['rejectionReason', 'paymentReference'],
    });
    expect(lines).toEqual(['[NOTIFY → m-1] Claim c-7 rejected: . Ref ']);
  });

  it('role:<role> sends to every user with that role', async () => {
    const { run, lines } = setup();
    const outcome = await run('notify', { to: 'role:assessor', template: 'Claim {{id}} ready' }, context());

    expect(outcome.result).toMatchObject({ recipients: ['u-assessor-1', 'u-assessor-2'] });
    expect(lines).toEqual(['[NOTIFY → u-assessor-1, u-assessor-2] Claim c-7 ready']);
  });

  it('user:<field> sends to the user id stored in that field', async () => {
    const { run } = setup();
    const outcome = await run('notify', { to: 'user:assessorId', template: 'Assigned {{id}}' }, context({ assessorId: 'u-assessor-2' }));
    expect(outcome.result).toMatchObject({ recipients: ['u-assessor-2'] });
  });

  it('fails when there is nobody to send to', async () => {
    const { run, lines } = setup();
    await expect(run('notify', { to: 'user:assessorId', template: 'x' }, context())).rejects.toThrow(
      'Notify recipient field assessorId is empty',
    );
    await expect(run('notify', { to: 'user:assessorId', template: 'x' }, context({ assessorId: 'u-x' }))).rejects.toThrow(
      'Notify recipient field assessorId holds unknown user u-x',
    );
    await expect(run('notify', { to: 'role:team_lead', template: 'x' }, { ...context(), users: [] })).rejects.toThrow(
      'No users with role team_lead',
    );
    expect(lines).toEqual([]);
  });

  it('rejects malformed params', () => {
    const { registry } = setup();
    const params = registry.get('notify')!.params;
    expect(params.safeParse({ to: 'everyone', template: 'x' }).success).toBe(false);
    expect(params.safeParse({ to: 'role:', template: 'x' }).success).toBe(false);
    expect(params.safeParse({ to: 'member' }).success).toBe(false);
    expect(params.safeParse({ to: 'member', template: 'x', cc: 'y' }).success).toBe(false);
  });
});

describe('setField', () => {
  it('writes a fixed value, null, or the clock time for $now', async () => {
    const { run, lines } = setup();
    expect(await run('setField', { field: 'archivedAt', value: '$now' }, context())).toEqual({
      result: { field: 'archivedAt', value: NOW.toISOString() },
      dataPatch: { archivedAt: NOW.toISOString() },
    });
    expect(await run('setField', { field: 'assessmentStartedAt', value: null }, context())).toMatchObject({
      dataPatch: { assessmentStartedAt: null },
    });
    expect(await run('setField', { field: 'tags', value: ['a', 1] }, context())).toMatchObject({
      dataPatch: { tags: ['a', 1] },
    });
    expect(lines[0]).toBe('[SET_FIELD] c-7.archivedAt = "2026-03-05T10:00:00.000Z"');
  });

  it('requires both field and value (null counts as a value)', () => {
    const params = setup().registry.get('setField')!.params;
    expect(params.safeParse({ field: 'x' }).success).toBe(false);
    expect(params.safeParse({ value: 1 }).success).toBe(false);
    expect(params.safeParse({ field: 'x', value: null }).success).toBe(true);
  });
});

describe('payment handlers', () => {
  it('createPaymentRequest stores { id, amount, createdAt } and reports the id', async () => {
    const { run, lines } = setup();
    expect(await run('createPaymentRequest', {}, context())).toEqual({
      result: { paymentRequestId: 'pr-1', amount: 1500 },
      dataPatch: { paymentRequest: { id: 'pr-1', amount: 1500, createdAt: NOW.toISOString() } },
    });
    expect(lines).toEqual(['[PAYMENT] Created payment request pr-1 for claim c-7 (amount 1500)']);
  });

  it('default registry logs to console and generates unique payment request ids', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const handler = defaultSideEffects.get('createPaymentRequest')!;
      const ids = new Set<string>();
      for (let i = 0; i < 5; i++) {
        const outcome = await handler.run({}, context());
        ids.add((outcome.dataPatch?.paymentRequest as { id: string }).id);
      }
      expect(ids.size).toBe(5);
      expect(log).toHaveBeenCalledTimes(5);
    } finally {
      log.mockRestore();
    }
  });

  it('triggerPaymentSystem records paymentInitiatedAt for the existing payment request', async () => {
    const { run, lines } = setup();
    const ctx = context({ paymentRequest: { id: 'pr-9', amount: 1500 } });
    expect(await run('triggerPaymentSystem', {}, ctx)).toEqual({
      result: { paymentRequestId: 'pr-9', initiatedAt: NOW.toISOString() },
      dataPatch: { paymentInitiatedAt: NOW.toISOString() },
    });
    expect(lines).toEqual(['[PAYMENT] Triggered payment system for payment request pr-9 (claim c-7)']);
  });

  it('triggerPaymentSystem fails without a payment request', async () => {
    const { run } = setup();
    await expect(run('triggerPaymentSystem', {}, context())).rejects.toThrow('Claim c-7 has no payment request');
  });

  it('payment handlers take no params', () => {
    const { registry } = setup();
    expect(registry.get('createPaymentRequest')!.params.safeParse({ amount: 1 }).success).toBe(false);
    expect(registry.get('triggerPaymentSystem')!.params.safeParse({}).success).toBe(true);
  });
});

describe('default registry', () => {
  it('has the four handlers of DESIGN 4.5', () => {
    expect([...defaultSideEffects.keys()]).toEqual(['notify', 'setField', 'createPaymentRequest', 'triggerPaymentSystem']);
  });
});
