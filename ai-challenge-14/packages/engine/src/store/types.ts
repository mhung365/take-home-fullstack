import type { AuditEntry, Claim, NewAuditEntry, NewClaim, StateId } from '../model/types';

/**
 * Persistence for claims and their audit trail. Only the engine writes through it.
 * Everything returned is a copy; audit entries are additionally deep-frozen.
 */
export interface WorkflowStore {
  /**
   * Runs fn in a transaction holding an exclusive lock on the claim.
   * Throws WorkflowError CLAIM_NOT_FOUND if the claim doesn't exist, CLAIM_BUSY if the
   * lock wait exceeds lock_timeout. If fn throws, everything written through tx is
   * discarded (including appended audit) and the error is rethrown; so a rejection that
   * must be audited has to append and return normally, not throw.
   */
  withClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T>;

  /**
   * Like withClaim, but resolves to null without waiting if the claim is locked.
   * Used by runSystemTasks.
   */
  tryWithClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T | null>;

  /**
   * Inserts the claim with a new id and version 1, and the CLAIM_CREATED entry with
   * seq 1, in one transaction.
   */
  createClaim(claim: NewClaim, audit: NewAuditEntry): Promise<Claim>;

  /** Reads without locking. */
  getClaim(id: string): Promise<Claim | null>;

  /** In creation order. */
  listClaims(filter?: { status?: StateId[] }): Promise<Claim[]>;

  /** Ordered by seq. */
  listAuditByClaim(claimId: string): Promise<AuditEntry[]>;

  /** Ordered by claim creation order, then seq. */
  listAllAudit(): Promise<AuditEntry[]>;
}

export interface ClaimTx {
  /**
   * The claim as read under the lock. A copy: mutating it changes nothing, and it is
   * not refreshed by saveClaim.
   */
  readonly claim: Claim;

  /** Counts successful TRANSITION entries of this claim, including ones appended in this tx. */
  countSuccessfulTransitions(transitionId: string): Promise<number>;

  /**
   * Stores next as the claim's new state with version = claim.version + 1; next.version
   * is ignored. Throws if next.id differs from the locked claim. Calling it again in the
   * same tx overwrites the previous call; the version is still bumped only once.
   */
  saveClaim(next: Claim): Promise<void>;

  /** Assigns id, seq (next for this claim) and claimId; returns the stored entry. */
  appendAudit(entry: NewAuditEntry): Promise<AuditEntry>;
}
