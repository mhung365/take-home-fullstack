import type { Condition, RuleCondition, WorkflowConfig } from '@claims/engine';

/**
 * The config has no field types, so the widget is inferred from the rules that read the field:
 * containsAll → list of values, userHasRole → user picker, anything else → free text.
 */
export type FieldSpec =
  | { kind: 'text' }
  | { kind: 'list'; options: string[] }
  | { kind: 'user'; role: string };

export type FieldValue = string | string[];
export type FieldValues = Record<string, FieldValue>;

const TEXT: FieldSpec = { kind: 'text' };

// RuleCondition has an index signature, so `'all' in condition` alone doesn't narrow the union.
type Group = { all: Condition[] } | { any: Condition[] } | { not: Condition };

function walk(condition: Condition | undefined, visit: (rule: RuleCondition) => void): void {
  if (!condition) return;
  if ('rule' in condition && typeof condition.rule === 'string') {
    visit(condition as RuleCondition);
    return;
  }
  const group = condition as Group;
  if ('all' in group) group.all.forEach((c) => walk(c, visit));
  else if ('any' in group) group.any.forEach((c) => walk(c, visit));
  else walk(group.not, visit);
}

function listOptions(rule: RuleCondition, settings: Record<string, unknown>): string[] {
  if (Array.isArray(rule.values)) return rule.values.map(String);
  if (typeof rule.ref === 'string' && rule.ref.startsWith('$settings.')) {
    const value = settings[rule.ref.slice('$settings.'.length)];
    if (Array.isArray(value)) return value.map(String);
  }
  return [];
}

export function buildFieldSpecs(config: WorkflowConfig): Map<string, FieldSpec> {
  const specs = new Map<string, FieldSpec>();
  for (const transition of config.transitions) {
    walk(transition.preconditions, (rule) => {
      const field = rule.field?.split('.')[0];
      if (!field || specs.has(field)) return;
      if (rule.rule === 'containsAll') specs.set(field, { kind: 'list', options: listOptions(rule, config.settings) });
      else if (rule.rule === 'userHasRole' && typeof rule.role === 'string') specs.set(field, { kind: 'user', role: rule.role });
    });
  }
  return specs;
}

export function fieldSpec(specs: Map<string, FieldSpec>, field: string): FieldSpec {
  return specs.get(field) ?? TEXT;
}

export function emptyValue(spec: FieldSpec): FieldValue {
  return spec.kind === 'list' ? [] : '';
}

/** Empty fields are left out, so "not sent" keeps its meaning (e.g. info_received keeps the old documents). */
export function toPayload(inputs: readonly string[], values: FieldValues): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const field of inputs) {
    const value = values[field];
    if (Array.isArray(value)) {
      if (value.length > 0) payload[field] = value;
    } else if (value !== undefined && value.trim() !== '') {
      payload[field] = value.trim();
    }
  }
  return payload;
}

export function formatValue(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (Array.isArray(value)) return value.length ? value.map(formatValue).join(', ') : '[]';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}
