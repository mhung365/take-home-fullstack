import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FakeClock } from '../../src/clock';
import { loadConfig, type LoadedConfig } from '../../src/config';
import { WorkflowEngine } from '../../src/engine';
import { WorkflowError, isWorkflowError, type ErrorCode } from '../../src/errors';
import type { Claim, NewClaim } from '../../src/model';
import type { RuleRegistry } from '../../src/rules';
import { createBuiltinSideEffects } from '../../src/side-effects';
import { InMemoryWorkflowStore } from '../../src/store';

const configDir = resolve(__dirname, '../../../../config');
export const readJson = (file: string) => JSON.parse(readFileSync(resolve(configDir, file), 'utf8'));
export const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });

export const T0 = '2026-03-01T00:00:00.000Z';
export const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];

export const CLERK = 'u-clerk-1';
export const LEAD = 'u-lead-1';
export const ASSESSOR = 'u-assessor-1';
export const FINANCE = 'u-finance-1';
export const SYSTEM = 'u-system';

export interface SetupOptions {
  /** Defaults to the real config. */
  config?: LoadedConfig;
  lockTimeoutMs?: number;
  rules?: RuleRegistry;
}

/** Engine on the real config with an in-memory store, a fake clock at T0 and built-in side effects logging to `lines`. */
export function setup(options: SetupOptions = {}) {
  const store = new InMemoryWorkflowStore({ lockTimeoutMs: options.lockTimeoutMs ?? 500 });
  const clock = new FakeClock(T0);
  const lines: string[] = [];
  const engine = new WorkflowEngine({
    config: options.config ?? config,
    store,
    clock,
    rules: options.rules,
    sideEffects: createBuiltinSideEffects({ log: (l) => lines.push(l), paymentRequestId: () => 'pr-1' }),
  });

  /** Inserts straight through the store, so a test can start in any state. */
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

  return { store, clock, engine, seed, lines };
}

export async function rejection(promise: Promise<unknown>, code: ErrorCode): Promise<WorkflowError> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  if (!isWorkflowError(error, code)) {
    throw new Error(`Expected WorkflowError ${code}, got ${error instanceof Error ? error.message : String(error)}`);
  }
  return error;
}
