import type { z } from 'zod';
import type { UserConfig, WorkflowConfig } from '../config/schema';

export type EvaluationMode = 'execute' | 'preview';

export interface EvaluationContext {
  /** Flat view of the claim: core fields + data (after merging the payload when executing). */
  view: Readonly<Record<string, unknown>>;
  /** Payload of this request; only providedInRequest reads it. */
  payload: Readonly<Record<string, unknown>>;
  /** Inputs of the transition being evaluated; used by preview mode. */
  inputs: readonly string[];
  settings: Readonly<Record<string, unknown>>;
  findUser(id: string): UserConfig | undefined;
  now: Date;
  /**
   * preview: an unsatisfied rule on a field listed in `inputs` passes with requiresInput,
   * because the user can still fill it in the form. Defaults to execute.
   */
  mode?: EvaluationMode;
}

export interface RuleContext extends EvaluationContext {
  /** Reads the view by dot path, e.g. "paymentRequest.id". */
  get(path: string): unknown;
  /** "$settings.<key>" reads settings; anything else is a field path on the view. */
  resolveRef(ref: string): unknown;
  /** "$settings.<key>" reads settings; anything else is returned as is. */
  resolveValue(value: unknown): unknown;
}

export interface RuleOutcome {
  passed: boolean;
  /** Failure message when failed; short description when passed (used by `not` and the UI). */
  message: string;
}

export interface RuleConfigIssue {
  /** Param key the issue is about, e.g. "role". */
  key: string;
  message: string;
}

export interface RuleDefinition<P = unknown> {
  name: string;
  /** Schema of the whole rule node (rule, field, message and rule-specific params). */
  params: z.ZodType<P>;
  /** Extra load-time checks against the workflow, beyond the params schema. */
  validate?(params: P, workflow: WorkflowConfig): RuleConfigIssue[];
  evaluate(params: P, ctx: RuleContext): RuleOutcome;
}

// Params are checked against each rule's own schema, so the registry can't be typed per entry.
export type RuleRegistry = ReadonlyMap<string, RuleDefinition<any>>;

export interface RuleFailure {
  rule: string;
  field?: string;
  /** Location in the condition tree, e.g. "all[0].any[1]"; "" for the root. */
  path: string;
  message: string;
}

export type ConditionResult =
  | {
      kind: 'rule';
      rule: string;
      field?: string;
      path: string;
      passed: boolean;
      message: string;
      requiresInput?: true;
    }
  | { kind: 'all' | 'any'; path: string; passed: boolean; children: ConditionResult[] }
  | { kind: 'not'; path: string; passed: boolean; child: ConditionResult };

export interface EvaluationResult {
  passed: boolean;
  failures: RuleFailure[];
  /** null when the transition has no preconditions. */
  tree: ConditionResult | null;
}
