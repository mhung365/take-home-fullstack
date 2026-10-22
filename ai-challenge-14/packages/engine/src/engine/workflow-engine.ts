import { systemClock, type Clock } from '../clock';
import { CORE_FIELDS, type LoadedConfig } from '../config/loader';
import type { TransitionConfig, UserConfig, WorkflowConfig } from '../config/schema';
import {
  actionNotAllowedInState,
  claimNotFound,
  cycleLimitExceeded,
  preconditionFailed,
  staleClaim,
  unauthorizedRole,
  unknownUser,
  type WorkflowError,
} from '../errors';
import type { AuditEntry, Claim, NewAuditEntry } from '../model/types';
import { defaultRules } from '../rules/builtins';
import { evaluatePreconditions } from '../rules/evaluate';
import type { EvaluationMode, EvaluationResult, RuleRegistry } from '../rules/types';
import { isEmpty } from '../rules/values';
import { defaultSideEffects } from '../side-effects/builtins';
import type { SideEffectHandler, SideEffectRegistry } from '../side-effects/types';
import type { ClaimTx, WorkflowStore } from '../store/types';
import { deepFreeze, isPlainObject } from '../util';
import {
  ACKNOWLEDGE_REASON,
  CLAIM_CREATED_REASON,
  acknowledgementFields,
  alreadyAcknowledged,
  parseCreateInput,
  type AcknowledgeResult,
  type CreateClaimInput,
} from './actions';
import { ruleChecks, type AvailableTransition, type AvailableTransitions } from './available';
import {
  SYSTEM_ROLE,
  type ProcessedSystemTask,
  type SkippedSystemTask,
  type SystemTasksResult,
} from './system-tasks';
import {
  TransitionIndex,
  checkPayload,
  claimView,
  mergeDraft,
  notesField,
  rejectionErrors,
  transitionReason,
  type TransitionRequest,
  type TransitionResult,
} from './transition';

export interface WorkflowEngineOptions {
  config: LoadedConfig;
  store: WorkflowStore;
  /** Defaults to the system clock. */
  clock?: Clock;
  /** Defaults to the built-in rules. */
  rules?: RuleRegistry;
  /** Defaults to the built-in handlers; must be the registry the config was loaded with. */
  sideEffects?: SideEffectRegistry;
}

type Rejection = { ok: false; error: WorkflowError; transitionId?: string };
type Outcome<T> = { ok: true; value: T } | Rejection;

const reject = (error: WorkflowError, transitionId?: string): Rejection => ({ ok: false, error, transitionId });

interface CompiledSideEffect {
  name: string;
  handler: SideEffectHandler<unknown>;
  params: unknown;
}

const CORE_FIELD_SET = new Set<string>(CORE_FIELDS);

export class WorkflowEngine {
  private readonly workflow: WorkflowConfig;
  private readonly store: WorkflowStore;
  private readonly clock: Clock;
  private readonly rules: RuleRegistry;
  private readonly users: Map<string, UserConfig>;
  private readonly transitions: TransitionIndex;
  private readonly sideEffects: Map<string, CompiledSideEffect[]>;

  constructor(options: WorkflowEngineOptions) {
    this.workflow = options.config.workflow;
    this.store = options.store;
    this.clock = options.clock ?? systemClock;
    this.rules = options.rules ?? defaultRules;
    this.users = new Map(options.config.users.users.map((u) => [u.id, u]));
    this.transitions = new TransitionIndex(this.workflow);
    this.sideEffects = compileSideEffects(this.workflow, options.sideEffects ?? defaultSideEffects);
  }

  /**
   * DESIGN 6.1. Rejections from the expected-version check through the cycle limit are
   * audited as TRANSITION_REJECTED and committed, then thrown as WorkflowError. Any other
   * error thrown inside the transaction rolls it back, audit included.
   */
  async transition(claimId: string, userId: string, request: TransitionRequest): Promise<TransitionResult> {
    const user = this.requireUser(userId);

    const outcome = await this.store.withClaim(claimId, async (tx): Promise<Outcome<TransitionResult>> => {
      // Read under the lock, so timestamps follow seq order across requests on the same claim.
      const now = this.clock.now();
      const checked = await this.checkTransition(tx, user, request, now);
      if (!checked.ok) {
        // Must return, not throw: withClaim discards everything written when fn throws.
        await tx.appendAudit(rejectedEntry(tx.claim, user, request, checked, now));
        return checked;
      }
      return { ok: true, value: await this.applyTransition(tx, user, request, checked.value, now) };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * DESIGN 6.2. Rejections are thrown without audit: there is no claim to attach them to.
   * The claim and its CLAIM_CREATED entry (seq 1) are written in one store transaction.
   */
  async createClaim(userId: string, input: CreateClaimInput): Promise<Claim> {
    const user = this.requireUser(userId);
    const action = this.workflow.actions.createClaim;
    if (!action.roles.includes(user.role)) throw unauthorizedRole('Action createClaim', action.roles, user);

    const { core, data } = parseCreateInput(input, action.inputs);
    const now = this.clock.now().toISOString();
    const status = this.workflow.initialState;
    return this.store.createClaim(
      { ...core, status, stateEnteredAt: now, createdAt: now, createdBy: user.id, data },
      {
        type: 'CLAIM_CREATED',
        timestamp: now,
        fromState: null,
        toState: status,
        triggeredBy: { userId: user.id, role: user.role },
        reason: CLAIM_CREATED_REASON,
        data: structuredClone(input),
      },
    );
  }

  /**
   * DESIGN 6.2. Same transaction rules as transition: rejections are audited as
   * ACTION_REJECTED and committed, then thrown as WorkflowError.
   */
  async acknowledge(claimId: string, userId: string, notes?: string, expectedVersion?: number): Promise<AcknowledgeResult> {
    const user = this.requireUser(userId);

    const outcome = await this.store.withClaim(claimId, async (tx): Promise<Outcome<AcknowledgeResult>> => {
      const now = this.clock.now();
      const error = this.checkAcknowledge(tx.claim, user, expectedVersion);
      if (error) {
        // Must return, not throw: withClaim discards everything written when fn throws.
        await tx.appendAudit(actionRejectedEntry('acknowledge', tx.claim, user, error, notes, now));
        return reject(error);
      }
      return { ok: true, value: await this.applyAcknowledge(tx, user, notes, now) };
    });

    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  /**
   * DESIGN 6.2. Runs every transition open to SYSTEM_ROLE on the claims in its from state,
   * regardless of the caller's role. Claims are listed without a lock up front, then each one gets its own
   * transaction via tryWithClaim, where status, preconditions and cycle limit are checked
   * again. Claims that don't qualify are skipped without audit; an error on one claim
   * rolls back only that claim.
   */
  async runSystemTasks(userId: string): Promise<SystemTasksResult> {
    const user = this.requireUser(userId);
    const action = this.workflow.actions.runSystemTasks;
    if (!action.roles.includes(user.role)) throw unauthorizedRole('Action runSystemTasks', action.roles, user);

    // Scanned before running anything, so a claim moved by one task isn't picked up by a later one.
    const work: { transition: TransitionConfig; claimIds: string[] }[] = [];
    for (const transition of this.workflow.transitions) {
      if (!transition.roles.includes(SYSTEM_ROLE)) continue;
      const claims = await this.store.listClaims({ status: [transition.from] });
      work.push({ transition, claimIds: claims.map((c) => c.id) });
    }

    const result: SystemTasksResult = { processed: [], skipped: [] };
    for (const { transition, claimIds } of work) {
      for (const claimId of claimIds) {
        const task = { claimId, transitionId: transition.id };
        try {
          const outcome = await this.store.tryWithClaim(claimId, (tx) => this.runSystemTask(tx, user, transition));
          if (outcome === null) {
            result.skipped.push({ ...task, reason: 'busy', message: `Claim ${claimId} is locked by another request` });
          } else if ('reason' in outcome) {
            result.skipped.push({ ...task, ...outcome });
          } else {
            result.processed.push({ ...task, ...outcome });
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          result.skipped.push({ ...task, reason: 'error', message });
        }
      }
    }
    return result;
  }

  private async runSystemTask(
    tx: ClaimTx,
    user: UserConfig,
    transition: TransitionConfig,
  ): Promise<
    Omit<ProcessedSystemTask, 'claimId' | 'transitionId'> | Omit<SkippedSystemTask, 'claimId' | 'transitionId'>
  > {
    const { claim } = tx;
    if (claim.status !== transition.from) {
      return { reason: 'state_changed', message: `Claim is in ${claim.status}, no longer in ${transition.from}` };
    }

    const now = this.clock.now();
    const draft = mergeDraft(claim, {});
    const evaluation = this.evaluate(transition, draft, {}, now, 'execute');
    if (!evaluation.passed) {
      const { message } = preconditionFailed(transition.id, evaluation.failures);
      return { reason: 'preconditions_not_met', message, failures: evaluation.failures };
    }

    const cycleError = await this.checkCycleLimit(tx, transition);
    if (cycleError) return { reason: 'cycle_limit_reached', message: cycleError.message };

    const { claim: next } = await this.applyTransition(tx, user, { to: transition.to }, { transition, draft }, now);
    return { from: transition.from, to: transition.to, version: next.version };
  }

  /**
   * DESIGN 6.3. Read-only and lock-free: preconditions are evaluated in preview mode on the
   * current claim with an empty payload, so the result is a hint for the UI, not a guarantee.
   */
  async getAvailableTransitions(claimId: string, userId?: string): Promise<AvailableTransitions> {
    const user = userId === undefined ? undefined : this.requireUser(userId);
    const claim = await this.store.getClaim(claimId);
    if (!claim) throw claimNotFound(claimId);

    const outgoing = this.transitions.outgoing(claim.status);
    const audit = outgoing.some((t) => t.cycleLimit) ? await this.store.listAuditByClaim(claimId) : [];
    const now = this.clock.now();

    const transitions = outgoing.map((t): AvailableTransition => {
      const allowedForCurrentUser = user !== undefined && t.roles.includes(user.role);
      const evaluation = this.evaluate(t, claim, {}, now, 'preview');

      let cycleLimit: AvailableTransition['cycleLimit'];
      if (t.cycleLimit) {
        const used = audit.filter((e) => e.type === 'TRANSITION' && e.transitionId === t.id).length;
        cycleLimit = { max: t.cycleLimit.max, used, remaining: Math.max(0, t.cycleLimit.max - used) };
      }

      return {
        transitionId: t.id,
        to: t.to,
        description: t.description,
        roles: [...t.roles],
        inputs: [...t.inputs],
        allowedForCurrentUser,
        preconditions: { passed: evaluation.passed, rules: ruleChecks(evaluation.tree), tree: evaluation.tree },
        ...(cycleLimit && { cycleLimit }),
        enabled: allowedForCurrentUser && evaluation.passed && (cycleLimit === undefined || cycleLimit.remaining > 0),
      };
    });

    return { claimId: claim.id, status: claim.status, version: claim.version, transitions };
  }

  private checkAcknowledge(claim: Claim, user: UserConfig, expectedVersion: number | undefined): WorkflowError | null {
    if (expectedVersion !== undefined && expectedVersion !== claim.version) {
      return staleClaim(claim.id, claim.version, expectedVersion);
    }
    const action = this.workflow.actions.acknowledge;
    if (!action.roles.includes(user.role)) return unauthorizedRole('Action acknowledge', action.roles, user);
    if (!action.allowedStates.includes(claim.status)) {
      return actionNotAllowedInState('acknowledge', action.allowedStates, claim.status);
    }
    return alreadyAcknowledged(claim);
  }

  private async applyAcknowledge(
    tx: ClaimTx,
    user: UserConfig,
    notes: string | undefined,
    now: Date,
  ): Promise<AcknowledgeResult> {
    const at = now.toISOString();
    const fields = acknowledgementFields(user.id, at);
    const draft = structuredClone(tx.claim);
    Object.assign(draft.data, structuredClone(fields));

    await tx.saveClaim(draft);
    const audit = await tx.appendAudit({
      type: 'MEMBER_ACKNOWLEDGED',
      timestamp: at,
      fromState: draft.status,
      toState: draft.status,
      triggeredBy: { userId: user.id, role: user.role },
      reason: isEmpty(notes) ? ACKNOWLEDGE_REASON : notes!,
      ...notesField(notes),
      data: fields,
    });
    return { claim: { ...draft, version: tx.claim.version + 1 }, audit };
  }

  private requireUser(userId: string): UserConfig {
    const user = this.users.get(userId);
    if (!user) throw unknownUser(userId);
    return user;
  }

  private async checkTransition(
    tx: ClaimTx,
    user: UserConfig,
    request: TransitionRequest,
    now: Date,
  ): Promise<Outcome<{ transition: TransitionConfig; draft: Claim }>> {
    const { claim } = tx;

    if (request.expectedVersion !== undefined && request.expectedVersion !== claim.version) {
      return reject(staleClaim(claim.id, claim.version, request.expectedVersion));
    }

    const transition = this.transitions.find(claim.status, request.to);
    if (!transition) return reject(this.transitions.invalidTransition(claim.status, request.to));

    if (!transition.roles.includes(user.role)) {
      return reject(unauthorizedRole(`Transition ${transition.id}`, transition.roles, user), transition.id);
    }

    const payload = request.payload ?? {};
    const payloadError = checkPayload(transition, payload);
    if (payloadError) return reject(payloadError, transition.id);

    const draft = mergeDraft(claim, payload);
    const evaluation = this.evaluate(transition, draft, payload, now, 'execute');
    if (!evaluation.passed) return reject(preconditionFailed(transition.id, evaluation.failures), transition.id);

    const cycleError = await this.checkCycleLimit(tx, transition);
    if (cycleError) return reject(cycleError, transition.id);

    return { ok: true, value: { transition, draft } };
  }

  private evaluate(
    transition: TransitionConfig,
    claim: Claim,
    payload: Record<string, unknown>,
    now: Date,
    mode: EvaluationMode,
  ): EvaluationResult {
    return evaluatePreconditions(
      transition.preconditions,
      {
        view: claimView(claim),
        payload,
        inputs: transition.inputs,
        settings: this.workflow.settings,
        findUser: (id) => this.users.get(id),
        now,
        mode,
      },
      this.rules,
    );
  }

  /** Counted under the lock, so concurrent requests can't both pass at the max-th attempt. */
  private async checkCycleLimit(tx: ClaimTx, transition: TransitionConfig): Promise<WorkflowError | null> {
    const { cycleLimit } = transition;
    if (cycleLimit && (await tx.countSuccessfulTransitions(transition.id)) >= cycleLimit.max) {
      return cycleLimitExceeded(transition.id, cycleLimit.max, cycleLimit.message);
    }
    return null;
  }

  private async applyTransition(
    tx: ClaimTx,
    user: UserConfig,
    request: TransitionRequest,
    { transition, draft }: { transition: TransitionConfig; draft: Claim },
    now: Date,
  ): Promise<TransitionResult> {
    const payload = request.payload ?? {};
    draft.status = transition.to;
    draft.stateEnteredAt = now.toISOString();

    const shared = {
      timestamp: now.toISOString(),
      fromState: transition.from,
      toState: transition.to,
      transitionId: transition.id,
      triggeredBy: { userId: user.id, role: user.role },
    };
    const entries: NewAuditEntry[] = [
      {
        ...shared,
        type: 'TRANSITION',
        reason: transitionReason(transition, payload, request.notes),
        ...notesField(request.notes),
        data: structuredClone(payload),
      },
    ];

    for (const step of this.sideEffects.get(transition.id) ?? []) {
      entries.push({ ...shared, ...(await this.runSideEffect(step, draft, transition, user, now)) });
    }

    await tx.saveClaim(draft);
    const audit: AuditEntry[] = [];
    for (const entry of entries) audit.push(await tx.appendAudit(entry));
    return { claim: { ...draft, version: tx.claim.version + 1 }, audit };
  }

  /** Applies the handler's dataPatch to draft on success; never throws. */
  private async runSideEffect(
    { name, handler, params }: CompiledSideEffect,
    draft: Claim,
    transition: TransitionConfig,
    user: UserConfig,
    now: Date,
  ): Promise<Pick<NewAuditEntry, 'type' | 'reason' | 'data'>> {
    try {
      const claim = deepFreeze(structuredClone(draft));
      const outcome = await handler.run(params, {
        claim,
        view: deepFreeze(claimView(claim)),
        transition: { id: transition.id, from: transition.from, to: transition.to },
        triggeredBy: { userId: user.id, role: user.role },
        settings: this.workflow.settings,
        users: [...this.users.values()],
        now: new Date(now),
      });
      const patch = validPatch(name, outcome?.dataPatch);
      if (patch) Object.assign(draft.data, structuredClone(patch));

      const data: Record<string, unknown> = { name, status: 'ok' };
      if (outcome?.result !== undefined) data.result = structuredClone(outcome.result);
      return { type: 'SIDE_EFFECT', reason: `Side effect ${name} succeeded`, data };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return {
        type: 'SIDE_EFFECT',
        reason: `Side effect ${name} failed: ${message}`,
        data: { name, status: 'failed', error: message },
      };
    }
  }
}

function validPatch(name: string, patch: unknown): Record<string, unknown> | undefined {
  if (patch === undefined) return undefined;
  if (!isPlainObject(patch)) throw new Error(`Side effect ${name} returned a dataPatch that is not an object`);
  const core = Object.keys(patch).filter((key) => CORE_FIELD_SET.has(key));
  if (core.length > 0) throw new Error(`Side effect ${name} may not write core fields: ${core.join(', ')}`);
  return patch;
}

function compileSideEffects(
  workflow: WorkflowConfig,
  registry: SideEffectRegistry,
): Map<string, CompiledSideEffect[]> {
  const compiled = new Map<string, CompiledSideEffect[]>();
  for (const transition of workflow.transitions) {
    compiled.set(
      transition.id,
      transition.sideEffects.map(({ name, params }, i) => {
        const where = `transition ${transition.id} sideEffects[${i}]`;
        const handler = registry.get(name);
        if (!handler) throw new Error(`Unknown side effect ${name} in ${where}`);
        const parsed = handler.params.safeParse(params ?? {});
        if (!parsed.success) throw new Error(`Invalid params for side effect ${name} in ${where}: ${parsed.error.message}`);
        return { name, handler, params: parsed.data };
      }),
    );
  }
  return compiled;
}

function rejectedEntry(
  claim: Claim,
  user: UserConfig,
  request: TransitionRequest,
  { error, transitionId }: Rejection,
  now: Date,
): NewAuditEntry {
  return {
    type: 'TRANSITION_REJECTED',
    timestamp: now.toISOString(),
    fromState: claim.status,
    toState: request.to,
    ...(transitionId !== undefined && { transitionId }),
    triggeredBy: { userId: user.id, role: user.role },
    reason: error.message,
    ...notesField(request.notes),
    data: { code: error.code, errors: rejectionErrors(error), payload: structuredClone(request.payload ?? {}) },
  };
}

/** Actions don't change state, so fromState and toState are both the claim's current state. */
function actionRejectedEntry(
  action: string,
  claim: Claim,
  user: UserConfig,
  error: WorkflowError,
  notes: string | undefined,
  now: Date,
): NewAuditEntry {
  return {
    type: 'ACTION_REJECTED',
    timestamp: now.toISOString(),
    fromState: claim.status,
    toState: claim.status,
    triggeredBy: { userId: user.id, role: user.role },
    reason: error.message,
    ...notesField(notes),
    data: { action, code: error.code, errors: rejectionErrors(error) },
  };
}
