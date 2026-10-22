import { randomUUID } from 'node:crypto';
import {
  claimBusy,
  claimNotFound,
  deepFreeze,
  type AuditEntry,
  type AuditType,
  type Claim,
  type ClaimTx,
  type NewAuditEntry,
  type NewClaim,
  type StateId,
  type WorkflowStore,
} from '@claims/engine';
import type { ClientBase, Pool, PoolClient } from 'pg';

export interface PostgresStoreOptions {
  /** How long withClaim waits for a claim's row lock before CLAIM_BUSY. Defaults to 5000. */
  lockTimeoutMs?: number;
}

/** SQLSTATE lock_not_available, raised when lock_timeout expires. */
const LOCK_NOT_AVAILABLE = '55P03';

const CLAIM_COLUMNS =
  'id, member_id, status, state_entered_at, amount, policy_limit, created_at, created_by, version, data';
const AUDIT_COLUMNS =
  'id, claim_id, seq, type, timestamp, from_state, to_state, transition_id, triggered_by_user_id, triggered_by_role, reason, notes, data';

/** Ids are 'c-' || nextval('claim_number_seq'), so their number is creation order. */
const claimOrder = (column: string) => `substring(${column} from 3)::bigint`;

interface ClaimRow {
  id: string;
  member_id: string;
  status: string;
  state_entered_at: Date;
  amount: string;
  policy_limit: string;
  created_at: Date;
  created_by: string;
  version: number;
  data: Record<string, unknown>;
}

interface AuditRow {
  id: string;
  claim_id: string;
  seq: number;
  type: string;
  timestamp: Date;
  from_state: string | null;
  to_state: string | null;
  transition_id: string | null;
  triggered_by_user_id: string;
  triggered_by_role: string;
  reason: string;
  notes: string | null;
  data: Record<string, unknown> | null;
}

function toClaim(row: ClaimRow): Claim {
  return {
    id: row.id,
    memberId: row.member_id,
    status: row.status,
    stateEnteredAt: row.state_entered_at.toISOString(),
    amount: Number(row.amount),
    policyLimit: Number(row.policy_limit),
    createdAt: row.created_at.toISOString(),
    createdBy: row.created_by,
    version: row.version,
    data: row.data,
  };
}

function toAuditEntry(row: AuditRow): AuditEntry {
  const entry: AuditEntry = {
    id: row.id,
    seq: row.seq,
    claimId: row.claim_id,
    type: row.type as AuditType,
    timestamp: row.timestamp.toISOString(),
    fromState: row.from_state,
    toState: row.to_state,
    triggeredBy: { userId: row.triggered_by_user_id, role: row.triggered_by_role },
    reason: row.reason,
  };
  if (row.transition_id !== null) entry.transitionId = row.transition_id;
  if (row.notes !== null) entry.notes = row.notes;
  if (row.data !== null) entry.data = row.data;
  return deepFreeze(entry);
}

/** jsonb parameters are passed as text: pg would turn a top-level array into a Postgres array. */
const json = (value: unknown) => (value === undefined ? null : JSON.stringify(value));

/** seq is max + 1; only correct while the caller holds the claim's row lock (or just inserted it). */
async function insertAudit(client: ClientBase, claimId: string, entry: NewAuditEntry): Promise<AuditEntry> {
  const { rows } = await client.query<AuditRow>(
    `INSERT INTO audit_entries (${AUDIT_COLUMNS})
     VALUES ($1, $2, (SELECT coalesce(max(seq), 0) + 1 FROM audit_entries WHERE claim_id = $2),
             $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${AUDIT_COLUMNS}`,
    [
      randomUUID(),
      claimId,
      entry.type,
      entry.timestamp,
      entry.fromState,
      entry.toState,
      entry.transitionId ?? null,
      entry.triggeredBy.userId,
      entry.triggeredBy.role,
      entry.reason,
      entry.notes ?? null,
      json(entry.data),
    ],
  );
  return toAuditEntry(rows[0]);
}

function isLockTimeout(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === LOCK_NOT_AVAILABLE;
}

/**
 * WorkflowStore on PostgreSQL. Each withClaim/tryWithClaim is one READ COMMITTED
 * transaction that starts by locking the claim row. The pool is owned by the caller.
 */
export class PostgresWorkflowStore implements WorkflowStore {
  private readonly lockTimeoutMs: number;

  constructor(
    private readonly pool: Pool,
    options: PostgresStoreOptions = {},
  ) {
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  }

  async withClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T> {
    return this.transaction(async (client) => {
      await client.query(`SELECT set_config('lock_timeout', $1, true)`, [`${this.lockTimeoutMs}ms`]);
      let rows: ClaimRow[];
      try {
        ({ rows } = await client.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE`, [
          claimId,
        ]));
      } catch (error) {
        if (isLockTimeout(error)) throw claimBusy(claimId);
        throw error;
      }
      if (rows.length === 0) throw claimNotFound(claimId);
      return runClaimTx(client, toClaim(rows[0]), fn);
    });
  }

  async tryWithClaim<T>(claimId: string, fn: (tx: ClaimTx) => Promise<T>): Promise<T | null> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ClaimRow>(
        `SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1 FOR UPDATE SKIP LOCKED`,
        [claimId],
      );
      if (rows.length > 0) return runClaimTx(client, toClaim(rows[0]), fn);
      // No row means either locked or missing.
      const exists = await client.query('SELECT 1 FROM claims WHERE id = $1', [claimId]);
      if (exists.rowCount === 0) throw claimNotFound(claimId);
      return null;
    });
  }

  async createClaim(claim: NewClaim, audit: NewAuditEntry): Promise<Claim> {
    return this.transaction(async (client) => {
      const { rows } = await client.query<ClaimRow>(
        `INSERT INTO claims (${CLAIM_COLUMNS})
         VALUES ('c-' || nextval('claim_number_seq'), $1, $2, $3, $4, $5, $6, $7, 1, $8)
         RETURNING ${CLAIM_COLUMNS}`,
        [
          claim.memberId,
          claim.status,
          claim.stateEnteredAt,
          claim.amount,
          claim.policyLimit,
          claim.createdAt,
          claim.createdBy,
          json(claim.data),
        ],
      );
      const created = toClaim(rows[0]);
      await insertAudit(client, created.id, audit);
      return created;
    });
  }

  async getClaim(id: string): Promise<Claim | null> {
    const { rows } = await this.pool.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM claims WHERE id = $1`, [id]);
    return rows.length > 0 ? toClaim(rows[0]) : null;
  }

  async listClaims(filter: { status?: StateId[] } = {}): Promise<Claim[]> {
    const { status } = filter;
    const { rows } = status
      ? await this.pool.query<ClaimRow>(
          `SELECT ${CLAIM_COLUMNS} FROM claims WHERE status = ANY($1::text[]) ORDER BY ${claimOrder('id')}`,
          [status],
        )
      : await this.pool.query<ClaimRow>(`SELECT ${CLAIM_COLUMNS} FROM claims ORDER BY ${claimOrder('id')}`);
    return rows.map(toClaim);
  }

  async listAuditByClaim(claimId: string): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_entries WHERE claim_id = $1 ORDER BY seq`,
      [claimId],
    );
    return rows.map(toAuditEntry);
  }

  async listAllAudit(): Promise<AuditEntry[]> {
    const { rows } = await this.pool.query<AuditRow>(
      `SELECT ${AUDIT_COLUMNS} FROM audit_entries ORDER BY ${claimOrder('claim_id')}, seq`,
    );
    return rows.map(toAuditEntry);
  }

  private async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      const commit = await client.query('COMMIT');
      // COMMIT of an aborted transaction rolls back without raising.
      if (commit.command === 'ROLLBACK') throw new Error('Transaction was aborted by an earlier error and rolled back');
      client.release();
      return result;
    } catch (error) {
      try {
        await client.query('ROLLBACK');
        client.release();
      } catch (rollbackError) {
        client.release(rollbackError as Error);
      }
      throw error;
    }
  }
}

async function runClaimTx<T>(client: ClientBase, claim: Claim, fn: (tx: ClaimTx) => Promise<T>): Promise<T> {
  const tx = new PostgresClaimTx(client, claim);
  try {
    return await fn(tx);
  } finally {
    tx.close();
  }
}

class PostgresClaimTx implements ClaimTx {
  readonly claim: Claim;
  private readonly claimId: string;
  private readonly baseVersion: number;
  private closed = false;

  constructor(
    private readonly client: ClientBase,
    locked: Claim,
  ) {
    this.claimId = locked.id;
    this.baseVersion = locked.version;
    this.claim = structuredClone(locked);
  }

  async countSuccessfulTransitions(transitionId: string): Promise<number> {
    this.assertOpen();
    const { rows } = await this.client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM audit_entries
       WHERE claim_id = $1 AND type = 'TRANSITION' AND transition_id = $2`,
      [this.claimId, transitionId],
    );
    return rows[0].count;
  }

  async saveClaim(next: Claim): Promise<void> {
    this.assertOpen();
    if (next.id !== this.claimId) {
      throw new Error(`saveClaim got claim ${next.id} inside the transaction of claim ${this.claimId}`);
    }
    await this.client.query(
      `UPDATE claims SET member_id = $2, status = $3, state_entered_at = $4, amount = $5, policy_limit = $6,
                         created_at = $7, created_by = $8, version = $9, data = $10
       WHERE id = $1`,
      [
        this.claimId,
        next.memberId,
        next.status,
        next.stateEnteredAt,
        next.amount,
        next.policyLimit,
        next.createdAt,
        next.createdBy,
        this.baseVersion + 1,
        json(next.data),
      ],
    );
  }

  async appendAudit(entry: NewAuditEntry): Promise<AuditEntry> {
    this.assertOpen();
    return insertAudit(this.client, this.claimId, entry);
  }

  close(): void {
    this.closed = true;
  }

  private assertOpen(): void {
    if (this.closed) throw new Error(`Transaction on claim ${this.claimId} is already finished`);
  }
}
