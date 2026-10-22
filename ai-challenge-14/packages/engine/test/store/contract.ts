import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isWorkflowError, type ErrorCode } from '../../src/errors';
import type { NewAuditEntry, NewClaim } from '../../src/model';
import type { ClaimTx, WorkflowStore } from '../../src/store';

export interface StoreContractOptions {
  /** How long withClaim waits for a lock before CLAIM_BUSY. */
  lockTimeoutMs: number;
}

export interface StoreUnderTest {
  store: WorkflowStore;
  dispose?(): Promise<void>;
}

/** Called before each test; must return an empty store. */
export type StoreFactory = (options: StoreContractOptions) => Promise<StoreUnderTest>;

const LOCK_TIMEOUT_MS = 500;

// Millisecond precision so timestamps round-trip through timestamptz unchanged.
const T0 = '2026-03-01T00:00:00.000Z';
const T1 = '2026-03-02T00:00:00.000Z';
const CLERK = { userId: 'u-clerk-1', role: 'document_clerk' };

function newClaim(overrides: Partial<NewClaim> = {}): NewClaim {
  return {
    memberId: 'm-1',
    status: 'SUBMITTED',
    stateEnteredAt: T0,
    amount: 1500.5,
    policyLimit: 10000,
    createdAt: T0,
    createdBy: CLERK.userId,
    data: { documents: ['claim_form', 'invoice'] },
    ...overrides,
  };
}

function createdEntry(): NewAuditEntry {
  return {
    type: 'CLAIM_CREATED',
    timestamp: T0,
    fromState: null,
    toState: 'SUBMITTED',
    triggeredBy: { ...CLERK },
    reason: 'Claim created',
    data: { documents: ['claim_form', 'invoice'] },
  };
}

function transitionEntry(transitionId: string, overrides: Partial<NewAuditEntry> = {}): NewAuditEntry {
  return {
    type: 'TRANSITION',
    timestamp: T1,
    fromState: 'SUBMITTED',
    toState: 'DOCUMENTS_VERIFIED',
    transitionId,
    triggeredBy: { ...CLERK },
    reason: 'Documents verified',
    notes: 'checked',
    data: { documents: ['claim_form', 'invoice', 'id_proof'] },
    ...overrides,
  };
}

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function expectCode(promise: Promise<unknown>, code: ErrorCode): Promise<void> {
  const error = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(isWorkflowError(error, code), `expected WorkflowError ${code}, got ${String(error)}`).toBe(true);
}

function expectDeepFrozen(value: unknown, path = 'entry'): void {
  if (value === null || typeof value !== 'object') return;
  expect(Object.isFrozen(value), `${path} is frozen`).toBe(true);
  for (const [key, child] of Object.entries(value)) expectDeepFrozen(child, `${path}.${key}`);
}

const documentsOf = (data: Record<string, unknown> | undefined) => data?.documents as string[];

export function runStoreContract(name: string, factory: StoreFactory): void {
  describe(`WorkflowStore contract: ${name}`, () => {
    let subject: StoreUnderTest;
    let store: WorkflowStore;

    beforeEach(async () => {
      subject = await factory({ lockTimeoutMs: LOCK_TIMEOUT_MS });
      store = subject.store;
    });

    afterEach(async () => {
      await subject.dispose?.();
    });

    const create = (overrides?: Partial<NewClaim>) => store.createClaim(newClaim(overrides), createdEntry());

    /** Holds the claim's lock until release() is called. */
    async function holdLock(claimId: string) {
      const acquired = deferred();
      const release = deferred();
      const done = store.withClaim(claimId, async () => {
        acquired.resolve();
        await release.promise;
      });
      await acquired.promise;
      return {
        release: async () => {
          release.resolve();
          await done;
        },
      };
    }

    describe('createClaim', () => {
      it('assigns id and version 1, and writes CLAIM_CREATED with seq 1', async () => {
        const input = newClaim();
        const claim = await store.createClaim(input, createdEntry());

        expect(claim).toEqual({ ...input, id: expect.any(String), version: 1 });
        expect(await store.getClaim(claim.id)).toEqual(claim);
        expect(await store.listAuditByClaim(claim.id)).toEqual([
          { ...createdEntry(), id: expect.any(String), seq: 1, claimId: claim.id },
        ]);
      });

      it('assigns distinct ids to concurrent creates, each with its own seq 1', async () => {
        const claims = await Promise.all(Array.from({ length: 10 }, () => create()));

        expect(new Set(claims.map((c) => c.id)).size).toBe(10);
        for (const claim of claims) {
          expect((await store.listAuditByClaim(claim.id)).map((e) => e.seq)).toEqual([1]);
        }
      });

      it('does not keep references to its inputs', async () => {
        const input = newClaim();
        const audit = createdEntry();
        const claim = await store.createClaim(input, audit);

        documentsOf(input.data).push('tampered');
        input.amount = 1;
        audit.triggeredBy.userId = 'u-tampered';
        documentsOf(audit.data).push('tampered');

        expect(await store.getClaim(claim.id)).toEqual({ ...newClaim(), id: claim.id, version: 1 });
        const [entry] = await store.listAuditByClaim(claim.id);
        expect(entry).toMatchObject({ triggeredBy: CLERK, data: createdEntry().data });
      });

      it('returns a copy', async () => {
        const claim = await create();
        documentsOf(claim.data).push('tampered');
        claim.status = 'CLOSED';

        expect(await store.getClaim(claim.id)).toEqual({ ...newClaim(), id: claim.id, version: 1 });
      });
    });

    describe('getClaim', () => {
      it('returns null for an unknown claim', async () => {
        expect(await store.getClaim('c-missing')).toBeNull();
      });

      it('returns a fresh deep copy on every call', async () => {
        const { id } = await create();
        const first = await store.getClaim(id);
        documentsOf(first!.data).push('tampered');
        delete first!.data.documents;
        first!.version = 42;

        expect(await store.getClaim(id)).toEqual({ ...newClaim(), id, version: 1 });
      });
    });

    describe('listClaims', () => {
      it('lists in creation order, also past ten claims', async () => {
        const ids: string[] = [];
        for (let i = 0; i < 11; i++) ids.push((await create({ memberId: `m-${i}` })).id);

        expect((await store.listClaims()).map((c) => c.id)).toEqual(ids);
      });

      it('filters by status', async () => {
        const a = await create();
        const b = await create();
        const c = await create();
        await store.withClaim(b.id, (tx) => tx.saveClaim({ ...tx.claim, status: 'APPROVED' }));

        expect((await store.listClaims({ status: ['APPROVED'] })).map((x) => x.id)).toEqual([b.id]);
        expect((await store.listClaims({ status: ['SUBMITTED'] })).map((x) => x.id)).toEqual([a.id, c.id]);
        expect((await store.listClaims({ status: ['SUBMITTED', 'APPROVED'] })).map((x) => x.id)).toEqual([
          a.id,
          b.id,
          c.id,
        ]);
      });

      it('returns copies', async () => {
        const { id } = await create();
        const [listed] = await store.listClaims();
        documentsOf(listed.data).push('tampered');

        expect(await store.getClaim(id)).toEqual({ ...newClaim(), id, version: 1 });
      });
    });

    describe('audit', () => {
      it('appendAudit assigns id, seq and claimId, and returns the stored entry', async () => {
        const { id } = await create();
        const appended = await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('verify')));

        expect(appended).toEqual({ ...transitionEntry('verify'), id: expect.any(String), seq: 2, claimId: id });
        const audit = await store.listAuditByClaim(id);
        expect(audit[1]).toEqual(appended);
        expect(audit[1].id).not.toBe(audit[0].id);
      });

      it('keeps seq contiguous across transactions', async () => {
        const { id } = await create();
        await store.withClaim(id, async (tx) => {
          await tx.appendAudit(transitionEntry('a'));
          await tx.appendAudit(transitionEntry('b'));
        });
        await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('c')));

        expect((await store.listAuditByClaim(id)).map((e) => [e.seq, e.transitionId])).toEqual([
          [1, undefined],
          [2, 'a'],
          [3, 'b'],
          [4, 'c'],
        ]);
      });

      it('returns no entries for an unknown claim', async () => {
        expect(await store.listAuditByClaim('c-missing')).toEqual([]);
      });

      it('listAllAudit orders by claim creation order, then seq', async () => {
        const a = await create();
        const b = await create();
        await store.withClaim(b.id, (tx) => tx.appendAudit(transitionEntry('b2')));
        await store.withClaim(a.id, (tx) => tx.appendAudit(transitionEntry('a2')));
        await store.withClaim(b.id, (tx) => tx.appendAudit(transitionEntry('b3')));
        await store.withClaim(a.id, (tx) => tx.appendAudit(transitionEntry('a3')));

        expect((await store.listAllAudit()).map((e) => [e.claimId, e.seq])).toEqual([
          [a.id, 1],
          [a.id, 2],
          [a.id, 3],
          [b.id, 1],
          [b.id, 2],
          [b.id, 3],
        ]);
      });

      it('returns deep-frozen entries', async () => {
        const { id } = await create();
        const appended = await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('verify')));

        expectDeepFrozen(appended);
        (await store.listAuditByClaim(id)).forEach((e) => expectDeepFrozen(e));
        (await store.listAllAudit()).forEach((e) => expectDeepFrozen(e));
      });

      it('rejects assigning, deleting and pushing on returned entries, and the stored entry is unchanged', async () => {
        const { id } = await create();
        await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('verify')));
        const entry = (await store.listAuditByClaim(id))[1];

        expect(() => {
          (entry as { reason: string }).reason = 'tampered';
        }).toThrow(TypeError);
        expect(() => {
          delete (entry as { notes?: string }).notes;
        }).toThrow(TypeError);
        expect(() => {
          entry.triggeredBy.role = 'admin';
        }).toThrow(TypeError);
        expect(() => documentsOf(entry.data).push('tampered')).toThrow(TypeError);

        expect((await store.listAuditByClaim(id))[1]).toEqual({
          ...transitionEntry('verify'),
          id: entry.id,
          seq: 2,
          claimId: id,
        });
      });

      it('returns a new array from every list call', async () => {
        const { id } = await create();
        const byClaim = await store.listAuditByClaim(id);
        const all = await store.listAllAudit();
        byClaim.length = 0;
        all.length = 0;

        expect(await store.listAuditByClaim(id)).toHaveLength(1);
        expect(await store.listAllAudit()).toHaveLength(1);
      });

      it('does not keep a reference to the appended entry', async () => {
        const { id } = await create();
        const input = transitionEntry('verify');
        await store.withClaim(id, (tx) => tx.appendAudit(input));
        input.reason = 'tampered';
        documentsOf(input.data).push('tampered');

        expect((await store.listAuditByClaim(id))[1]).toMatchObject(transitionEntry('verify'));
      });
    });

    describe('withClaim', () => {
      it('throws CLAIM_NOT_FOUND for an unknown claim without calling fn', async () => {
        let called = false;
        await expectCode(
          store.withClaim('c-missing', async () => {
            called = true;
          }),
          'CLAIM_NOT_FOUND',
        );
        expect(called).toBe(false);
      });

      it("resolves to fn's return value", async () => {
        const { id } = await create();
        expect(await store.withClaim(id, async () => ({ ok: true }))).toEqual({ ok: true });
      });

      it('exposes the stored claim as tx.claim; mutating it changes nothing', async () => {
        const claim = await create();
        await store.withClaim(claim.id, async (tx) => {
          expect(tx.claim).toEqual(claim);
          tx.claim.status = 'CLOSED';
          documentsOf(tx.claim.data).push('tampered');
        });

        expect(await store.getClaim(claim.id)).toEqual(claim);
      });

      it('saveClaim stores next with version + 1, ignoring next.version', async () => {
        const claim = await create();
        await store.withClaim(claim.id, (tx) =>
          tx.saveClaim({
            ...tx.claim,
            status: 'DOCUMENTS_VERIFIED',
            stateEnteredAt: T1,
            data: { ...tx.claim.data, verifiedBy: 'u-clerk-1' },
            version: 99,
          }),
        );

        expect(await store.getClaim(claim.id)).toEqual({
          ...claim,
          status: 'DOCUMENTS_VERIFIED',
          stateEnteredAt: T1,
          data: { ...claim.data, verifiedBy: 'u-clerk-1' },
          version: 2,
        });
      });

      it('saveClaim twice in one tx: the last call wins and version is bumped once', async () => {
        const claim = await create();
        await store.withClaim(claim.id, async (tx) => {
          await tx.saveClaim({ ...tx.claim, status: 'DOCUMENTS_VERIFIED', data: { first: true } });
          await tx.saveClaim({ ...tx.claim, status: 'UNDER_ASSESSMENT', data: { second: true } });
        });

        expect(await store.getClaim(claim.id)).toEqual({
          ...claim,
          status: 'UNDER_ASSESSMENT',
          data: { second: true },
          version: 2,
        });
      });

      it('does not refresh tx.claim after saveClaim', async () => {
        const claim = await create();
        await store.withClaim(claim.id, async (tx) => {
          await tx.saveClaim({ ...tx.claim, status: 'DOCUMENTS_VERIFIED' });
          expect(tx.claim).toEqual(claim);
        });
      });

      it('does not keep a reference to the saved claim', async () => {
        const claim = await create();
        await store.withClaim(claim.id, async (tx) => {
          const next = { ...tx.claim, status: 'DOCUMENTS_VERIFIED', data: { documents: ['claim_form'] } };
          await tx.saveClaim(next);
          next.status = 'CLOSED';
          documentsOf(next.data).push('tampered');
        });

        expect(await store.getClaim(claim.id)).toMatchObject({
          status: 'DOCUMENTS_VERIFIED',
          data: { documents: ['claim_form'] },
        });
      });

      it('saveClaim throws when next.id is not the locked claim', async () => {
        const claim = await create();
        const other = await create({ memberId: 'm-2' });

        await expect(store.withClaim(claim.id, (tx) => tx.saveClaim({ ...other, status: 'CLOSED' }))).rejects.toThrow();
        expect(await store.getClaim(claim.id)).toEqual(claim);
        expect(await store.getClaim(other.id)).toEqual(other);
      });

      it('commits nothing when fn throws, and rethrows the same error', async () => {
        const claim = await create();
        const boom = new Error('boom');

        await expect(
          store.withClaim(claim.id, async (tx) => {
            await tx.saveClaim({ ...tx.claim, status: 'CLOSED' });
            await tx.appendAudit(transitionEntry('verify'));
            throw boom;
          }),
        ).rejects.toBe(boom);

        expect(await store.getClaim(claim.id)).toEqual(claim);
        expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
      });

      it('releases the lock when fn throws, without consuming seq', async () => {
        const { id } = await create();
        await expect(
          store.withClaim(id, async (tx) => {
            await tx.appendAudit(transitionEntry('lost'));
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');

        expect(await store.tryWithClaim(id, async () => 'free')).toBe('free');
        const appended = await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('kept')));
        expect(appended.seq).toBe(2);
      });
    });

    describe('countSuccessfulTransitions', () => {
      it('counts only TRANSITION entries of this claim with the given transitionId', async () => {
        const a = await create();
        const b = await create();
        await store.withClaim(a.id, async (tx) => {
          await tx.appendAudit(transitionEntry('request_info'));
          await tx.appendAudit({ ...transitionEntry('request_info'), type: 'SIDE_EFFECT' });
          await tx.appendAudit(transitionEntry('request_info'));
          await tx.appendAudit({ ...transitionEntry('request_info'), type: 'TRANSITION_REJECTED' });
          await tx.appendAudit(transitionEntry('verify'));
        });
        await store.withClaim(b.id, (tx) => tx.appendAudit(transitionEntry('request_info')));

        await store.withClaim(a.id, async (tx) => {
          expect(await tx.countSuccessfulTransitions('request_info')).toBe(2);
          expect(await tx.countSuccessfulTransitions('verify')).toBe(1);
          expect(await tx.countSuccessfulTransitions('never')).toBe(0);
        });
      });

      it('includes entries appended earlier in the same tx', async () => {
        const { id } = await create();
        await store.withClaim(id, async (tx) => {
          expect(await tx.countSuccessfulTransitions('request_info')).toBe(0);
          await tx.appendAudit(transitionEntry('request_info'));
          expect(await tx.countSuccessfulTransitions('request_info')).toBe(1);
        });
      });
    });

    describe('locking', () => {
      it('serializes transactions on the same claim; the second sees the first commit', async () => {
        const { id } = await create();
        const firstAcquired = deferred();
        const releaseFirst = deferred();
        const first = store.withClaim(id, async (tx) => {
          firstAcquired.resolve();
          await releaseFirst.promise;
          await tx.saveClaim({ ...tx.claim, status: 'DOCUMENTS_VERIFIED' });
          await tx.appendAudit(transitionEntry('verify'));
        });
        await firstAcquired.promise;

        let secondStarted = false;
        const second = store.withClaim(id, async (tx) => {
          secondStarted = true;
          return {
            version: tx.claim.version,
            status: tx.claim.status,
            verified: await tx.countSuccessfulTransitions('verify'),
          };
        });
        await sleep(LOCK_TIMEOUT_MS / 5);
        expect(secondStarted).toBe(false);

        releaseFirst.resolve();
        await first;
        expect(await second).toEqual({ version: 2, status: 'DOCUMENTS_VERIFIED', verified: 1 });
      });

      it('does not block transactions on other claims', async () => {
        const a = await create();
        const b = await create();
        const lock = await holdLock(a.id);
        try {
          expect(await store.withClaim(b.id, async () => 'b done')).toBe('b done');
          expect(await store.tryWithClaim(b.id, async () => 'b free')).toBe('b free');
        } finally {
          await lock.release();
        }
      });

      it('throws CLAIM_BUSY when the lock is held longer than lockTimeoutMs; the timed-out fn never runs', async () => {
        const { id } = await create();
        const lock = await holdLock(id);
        let called = false;
        try {
          await expectCode(
            store.withClaim(id, async (tx) => {
              called = true;
              await tx.appendAudit(transitionEntry('late'));
            }),
            'CLAIM_BUSY',
          );
        } finally {
          await lock.release();
        }

        // A waiter left in the queue after timing out would run before this one.
        const appended = await store.withClaim(id, (tx) => tx.appendAudit(transitionEntry('after')));

        expect(called).toBe(false);
        expect(appended.seq).toBe(2);
        expect((await store.listAuditByClaim(id)).map((e) => e.transitionId)).toEqual([undefined, 'after']);
        expect(await store.tryWithClaim(id, async () => 'free')).toBe('free');
      });

      it('rejects using tx after fn has finished', async () => {
        const claim = await create();
        const committedTx = await store.withClaim(claim.id, async (tx) => tx);
        let failedTx: ClaimTx | undefined;
        await expect(
          store.withClaim(claim.id, async (tx) => {
            failedTx = tx;
            throw new Error('boom');
          }),
        ).rejects.toThrow('boom');
        const triedTx = await store.tryWithClaim(claim.id, async (tx) => tx);

        for (const tx of [committedTx, failedTx!, triedTx!]) {
          await expect(tx.saveClaim({ ...claim, status: 'CLOSED' })).rejects.toThrow();
          await expect(tx.appendAudit(transitionEntry('late'))).rejects.toThrow();
          await expect(tx.countSuccessfulTransitions('late')).rejects.toThrow();
        }

        expect(await store.getClaim(claim.id)).toEqual(claim);
        expect(await store.listAuditByClaim(claim.id)).toHaveLength(1);
      });

      it('tryWithClaim resolves to null without waiting or calling fn while the claim is locked', async () => {
        const { id } = await create();
        const lock = await holdLock(id);
        let called = false;
        try {
          const startedAt = Date.now();
          const result = await store.tryWithClaim(id, async () => {
            called = true;
            return 'ran';
          });
          expect(result).toBeNull();
          expect(Date.now() - startedAt).toBeLessThan(LOCK_TIMEOUT_MS);
        } finally {
          await lock.release();
        }
        expect(called).toBe(false);
      });

      it('tryWithClaim commits like withClaim when the claim is free', async () => {
        const claim = await create();
        const result = await store.tryWithClaim(claim.id, async (tx) => {
          await tx.saveClaim({ ...tx.claim, status: 'CLOSED' });
          return 'closed';
        });

        expect(result).toBe('closed');
        expect(await store.getClaim(claim.id)).toEqual({ ...claim, status: 'CLOSED', version: 2 });
      });

      it('tryWithClaim throws CLAIM_NOT_FOUND for an unknown claim', async () => {
        await expectCode(
          store.tryWithClaim('c-missing', async () => 'ran'),
          'CLAIM_NOT_FOUND',
        );
      });

      it('keeps seq contiguous and version exact under concurrent writers', async () => {
        const { id } = await create();
        const writers = 10;
        await Promise.all(
          Array.from({ length: writers }, (_, i) =>
            store.withClaim(id, async (tx) => {
              await tx.appendAudit(transitionEntry(`w${i}`));
              await tx.saveClaim({ ...tx.claim });
            }),
          ),
        );

        expect((await store.listAuditByClaim(id)).map((e) => e.seq)).toEqual(
          Array.from({ length: writers + 1 }, (_, i) => i + 1),
        );
        expect((await store.getClaim(id))!.version).toBe(writers + 1);
      });
    });
  });
}
