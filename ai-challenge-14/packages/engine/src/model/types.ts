/** State ids and roles come from the workflow config, so they can't be a closed union. */
export type StateId = string;
export type Role = string;

export interface Claim {
  // Core fields: written only by the engine, never by payloads or side effects.
  id: string;
  memberId: string;
  status: StateId;
  /** ISO; updated on every state change. */
  stateEnteredAt: string;
  amount: number;
  policyLimit: number;
  /** ISO. */
  createdAt: string;
  createdBy: string;
  /** Starts at 1; +1 on every write of the claim (transition, acknowledge). */
  version: number;

  /** Config-driven fields: transition/action inputs and side effect results. */
  data: Record<string, unknown>;
}

/** id and version are assigned by the store. */
export type NewClaim = Omit<Claim, 'id' | 'version'>;

export const AUDIT_TYPES = [
  'CLAIM_CREATED',
  'TRANSITION',
  'TRANSITION_REJECTED',
  'MEMBER_ACKNOWLEDGED',
  'ACTION_REJECTED',
  /** data = { name, status: 'ok' | 'failed', result?, error? } */
  'SIDE_EFFECT',
] as const;

export type AuditType = (typeof AUDIT_TYPES)[number];

export interface AuditEntry {
  id: string;
  /** Per claim, starting at 1, contiguous. */
  seq: number;
  claimId: string;
  type: AuditType;
  /** ISO, from the engine's Clock. */
  timestamp: string;
  fromState: StateId | null;
  /** For TRANSITION_REJECTED: the requested state. */
  toState: StateId | null;
  transitionId?: string;
  triggeredBy: { userId: string; role: Role };
  /** Always set: reasonField value, then notes, then the transition/action description. */
  reason: string;
  notes?: string;
  /** Payload, or { code, errors, payload } when rejected. */
  data?: Record<string, unknown>;
}

/**
 * id and seq are assigned by the store. claimId too: the store knows it from the
 * locked claim, and on createClaim the id doesn't exist until the store inserts the claim.
 */
export type NewAuditEntry = Omit<AuditEntry, 'id' | 'seq' | 'claimId'>;
