# Claims Workflow Orchestrator

A state-machine workflow engine for the lifecycle of an insurance claim. States, transitions, roles, preconditions, side effects and loop limits are all declared in [`config/claims-workflow.json`](config/claims-workflow.json); adding a state or transition needs no code change.

- Brief: [`BRIEF.md`](BRIEF.md)
- Detailed design (Vietnamese): [`DESIGN.md`](DESIGN.md)

## Run locally

Requires Docker, Node ≥ 20.12 and pnpm 9.

```bash
docker compose up -d postgres   # PostgreSQL 16 with three databases: claims, claims_test, claims_scenarios
cp .env.example .env            # DATABASE_URL, DB_LOCK_TIMEOUT_MS, DB_POOL_MAX, DEMO_MODE, PORT
pnpm install
pnpm db:migrate                 # apply migrations to the claims database
pnpm dev                        # API on http://localhost:3000, web UI on http://localhost:5173
```

Open http://localhost:5173 and pick a user in the top bar (switching user switches role). Create a claim as `Alice (Clerk)`, then move it through the transitions. With `DEMO_MODE=true`, the System panel has **Advance clock** to show the 30-day appeal period expiring, and **Run system tasks** (as user `System`) to close rejected claims.

Other commands:

| Command | What it does | Needs Docker |
|---|---|---|
| `pnpm test` | 211 unit tests: engine on the in-memory store (cases 1–25) | no |
| `pnpm test:integration` | 49 tests on real PostgreSQL: store contract, concurrency, append-only audit (cases 26–32) | yes |
| `pnpm scenarios` | Runs 8 scenarios on the `claims_scenarios` database and writes `docs/scenario-results.md` and `docs/audit-output.json` | yes |
| `pnpm config-diff` | Generates `docs/config-diff.md` from the diff `claims-workflow.json` → `examples/with-escalation.json`, plus a trial run | no |

`docker compose down -v` deletes all data so you can start over.

## Layout

| Directory | Contents |
|---|---|
| [`packages/engine`](packages/engine) | Plain TypeScript, no NestJS: config loading and validation, rules, side effects, `WorkflowEngine`, the `WorkflowStore` interface and an in-memory store |
| [`packages/store-postgres`](packages/store-postgres) | `WorkflowStore` on PostgreSQL (`pg`, plain SQL), migrations, triggers that block audit updates and deletes |
| [`apps/api`](apps/api) | NestJS: `X-User-Id` guard, controllers, error-to-HTTP mapping |
| [`apps/web`](apps/web) | React + Vite |
| [`apps/scenarios`](apps/scenarios) | `pnpm scenarios` and `pnpm config-diff` |
| [`config`](config) | State machine and mock users |
| [`examples`](examples) | Extended config with an `ESCALATED` state |
| [`docs`](docs) | Scenario results, audit output, config diff |

## Evaluation criteria and evidence

Case numbers (e.g. "case 5") refer to the numbered list in [DESIGN.md section 10](DESIGN.md#10-test). Each criterion links to automated tests, scenarios run on PostgreSQL, and the code that implements it.

### 1. All 5 test scenarios produce correct results

[`docs/scenario-results.md`](docs/scenario-results.md): **8/8 scenarios pass**. Scenarios 1–5 are the five from the brief. Each one has a table of requests with expected and actual outcomes, checks on data read back from the database, and the audit trail.

| Brief scenario | Scenario | Automated test |
|---|---|---|
| Happy path | [1](docs/scenario-results.md#scenario-1) | [case 1](packages/engine/test/engine/cases.test.ts#L35) |
| Rejection path | [2](docs/scenario-results.md#scenario-2) | [case 2](packages/engine/test/engine/cases.test.ts#L171) (member acknowledged), [case 3](packages/engine/test/engine/cases.test.ts#L210) (appeal period expired) |
| Request more info loop | [3](docs/scenario-results.md#scenario-3) | [case 4](packages/engine/test/engine/cases.test.ts#L254) |
| Invalid transition | [4](docs/scenario-results.md#scenario-4) | [case 5](packages/engine/test/engine/transition.test.ts#L379) |
| Unauthorized role | [5](docs/scenario-results.md#scenario-5) | [case 15](packages/engine/test/engine/transition.test.ts#L406) |

Scenario definitions: [`apps/scenarios/src/scenarios.ts`](apps/scenarios/src/scenarios.ts).

### 2. Invalid transitions are rejected with specific error messages

The message distinguishes three cases (no such edge, terminal state, unknown state) and lists the valid transitions with the role each needs, e.g. `Cannot transition SUBMITTED → APPROVED. Allowed from SUBMITTED: DOCUMENTS_VERIFIED (document_clerk)`.

- Code: `TransitionIndex.invalidTransition` in [`packages/engine/src/engine/transition.ts`](packages/engine/src/engine/transition.ts#L43); every error code is in [`packages/engine/src/errors.ts`](packages/engine/src/errors.ts) (table with HTTP statuses in [DESIGN.md section 7](DESIGN.md#7-mã-lỗi)).
- Tests: [case 5](packages/engine/test/engine/transition.test.ts#L379) (no such edge), [case 6](packages/engine/test/engine/transition.test.ts#L390) (from a terminal state, to an unknown state), [case 7](packages/engine/test/engine/transition.test.ts#L456) (a rejected transition leaves the claim unchanged and is audited), [case 14](packages/engine/test/engine/transition.test.ts#L420) (payload field outside `inputs`).
- Scenario: [4](docs/scenario-results.md#scenario-4).

### 3. Preconditions are enforced

- Code: the rules in [`packages/engine/src/rules/builtins.ts`](packages/engine/src/rules/builtins.ts), evaluated as an `all`/`any`/`not` tree in [`rules/evaluate.ts`](packages/engine/src/rules/evaluate.ts); preconditions are declared in [`config/claims-workflow.json`](config/claims-workflow.json).
- Tests: [case 8](packages/engine/test/engine/transition.test.ts#L481) (missing documents), [case 9](packages/engine/test/engine/transition.test.ts#L456) (amount over the policy limit), [case 10](packages/engine/test/engine/transition.test.ts#L504) (reject without a reason), [case 11](packages/engine/test/engine/transition.test.ts#L519) (`info_received` with nothing new), [case 12](packages/engine/test/engine/transition.test.ts#L468) (replacing the document list), [case 13](packages/engine/test/engine/transition.test.ts#L547) (appeal period not over); per-rule tests in [`rules.test.ts`](packages/engine/test/rules.test.ts).
- Scenario: [6](docs/scenario-results.md#scenario-6), showing `Missing required documents: invoice, id_proof` and `amount 12000 exceeds policyLimit 10000`.

### 4. Role authorization is enforced

The role comes from [`config/users.json`](config/users.json), looked up by the `X-User-Id` header; the client cannot claim a role. Permissions for each transition and action live in the config, not in `@Roles()` decorators.

- Code: role checks in `WorkflowEngine` ([`workflow-engine.ts`](packages/engine/src/engine/workflow-engine.ts)); identity guard in [`apps/api/src/identity/user.guard.ts`](apps/api/src/identity/user.guard.ts).
- Tests: [case 15](packages/engine/test/engine/transition.test.ts#L406) (clerk tries to approve), [case 16](packages/engine/test/engine/actions.test.ts#L57) (assessor tries to create a claim), case 17 ([wrong role](packages/engine/test/engine/actions.test.ts#L190), [wrong state](packages/engine/test/engine/actions.test.ts#L198), [second acknowledgement](packages/engine/test/engine/actions.test.ts#L205)), [case 18](packages/engine/test/engine/transition.test.ts#L290) (unknown user).
- Scenario: [5](docs/scenario-results.md#scenario-5).

### 5. Audit trail is complete and accurate for all scenarios

Every transition, rejection, side effect and action is audited with `timestamp`, `fromState`, `toState`, `triggeredBy` (user ID + role), `reason` and `notes`. The audit is append-only: entries cannot be updated or deleted, not even with hand-written SQL.

- Output: [`docs/audit-output.json`](docs/audit-output.json), read back from the `audit_entries` table after all 8 scenarios have run.
- Code: triggers blocking `UPDATE`/`DELETE`/`TRUNCATE` in [`migrations/001_init.sql`](packages/store-postgres/migrations/001_init.sql#L35); `seq` is assigned under the claim lock and backed by `UNIQUE (claim_id, seq)`.
- Tests: [case 1](packages/engine/test/engine/cases.test.ts#L35) (all 13 entries in order), [case 22](packages/engine/test/engine/cases.test.ts#L90) (every field present, `reason` priority), [case 21](packages/engine/test/engine/cases.test.ts#L309) and the [store contract test](packages/engine/test/store/contract.ts#L277) (returned entries are frozen), [case 23](packages/engine/test/engine/transition.test.ts#L244) (a failed side effect is still recorded), [case 30](packages/store-postgres/test/concurrency.test.ts#L221) (`seq` stays contiguous under concurrent requests), [case 32](packages/store-postgres/test/audit-append-only.test.ts#L8) (direct SQL is rejected by the triggers).

### 6. Cycle detection prevents infinite loops

`request_info` has `cycleLimit.max = 3` in the [config](config/claims-workflow.json#L139). The 4th attempt is rejected with the exact message from the brief: `Maximum information requests exceeded — escalate to team lead`. Only successful transitions count, and the count is taken under the claim lock, so concurrent requests cannot slip past the limit.

- Tests: [cases 19 and 20](packages/engine/test/engine/transition.test.ts#L560); [case 27](packages/store-postgres/test/concurrency.test.ts#L119) (5 simultaneous requests after 2 completed rounds: exactly one succeeds).
- Scenario: [7](docs/scenario-results.md#scenario-7).

### 7. Adding a new state or transition requires only config changes

[`docs/config-diff.md`](docs/config-diff.md): [`examples/with-escalation.json`](examples/with-escalation.json) adds an `ESCALATED` state and 3 transitions using only existing rules and side effects, with the diff and a trial run. The new field `escalationReason` is stored in `claim.data` without changing the `Claim` type.

- Tests: [case 25](packages/engine/test/engine/escalation.test.ts#L21) (loads cleanly; `UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED`; the second `return_to_assessment` is `CYCLE_LIMIT_EXCEEDED`).
- An invalid config is rejected at load time with every error listed: [case 24](packages/engine/test/config.test.ts#L56) and the rest of [`config.test.ts`](packages/engine/test/config.test.ts).

### 8. At least 15 tests

260 tests: 211 unit tests (`pnpm test`) and 49 integration tests (`pnpm test:integration`). The 32 numbered cases in [DESIGN.md section 10](DESIGN.md#10-test) cover the five groups the brief asks for:

| Group | Cases |
|---|---|
| Valid transitions | 1–4 |
| Invalid transitions | 5–7 |
| Precondition failures | 8–14 |
| Role authorization | 15–18 |
| Cycle detection | 19–20, 27 |

### Beyond the criteria: concurrent requests

Requests on the same claim are serialized with `SELECT … FOR UPDATE`. A request that waited re-reads the committed state and is evaluated from scratch. [Cases 26–31](packages/store-postgres/test/concurrency.test.ts#L53) each repeat 20 times; [scenario 8](docs/scenario-results.md#scenario-8) fires an approve and a reject at the same moment.

## Generated docs

The files in [`docs/`](docs) are generated; re-run the command instead of editing them.

- [`docs/scenario-results.md`](docs/scenario-results.md) (`pnpm scenarios`): 8 scenarios on PostgreSQL, i.e. the 5 from the brief plus a precondition failure, a cycle-limit rejection and two concurrent requests.
- [`docs/audit-output.json`](docs/audit-output.json) (`pnpm scenarios`): the audit trail of each scenario, read back from the database.
- [`docs/config-diff.md`](docs/config-diff.md) (`pnpm config-diff`): the diff that adds `ESCALATED`, and its trial run.

Audit entry UUIDs and the winner of scenario 8 change on every run, since scenario 8 is a real race for the row lock.

## Trade-offs

Details in [DESIGN.md section 6.4](DESIGN.md#64-xử-lý-request-đồng-thời).

- **Pessimistic per-claim locking instead of `version` plus retries.** Traffic on a single claim is low, the logic stays simple, and side effects never re-run. A request that waits longer than `DB_LOCK_TIMEOUT_MS` (5 s by default) gets `CLAIM_BUSY` (409); the engine does not retry.
- **Side effects run inside the transaction that holds the lock.** The state change, data written by side effects and the audit commit together. The cost: the lock is held while side effects run, and a mock handler's console log may already be printed if the commit then fails. Real integrations (a payment gateway) should move to a transactional outbox; that is not built.
- **A failed side effect does not roll back the transition.** Its `SIDE_EFFECT` entry is recorded as `failed` and later side effects still run. Consequence: if `createPaymentRequest` fails, the claim stays in `APPROVED` and cannot pass `initiate_payment` until a payment request exists.
- **Optimistic check from the UI.** The UI always sends `expectedVersion`; stale data gets `STALE_CLAIM` and a reload. Clients that omit it rely on the lock alone.
- **System tasks use `SKIP LOCKED`.** A locked claim is skipped and left for the next run. Claims that don't qualify yet are not audited as `TRANSITION_REJECTED`, so repeated runs don't flood the audit.
- **Plain SQL through `pg`, no ORM**, to keep `FOR UPDATE`, `SKIP LOCKED` and `lock_timeout` explicit.
- **Config and mock users are files, not database rows**, so "config change only" stays true. A new kind of rule or a new external integration still needs a handler added to the registry.

## Assumptions

Full list in [DESIGN.md section 12](DESIGN.md#12-giả-định).

- **No real authentication.** Identity is just the `X-User-Id` header; the server looks up the role in `users.json`. Each user has exactly one role; there is no login.
- **Roles:** `document_clerk` creates claims and records the member's acknowledgement. The member is data (`memberId`), not a role. Permissions live in the config, so this can change without code.
- **Reading of the brief's conditions:** "Assessment report complete" means the report is not empty (`notEmpty`). "Payment confirmed" means finance sends a `paymentReference`. "New documents/info received" means the request must carry a new `infoResponse` or new `documents`; submitted `documents` replace the previous list.
- **Empty values:** `undefined`, `null`, empty or whitespace-only strings, empty arrays and empty objects. `0` and `false` are values.
- **`policyLimit`** is entered by the clerk when creating the claim and cannot change afterwards. In practice it should come from the insurance policy.
- **Loop limits** apply only at runtime through `cycleLimit`. The engine does not detect loops when loading the config, so a new loop needs its own `cycleLimit` (as `return_to_assessment` does in the `ESCALATED` example).
- **Single API instance.** Locks live in the database, so several instances would still keep data safe, but the demo clock (system time plus the offset from **Advance clock**) lives in the process and resets on restart.
- **Lock-free reads:** `GET /claims/:id` may show data a few milliseconds old; `expectedVersion` prevents writes based on it.

## Not done

Optional extensions (phase 2 in [DESIGN.md section 9](DESIGN.md#9-web-ui-react) and [section 11](DESIGN.md#11-bằng-chứng-nộp-kèm)):

- State diagram in the UI.
- Timeline audit view with side effects nested under their transition. The UI has an audit table that highlights rejections and failed side effects.
- The `examples/member-self-service/` example.

The API and UI have no automated tests; they were checked by hand in the UI.
