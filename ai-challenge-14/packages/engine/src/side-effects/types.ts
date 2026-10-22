import type { z } from 'zod';
import type { UserConfig, WorkflowConfig } from '../config/schema';
import type { Claim, Role, StateId } from '../model/types';

export interface SideEffectContext {
  /** The draft claim after the state change and earlier side effects; deep-frozen copy. */
  claim: Readonly<Claim>;
  /** Flat view of claim: core fields + data, same as rules and templates read. */
  view: Readonly<Record<string, unknown>>;
  transition: { id: string; from: StateId; to: StateId };
  triggeredBy: { userId: string; role: Role };
  settings: Readonly<Record<string, unknown>>;
  users: readonly UserConfig[];
  /** Same instant as the transition's stateEnteredAt and audit timestamps. */
  now: Date;
}

export interface SideEffectOutcome {
  /** Stored in the SIDE_EFFECT audit entry; must be JSON-serializable. */
  result?: unknown;
  /** Merged into claim.data; may not touch core fields. */
  dataPatch?: Record<string, unknown>;
}

/**
 * Runs inside the claim's transaction but must not touch the store: it only reads the
 * context and returns an outcome. Throwing marks the side effect failed without rolling
 * back the transition.
 */
export interface SideEffectHandler<P = unknown> {
  name: string;
  /** Schema for the config's params ({} when the config omits them). */
  params: z.ZodType<P>;
  /** Fields of claim.data this side effect writes; templates anywhere in the config may read them. */
  writes?(params: P): string[];
  /** Load-time checks beyond the params schema; runs after every side effect's writes are known. */
  validate?(params: P, ctx: SideEffectValidationContext): SideEffectConfigIssue[];
  run(params: P, ctx: SideEffectContext): SideEffectOutcome | Promise<SideEffectOutcome>;
}

export interface SideEffectValidationContext {
  workflow: WorkflowConfig;
  coreFields: readonly string[];
  /**
   * True for core fields, transition and action inputs, and fields written by actions or
   * side effects. A dot path is checked by its first segment.
   */
  isKnownField(path: string): boolean;
}

export interface SideEffectConfigIssue {
  /** Param key the issue is about, e.g. "template". */
  key: string;
  message: string;
}

// Params are checked against each handler's own schema, so the registry can't be typed per entry.
export type SideEffectRegistry = ReadonlyMap<string, SideEffectHandler<any>>;
