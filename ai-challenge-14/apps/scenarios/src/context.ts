import {
  isWorkflowError,
  type AuditEntry,
  type Claim,
  type CreateClaimInput,
  type ErrorCode,
  type FakeClock,
  type StateId,
  type SystemTaskSkipReason,
  type UserConfig,
  type WorkflowEngine,
  type WorkflowStore,
} from '@claims/engine';

export interface StepRecord {
  n: number;
  /** Fake clock time the request ran at. */
  at: string;
  actor: string;
  action: string;
  expected: string;
  actual: string;
  passed: boolean;
}

export interface CheckRecord {
  label: string;
  passed: boolean;
  detail?: string;
}

/** message is matched as a substring of the actual error message. */
export interface ErrorExpectation {
  code: ErrorCode;
  message: string;
}

export type SystemTaskExpectation = { processed: StateId } | { skipped: SystemTaskSkipReason };

export interface TransitionCall {
  userId: string;
  to: StateId;
  payload?: Record<string, unknown>;
  notes?: string;
}

export type CallOutcome = { ok: true; claim: Claim } | { ok: false; code: string; message: string };

export interface ScenarioDeps {
  engine: WorkflowEngine;
  store: WorkflowStore;
  clock: FakeClock;
  users: readonly UserConfig[];
}

/** Every request is spaced by this much fake time, so audit timestamps read as a timeline. */
const STEP_GAP = { minutes: 1 };

/** Runs one scenario's requests against the engine and records what was expected and what happened. */
export class ScenarioContext {
  readonly steps: StepRecord[] = [];
  readonly checks: CheckRecord[] = [];
  readonly logs: string[] = [];
  private claimIdValue: string | undefined;
  private printedLogs = 0;
  private readonly roles: Map<string, string>;

  constructor(private readonly deps: ScenarioDeps) {
    this.roles = new Map(deps.users.map((u) => [u.id, u.role]));
  }

  get claimId(): string {
    if (this.claimIdValue === undefined) throw new Error('Scenario has not created its claim yet');
    return this.claimIdValue;
  }

  get hasClaim(): boolean {
    return this.claimIdValue !== undefined;
  }

  now(): string {
    return this.deps.clock.now().toISOString();
  }

  async createClaim(userId: string, input: CreateClaimInput): Promise<Claim> {
    this.deps.clock.advance(STEP_GAP);
    const at = this.now();
    const action = `createClaim ${json(input)}`;
    try {
      const claim = await this.deps.engine.createClaim(userId, input);
      this.claimIdValue = claim.id;
      this.record(at, userId, action, `ok → SUBMITTED`, `ok → ${claim.status} (${claim.id}, version ${claim.version})`,
        claim.status === 'SUBMITTED');
      return claim;
    } catch (error) {
      this.record(at, userId, action, 'ok → SUBMITTED', describeError(error), false);
      throw error;
    }
  }

  /** Without expect, the transition must succeed and land in `to`. */
  async transition(call: TransitionCall, expect?: ErrorExpectation): Promise<CallOutcome> {
    this.deps.clock.advance(STEP_GAP);
    const at = this.now();
    const outcome = await this.call(call);
    this.recordTransition(at, call, outcome, expect ? matchesError(outcome, expect) : isOkIn(outcome, call.to),
      expect ? `${expect.code}: "${expect.message}"` : `ok → ${call.to}`);
    return outcome;
  }

  /**
   * Fires every call before awaiting any of them; each runs on its own pool connection, so the
   * claim's row lock decides the order. Exactly one must succeed; the rest must fail with `loserCode`.
   */
  async concurrently(calls: TransitionCall[], loserCode: ErrorCode): Promise<CallOutcome[]> {
    this.deps.clock.advance(STEP_GAP);
    const at = this.now();
    const outcomes = await Promise.all(calls.map((call) => this.call(call)));
    // Printed after all steps: they belong to whichever request won, not to the first one listed.
    const winnerLogs = this.logs.slice(this.printedLogs);
    this.printedLogs = this.logs.length;
    outcomes.forEach((outcome, i) => {
      const call = calls[i];
      const passed = isOkIn(outcome, call.to) || (!outcome.ok && outcome.code === loserCode);
      this.recordTransition(at, call, outcome, passed, `ok → ${call.to}, or ${loserCode} if the other request won`);
    });
    for (const line of winnerLogs) console.log(`       ${line}`);
    const winners = outcomes.filter((o) => o.ok).length;
    this.check(`Exactly one of ${calls.length} concurrent requests succeeded`, winners === 1, `${winners} succeeded`);
    return outcomes;
  }

  async runSystemTasks(userId: string, expect: SystemTaskExpectation): Promise<void> {
    this.deps.clock.advance(STEP_GAP);
    const at = this.now();
    const expected = 'processed' in expect ? `processed → ${expect.processed}` : `skipped (${expect.skipped})`;
    try {
      const result = await this.deps.engine.runSystemTasks(userId);
      const processed = result.processed.find((t) => t.claimId === this.claimId);
      const skipped = result.skipped.find((t) => t.claimId === this.claimId);
      let actual = `claim ${this.claimId} not picked up`;
      if (processed) actual = `processed ${processed.transitionId} → ${processed.to} (version ${processed.version})`;
      if (skipped) actual = `skipped ${skipped.transitionId} (${skipped.reason}): ${skipped.message}`;
      const passed =
        'processed' in expect ? processed?.to === expect.processed : skipped?.reason === expect.skipped;
      this.record(at, userId, 'runSystemTasks', expected, actual, passed);
    } catch (error) {
      this.record(at, userId, 'runSystemTasks', expected, describeError(error), false);
    }
  }

  /** Moves the fake clock only; no claim field is touched. */
  advanceClock(days: number): void {
    this.deps.clock.advance({ days });
    const at = this.now();
    this.steps.push({
      n: this.steps.length + 1,
      at,
      actor: '—',
      action: `FakeClock.advance({ days: ${days} })`,
      expected: '—',
      actual: `clock is now ${at}`,
      passed: true,
    });
  }

  check(label: string, passed: boolean, detail?: string): void {
    this.checks.push({ label, passed, ...(detail !== undefined && { detail }) });
  }

  /** Fresh reads from the store, not the engine's return values. */
  async readBack(): Promise<{ claim: Claim | null; audit: AuditEntry[] }> {
    const [claim, audit] = await Promise.all([
      this.deps.store.getClaim(this.claimId),
      this.deps.store.listAuditByClaim(this.claimId),
    ]);
    return { claim, audit };
  }

  private async call({ userId, to, payload, notes }: TransitionCall): Promise<CallOutcome> {
    try {
      const { claim } = await this.deps.engine.transition(this.claimId, userId, { to, payload, notes });
      return { ok: true, claim };
    } catch (error) {
      if (isWorkflowError(error)) return { ok: false, code: error.code, message: error.message };
      return { ok: false, code: 'UNEXPECTED', message: error instanceof Error ? error.message : String(error) };
    }
  }

  private recordTransition(at: string, call: TransitionCall, outcome: CallOutcome, passed: boolean, expected: string): void {
    const parts = [`transition → ${call.to}`];
    if (call.payload && Object.keys(call.payload).length > 0) parts.push(json(call.payload));
    if (call.notes) parts.push(`notes: "${call.notes}"`);
    const actual = outcome.ok
      ? `ok → ${outcome.claim.status} (version ${outcome.claim.version})`
      : `${outcome.code}: "${outcome.message}"`;
    this.record(at, call.userId, parts.join(' '), expected, actual, passed);
  }

  private record(at: string, userId: string, action: string, expected: string, actual: string, passed: boolean): void {
    const step: StepRecord = {
      n: this.steps.length + 1,
      at,
      actor: `${userId} (${this.roles.get(userId) ?? 'unknown'})`,
      action,
      expected,
      actual,
      passed,
    };
    this.steps.push(step);
    console.log(`  ${passed ? 'PASS' : 'FAIL'} ${step.n}. ${step.actor} ${action}\n       ${actual}`);
    for (const line of this.logs.slice(this.printedLogs)) console.log(`       ${line}`);
    this.printedLogs = this.logs.length;
  }
}

const json = (value: unknown) => JSON.stringify(value);

const isOkIn = (outcome: CallOutcome, status: StateId) => outcome.ok && outcome.claim.status === status;

const matchesError = (outcome: CallOutcome, expect: ErrorExpectation) =>
  !outcome.ok && outcome.code === expect.code && outcome.message.includes(expect.message);

function describeError(error: unknown): string {
  if (isWorkflowError(error)) return `${error.code}: "${error.message}"`;
  return `UNEXPECTED: ${error instanceof Error ? error.message : String(error)}`;
}
