import { claimBusy, claimNotFound } from '../errors';
import type { AuditEntry, Claim, NewAuditEntry, NewClaim, StateId } from '../model/types';
import { KeyedMutex, type Release } from './keyed-mutex';
import type { ClaimTx, WorkflowStore } from './types';

export interface InMemoryStoreOptions {
  /** How long withClaim waits for a lock before CLAIM_BUSY. Defaults to 5000. */
  lockTimeoutMs?: number;
}

const clone = <T>(value: T): T => structuredClone(value);

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export class InMemoryWorkflowStore implements WorkflowStore {
  /** Insertion order is creation order; set() on an existing key keeps its position. */
  private readonly claims = new Map<string, Claim>();
  /** Entries are deep-frozen, so they can be shared with callers. */
  private readonly audit = new Map<string, AuditEntry[]>();
  private readonly mutex = new KeyedMutex();
  private readonly lockTimeoutMs: number;
  private claimCounter = 0;
  private auditCounter = 0;

  constructor(options: InMemoryStoreOptions = {}) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  }

  async withClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T> {
    this.assertExists(claimId);
    let release: Release;
    try {
      release = await this.mutex.acquire(claimId, this.lockTimeoutMs);
    } catch {
      throw claimBusy(claimId);
    }
    return this.run(claimId, release, fn);
  }

  async tryWithClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T | null> {
    this.assertExists(claimId);
    const release = this.mutex.tryAcquire(claimId);
    if (!release) return null;
    return this.run(claimId, release, fn);
  }

  async createClaim(claim: NewClaim, audit: NewAuditEntry): Promise<Claim> {
    const stored: Claim = { ...clone(claim), id: `c-${++this.claimCounter}`, version: 1 };
    this.claims.set(stored.id, stored);
    this.audit.set(stored.id, [this.toEntry(stored.id, 1, audit)]);
    return clone(stored);
  }

  async getClaim(id: string): Promise<Claim | null> {
    const claim = this.claims.get(id);
    return claim ? clone(claim) : null;
  }

  async listClaims(filter: { status?: StateId[] } = {}): Promise<Claim[]> {
    const { status } = filter;
    return [...this.claims.values()].filter((c) => !status || status.includes(c.status)).map(clone);
  }

  async listAuditByClaim(claimId: string): Promise<AuditEntry[]> {
    return [...(this.audit.get(claimId) ?? [])];
  }

  async listAllAudit(): Promise<AuditEntry[]> {
    return [...this.claims.keys()].flatMap((id) => this.audit.get(id) ?? []);
  }

  private assertExists(claimId: string): void {
    if (!this.claims.has(claimId)) throw claimNotFound(claimId);
  }

  private toEntry(claimId: string, seq: number, entry: NewAuditEntry): AuditEntry {
    return deepFreeze({ ...clone(entry), id: `a-${++this.auditCounter}`, seq, claimId });
  }

  private async run<T>(claimId: string, release: Release, fn: (tx: ClaimTx) => Promise<T>): Promise<T> {
    const tx = new InMemoryClaimTx(
      this.claims.get(claimId)!,
      this.audit.get(claimId)!,
      (seq, entry) => this.toEntry(claimId, seq, entry),
    );
    try {
      const result = await fn(tx);
      const { claim, entries } = tx.close();
      if (claim) this.claims.set(claimId, claim);
      this.audit.get(claimId)!.push(...entries);
      return result;
    } finally {
      tx.close();
      release();
    }
  }
}

class InMemoryClaimTx implements ClaimTx {
  readonly claim: Claim;
  private pendingClaim: Claim | null = null;
  private readonly pendingAudit: AuditEntry[] = [];
  private closed = false;

  constructor(
    private readonly base: Claim,
    private readonly committedAudit: readonly AuditEntry[],
    private readonly toEntry: (seq: number, entry: NewAuditEntry) => AuditEntry,
  ) {
    this.claim = clone(base);
  }

  async countSuccessfulTransitions(transitionId: string): Promise<number> {
    this.assertOpen();
    return [...this.committedAudit, ...this.pendingAudit].filter(
      (e) => e.type === 'TRANSITION' && e.transitionId === transitionId,
    ).length;
  }

  async saveClaim(next: Claim): Promise<void> {
    this.assertOpen();
    if (next.id !== this.base.id) {
      throw new Error(`saveClaim got claim ${next.id} inside the transaction of claim ${this.base.id}`);
    }
    this.pendingClaim = { ...clone(next), version: this.base.version + 1 };
  }

  async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
    this.assertOpen();
    const seq = this.committedAudit.length + this.pendingAudit.length + 1;
    const stored = this.toEntry(seq, entry);
    this.pendingAudit.push(stored);
    return stored;
  }

  /** Ends the transaction and returns what to commit. */
  close(): { claim: Claim | null; entries: AuditEntry[] } {
    this.closed = true;
    return { claim: this.pendingClaim, entries: this.pendingAudit };
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Transaction on claim ${this.base.id} is already finished`);
  }
}
