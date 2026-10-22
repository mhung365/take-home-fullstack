import type { TransitionConfig, WorkflowConfig } from '../config/schema';
import { WorkflowError } from '../errors';
import type { AuditEntry, Claim, NewAuditEntry, StateId } from '../model/types';
import { isEmpty, show } from '../rules/values';
import { isPlainObject } from '../util';

export interface TransitionRequest {
  to: StateId;
  /** Values for the transition's inputs; anything else is rejected. */
  payload?: Record<string, unknown>;
  notes?: string;
  /** If set and different from the claim's version under the lock, the request is STALE_CLAIM. */
  expectedVersion?: number;
}

export interface TransitionResult {
  claim: Claim;
  /** The TRANSITION entry followed by one SIDE_EFFECT entry per side effect, as stored. */
  audit: AuditEntry[];
}

export class TransitionIndex {
  private readonly byEdge = new Map<string, TransitionConfig>();
  private readonly byFrom = new Map<StateId, TransitionConfig[]>();
  private readonly states: WorkflowConfig['states'];

  constructor(workflow: WorkflowConfig) {
    this.states = workflow.states;
    for (const t of workflow.transitions) {
      this.byEdge.set(edgeKey(t.from, t.to), t);
      this.byFrom.set(t.from, [...(this.byFrom.get(t.from) ?? []), t]);
    }
  }

  find(from: StateId, to: StateId): TransitionConfig | undefined {
    return this.byEdge.get(edgeKey(from, to));
  }

  outgoing(from: StateId): readonly TransitionConfig[] {
    return this.byFrom.get(from) ?? [];
  }

  invalidTransition(from: StateId, to: StateId): WorkflowError {
    const allowed = this.outgoing(from);
    const allowedText = `Allowed from ${from}: ${
      allowed.map((t) => `${t.to} (${t.roles.join(', ')})`).join(', ') || 'none'
    }`;
    const details = {
      from,
      to,
      allowed: allowed.map((t) => ({ transitionId: t.id, to: t.to, roles: [...t.roles] })),
    };

    let message: string;
    if (!this.states.some((s) => s.id === to)) {
      message = `Unknown state ${to}. Known states: ${this.states.map((s) => s.id).join(', ')}. ${allowedText}`;
    } else if (this.states.some((s) => s.id === from && s.terminal)) {
      message = `Claim is in terminal state ${from}; no transitions allowed`;
    } else {
      message = `Cannot transition ${from} → ${to}. ${allowedText}`;
    }
    return new WorkflowError('INVALID_TRANSITION', message, details);
  }
}

const edgeKey = (from: StateId, to: StateId) => `${from}\u0000${to}`;

export function checkPayload(transition: TransitionConfig, payload: unknown): WorkflowError | null {
  const allowedText = `Allowed: ${transition.inputs.join(', ') || 'none'}`;
  if (!isPlainObject(payload)) {
    return new WorkflowError(
      'INVALID_PAYLOAD',
      `Payload of transition ${transition.id} must be an object. ${allowedText}`,
      { transitionId: transition.id, allowed: [...transition.inputs] },
    );
  }

  const rejected = Object.keys(payload).filter((field) => !transition.inputs.includes(field));
  if (rejected.length === 0) return null;
  const subject = rejected.length === 1 ? `Field ${rejected[0]} is` : `Fields ${rejected.join(', ')} are`;
  return new WorkflowError(
    'INVALID_PAYLOAD',
    `${subject} not accepted by transition ${transition.id}. ${allowedText}`,
    { transitionId: transition.id, rejected, allowed: [...transition.inputs] },
  );
}

/** A detached copy of claim with payload merged into data; payload values replace, not merge. */
export function mergeDraft(claim: Claim, payload: Record<string, unknown>): Claim {
  const draft = structuredClone(claim);
  Object.assign(draft.data, structuredClone(payload));
  return draft;
}

/** Core fields win, though the loader already forbids data fields named like core fields. */
export function claimView(claim: Claim): Record<string, unknown> {
  const { data, ...core } = claim;
  return { ...data, ...core };
}

/** reasonField value from the payload, then notes, then the transition description. */
export function transitionReason(
  transition: TransitionConfig,
  payload: Record<string, unknown>,
  notes: string | undefined,
): string {
  if (transition.reasonField !== undefined) {
    const value = payload[transition.reasonField];
    if (!isEmpty(value)) return typeof value === 'string' ? value : show(value);
  }
  if (!isEmpty(notes)) return notes!;
  return transition.description;
}

export function notesField(notes: string | undefined): Pick<NewAuditEntry, 'notes'> {
  return isEmpty(notes) ? {} : { notes };
}

/** The errors list stored with a rejection: rule failures when there are any, else the message. */
export function rejectionErrors(error: WorkflowError): Record<string, unknown>[] {
  const failures = error.details?.failures;
  return Array.isArray(failures) ? failures.map((f) => ({ ...f })) : [{ message: error.message }];
}
