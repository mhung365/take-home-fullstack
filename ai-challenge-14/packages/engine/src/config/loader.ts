import type { z } from 'zod';
import {
  type Condition,
  type RuleCondition,
  type UsersConfig,
  type WorkflowConfig,
  usersConfigSchema,
  workflowConfigSchema,
} from './schema';

export const CORE_FIELDS = [
  'id',
  'status',
  'memberId',
  'amount',
  'policyLimit',
  'stateEnteredAt',
  'createdAt',
  'createdBy',
  'version',
] as const;

export type ConfigSource = 'workflow' | 'users';

export interface ConfigIssue {
  source: ConfigSource;
  path: string;
  message: string;
}

export interface LoadedConfig {
  workflow: WorkflowConfig;
  users: UsersConfig;
}

export type ConfigValidationResult =
  | { ok: true; config: LoadedConfig; warnings: ConfigIssue[] }
  | { ok: false; errors: ConfigIssue[]; warnings: ConfigIssue[] };

export interface RawConfig {
  workflow: unknown;
  users: unknown;
}

export class ConfigValidationError extends Error {
  constructor(
    readonly errors: ConfigIssue[],
    readonly warnings: ConfigIssue[],
  ) {
    super(
      `Invalid workflow config (${errors.length} error${errors.length === 1 ? '' : 's'}):\n` +
        errors.map((e) => `  - ${formatIssue(e)}`).join('\n'),
    );
    this.name = 'ConfigValidationError';
  }
}

export function formatIssue(issue: ConfigIssue): string {
  return `[${issue.source}] ${issue.path || '(root)'}: ${issue.message}`;
}

/** Validates already-parsed JSON. Never throws; reports every error found. */
export function validateConfig(raw: RawConfig): ConfigValidationResult {
  const errors: ConfigIssue[] = [];
  const warnings: ConfigIssue[] = [];

  const workflow = workflowConfigSchema.safeParse(raw.workflow);
  const users = usersConfigSchema.safeParse(raw.users);

  if (!workflow.success) errors.push(...zodIssues('workflow', workflow.error));
  if (!users.success) errors.push(...zodIssues('users', users.error));

  if (workflow.success) checkWorkflow(workflow.data, errors, warnings);
  if (users.success) checkUsers(users.data, workflow.success ? workflow.data : undefined, errors);

  if (errors.length > 0 || !workflow.success || !users.success) {
    return { ok: false, errors, warnings };
  }
  return { ok: true, config: { workflow: workflow.data, users: users.data }, warnings };
}

/** Like validateConfig, but throws ConfigValidationError listing all errors. */
export function loadConfig(raw: RawConfig): LoadedConfig & { warnings: ConfigIssue[] } {
  const result = validateConfig(raw);
  if (!result.ok) throw new ConfigValidationError(result.errors, result.warnings);
  return { ...result.config, warnings: result.warnings };
}

function zodIssues(source: ConfigSource, error: z.ZodError): ConfigIssue[] {
  return error.issues.map((issue) => ({
    source,
    path: formatPath(issue.path),
    message: issue.message,
  }));
}

function formatPath(path: readonly PropertyKey[]): string {
  return path
    .map((key, i) => (typeof key === 'number' ? `[${key}]` : `${i === 0 ? '' : '.'}${String(key)}`))
    .join('');
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const dupes = new Set<string>();
  for (const v of values) (seen.has(v) ? dupes : seen).add(v);
  return [...dupes];
}

function checkWorkflow(wf: WorkflowConfig, errors: ConfigIssue[], warnings: ConfigIssue[]): void {
  const error = (path: string, message: string) => errors.push({ source: 'workflow', path, message });

  const stateIds = wf.states.map((s) => s.id);
  const states = new Set(stateIds);
  const roles = new Set(wf.roles);
  const coreFields = new Set<string>(CORE_FIELDS);
  const knownStates = stateIds.join(', ');
  const knownRoles = wf.roles.join(', ');

  for (const id of duplicates(stateIds)) error('states', `Duplicate state id ${id}`);
  for (const role of duplicates(wf.roles)) error('roles', `Duplicate role ${role}`);

  const checkState = (path: string, state: string, context: string) => {
    if (!states.has(state)) error(path, `${context} references unknown state ${state}. Known states: ${knownStates}`);
  };
  const checkRoles = (path: string, list: readonly string[], context: string) => {
    list.forEach((role, i) => {
      if (!roles.has(role)) error(`${path}[${i}]`, `${context} uses unknown role ${role}. Known roles: ${knownRoles}`);
    });
  };
  const checkInputs = (path: string, inputs: readonly string[], context: string) => {
    inputs.forEach((field, i) => {
      if (coreFields.has(field)) {
        error(`${path}[${i}]`, `${context} input ${field} collides with core claim field. Core fields: ${CORE_FIELDS.join(', ')}`);
      }
    });
  };

  checkState('initialState', wf.initialState, 'initialState');

  const { createClaim, acknowledge, runSystemTasks } = wf.actions;
  checkRoles('actions.createClaim.roles', createClaim.roles, 'Action createClaim');
  checkInputs('actions.createClaim.inputs', createClaim.inputs, 'Action createClaim');
  checkRoles('actions.acknowledge.roles', acknowledge.roles, 'Action acknowledge');
  acknowledge.allowedStates.forEach((s, i) =>
    checkState(`actions.acknowledge.allowedStates[${i}]`, s, 'Action acknowledge allowedStates'),
  );
  checkRoles('actions.runSystemTasks.roles', runSystemTasks.roles, 'Action runSystemTasks');

  const terminal = new Set(wf.states.filter((s) => s.terminal).map((s) => s.id));
  const transitionIds = new Map<string, number>();
  const edges = new Map<string, string>();

  wf.transitions.forEach((t, i) => {
    const path = `transitions[${i}]`;
    const label = `Transition ${t.id}`;

    const firstId = transitionIds.get(t.id);
    if (firstId !== undefined) error(`${path}.id`, `Duplicate transition id ${t.id} (also at transitions[${firstId}])`);
    else transitionIds.set(t.id, i);

    const edge = `${t.from} → ${t.to}`;
    const firstEdge = edges.get(edge);
    if (firstEdge !== undefined) error(path, `${label} duplicates ${edge} already defined by transition ${firstEdge}`);
    else edges.set(edge, t.id);

    checkState(`${path}.from`, t.from, `${label} from`);
    checkState(`${path}.to`, t.to, `${label} to`);
    if (terminal.has(t.from)) error(`${path}.from`, `${label} leaves terminal state ${t.from}`);

    checkRoles(`${path}.roles`, t.roles, label);
    checkInputs(`${path}.inputs`, t.inputs, label);

    const inputs = new Set(t.inputs);
    if (t.reasonField !== undefined && !inputs.has(t.reasonField)) {
      error(`${path}.reasonField`, `${label} reasonField ${t.reasonField} is not in inputs (${t.inputs.join(', ') || 'none'})`);
    }

    if (t.preconditions) {
      walkRules(t.preconditions, `${path}.preconditions`, (rule, rulePath) => {
        if (rule.rule === 'providedInRequest' && typeof rule.field === 'string' && !inputs.has(rule.field)) {
          error(
            `${rulePath}.field`,
            `${label} requires ${rule.field} to be provided in request, but it is not in inputs (${t.inputs.join(', ') || 'none'})`,
          );
        }
      });
    }
  });

  if (states.has(wf.initialState)) {
    const reachable = new Set([wf.initialState]);
    const queue = [wf.initialState];
    while (queue.length > 0) {
      const from = queue.shift()!;
      for (const t of wf.transitions) {
        if (t.from === from && !reachable.has(t.to)) {
          reachable.add(t.to);
          queue.push(t.to);
        }
      }
    }
    wf.states.forEach((s, i) => {
      if (!reachable.has(s.id)) {
        warnings.push({ source: 'workflow', path: `states[${i}]`, message: `State ${s.id} is not reachable from ${wf.initialState}` });
      }
    });
  }
}

// The schema parses any node with an all/any/not key as a group, so these casts are safe.
function walkRules(node: Condition, path: string, visit: (rule: RuleCondition, path: string) => void): void {
  if ('all' in node) (node.all as Condition[]).forEach((c, i) => walkRules(c, `${path}.all[${i}]`, visit));
  else if ('any' in node) (node.any as Condition[]).forEach((c, i) => walkRules(c, `${path}.any[${i}]`, visit));
  else if ('not' in node) walkRules(node.not as Condition, `${path}.not`, visit);
  else visit(node as RuleCondition, path);
}

function checkUsers(users: UsersConfig, wf: WorkflowConfig | undefined, errors: ConfigIssue[]): void {
  const error = (path: string, message: string) => errors.push({ source: 'users', path, message });

  const firstIndex = new Map<string, number>();
  users.users.forEach((u, i) => {
    const first = firstIndex.get(u.id);
    if (first !== undefined) error(`users[${i}].id`, `Duplicate user id ${u.id} (also at users[${first}])`);
    else firstIndex.set(u.id, i);
  });

  if (!wf) return;
  const roles = new Set(wf.roles);
  users.users.forEach((u, i) => {
    if (!roles.has(u.role)) {
      error(`users[${i}].role`, `User ${u.id} has unknown role ${u.role}. Known roles: ${wf.roles.join(', ')}`);
    }
  });
}
