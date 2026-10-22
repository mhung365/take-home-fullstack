import type { Role, StateId } from '../model/types';
import type { ConditionResult } from '../rules/types';

export interface RuleCheck {
  rule: string;
  field?: string;
  path: string;
  passed: boolean;
  message: string;
  /** Unsatisfied, but on a field the user fills in the transition form. */
  requiresInput?: true;
}

export interface AvailableTransition {
  transitionId: string;
  to: StateId;
  description: string;
  roles: Role[];
  inputs: string[];
  /** false when no user was given. */
  allowedForCurrentUser: boolean;
  preconditions: {
    /** Result of the whole tree in preview mode; rules marked requiresInput count as passed. */
    passed: boolean;
    /** Every rule leaf in tree order. Inside a `not`, passed is the rule's own result. */
    rules: RuleCheck[];
    /** null when the transition has no preconditions. */
    tree: ConditionResult | null;
  };
  cycleLimit?: { max: number; used: number; remaining: number };
  /** allowedForCurrentUser, preconditions passed, and the cycle limit not reached. */
  enabled: boolean;
}

export interface AvailableTransitions {
  claimId: string;
  status: StateId;
  /** Send back as expectedVersion. */
  version: number;
  transitions: AvailableTransition[];
}

export function ruleChecks(node: ConditionResult | null, out: RuleCheck[] = []): RuleCheck[] {
  if (!node) return out;
  switch (node.kind) {
    case 'rule': {
      const { kind: _kind, ...check } = node;
      out.push(check);
      break;
    }
    case 'all':
    case 'any':
      for (const child of node.children) ruleChecks(child, out);
      break;
    case 'not':
      ruleChecks(node.child, out);
  }
  return out;
}
