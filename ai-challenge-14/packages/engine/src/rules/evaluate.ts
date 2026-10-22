import type { Condition, RuleCondition } from '../config/schema';
import { defaultRules } from './builtins';
import type {
  ConditionResult,
  EvaluationContext,
  EvaluationResult,
  RuleContext,
  RuleFailure,
  RuleRegistry,
} from './types';
import { SETTINGS_PREFIX, isSettingsRef, readPath } from './values';

/** Pure and synchronous. Data problems become failures; config problems (unknown rule, bad params) throw. */
export function evaluatePreconditions(
  condition: Condition | undefined,
  ctx: EvaluationContext,
  registry: RuleRegistry = defaultRules,
): EvaluationResult {
  if (!condition) return { passed: true, failures: [], tree: null };

  const tree = evaluateNode(condition, '', createRuleContext(ctx), registry);
  const failures: RuleFailure[] = [];
  collectFailures(tree, failures);
  return { passed: tree.passed, failures, tree };
}

function createRuleContext(ctx: EvaluationContext): RuleContext {
  const readSetting = (ref: string) => {
    const key = ref.slice(SETTINGS_PREFIX.length);
    return Object.hasOwn(ctx.settings, key) ? ctx.settings[key] : undefined;
  };
  const get = (path: string) => readPath(ctx.view, path);
  return {
    ...ctx,
    get,
    resolveRef: (ref) => (isSettingsRef(ref) ? readSetting(ref) : get(ref)),
    resolveValue: (value) => (isSettingsRef(value) ? readSetting(value) : value),
  };
}

const childPath = (parent: string, segment: string) => (parent ? `${parent}.${segment}` : segment);

// The schema parses any node with an all/any/not key as a group, so these casts are safe.
function evaluateNode(node: Condition, path: string, ctx: RuleContext, registry: RuleRegistry): ConditionResult {
  if ('all' in node || 'any' in node) {
    const kind = 'all' in node ? 'all' : 'any';
    const items = ('all' in node ? node.all : node.any) as Condition[];
    const children = items.map((c, i) => evaluateNode(c, childPath(path, `${kind}[${i}]`), ctx, registry));
    const passed = kind === 'all' ? children.every((c) => c.passed) : children.some((c) => c.passed);
    return { kind, path, passed, children };
  }
  if ('not' in node) {
    const child = evaluateNode(node.not as Condition, childPath(path, 'not'), ctx, registry);
    return { kind: 'not', path, passed: !child.passed, child };
  }
  return evaluateRule(node as RuleCondition, path, ctx, registry);
}

function evaluateRule(node: RuleCondition, path: string, ctx: RuleContext, registry: RuleRegistry): ConditionResult {
  const def = registry.get(node.rule);
  if (!def) throw new Error(`Unknown rule ${node.rule}`);

  const params = def.params.safeParse(node);
  if (!params.success) {
    throw new Error(`Invalid params for rule ${node.rule} at ${path || '(root)'}: ${params.error.message}`);
  }

  const outcome = def.evaluate(params.data, ctx);
  const result: ConditionResult = {
    kind: 'rule',
    rule: node.rule,
    field: node.field,
    path,
    passed: outcome.passed,
    message: outcome.passed ? outcome.message : (node.message ?? outcome.message),
  };

  if (!outcome.passed && ctx.mode === 'preview' && node.field && ctx.inputs.includes(node.field.split('.')[0])) {
    return { ...result, passed: true, requiresInput: true };
  }
  return result;
}

function collectFailures(node: ConditionResult, out: RuleFailure[]): void {
  if (node.passed) return;
  switch (node.kind) {
    case 'rule':
      out.push({ rule: node.rule, field: node.field, path: node.path, message: node.message });
      return;
    case 'all':
    case 'any':
      for (const child of node.children) collectFailures(child, out);
      return;
    case 'not': {
      const { child } = node;
      out.push(
        child.kind === 'rule'
          ? { rule: child.rule, field: child.field, path: child.path, message: `Condition must not hold: ${child.message}` }
          : { rule: 'not', path: node.path, message: 'Condition must not hold' },
      );
    }
  }
}
