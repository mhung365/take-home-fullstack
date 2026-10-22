import { systemClock, type Clock } from '../clock';
import { CORE_FIELDS, type LoadedConfig } from '../config/loader';
import type { TransitionConfig, UserConfig, WorkflowConfig } from '../config/schema';
import {
  actionNotAllowedInState,
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
import type { RuleRegistry } from '../rules/types';
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
    const evaluation = evaluatePreconditions(
      transition.preconditions,
      {
        view: claimView(draft),
        payload,
        inputs: transition.inputs,
        settings: this.workflow.settings,
        findUser: (id) => this.users.get(id),
        now,
        mode: 'execute',
      },
      this.rules,
    );
    if (!evaluation.passed) return reject(preconditionFailed(transition.id, evaluation.failures), transition.id);

    const { cycleLimit } = transition;
    if (cycleLimit && (await tx.countSuccessfulTransitions(transition.id)) >= cycleLimit.max) {
      return reject(cycleLimitExceeded(transition.id, cycleLimit.max, cycleLimit.message), transition.id);
    }

    return { ok: true, value: { transition, draft } };
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
