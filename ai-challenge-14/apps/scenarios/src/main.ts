import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import {
  FakeClock,
  WorkflowEngine,
  createBuiltinSideEffects,
  loadConfig,
  type AuditEntry,
  type Claim,
} from '@claims/engine';
import { PostgresWorkflowStore, migrate } from '@claims/store-postgres';
import { Pool } from 'pg';
import { ScenarioContext } from './context';
import { renderAuditJson, renderMarkdown, type ReadBack, type RunInfo, type ScenarioResult } from './report';
import { SCENARIOS } from './scenarios';

// dist/main.js → repo root.
const ROOT = resolve(__dirname, '..', '..', '..');
const DOCS_DIR = resolve(ROOT, 'docs');
const CONFIG_DIR = resolve(ROOT, 'config');
const DEFAULT_URL = 'postgres://claims:claims@localhost:5432/claims_scenarios';
const CLOCK_START = '2026-03-02T08:00:00.000Z';

/** The run drops the whole schema, so refuse anything that isn't a *_scenarios database. */
function databaseUrl(): { url: string; name: string } {
  const url = process.env.SCENARIOS_DATABASE_URL ?? DEFAULT_URL;
  const name = new URL(url).pathname.slice(1);
  if (!name.endsWith('_scenarios')) {
    throw new Error(`SCENARIOS_DATABASE_URL must point to a *_scenarios database, got "${name}"`);
  }
  return { url, name };
}

/** audit_entries rejects TRUNCATE/DELETE, so a clean slate means recreating the schema. */
async function resetDatabase(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('SET client_min_messages = warning; DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
    await migrate(client);
  } finally {
    client.release();
  }
}

const readJson = (file: string): unknown => JSON.parse(readFileSync(resolve(CONFIG_DIR, file), 'utf8'));

async function main(): Promise<void> {
  const db = databaseUrl();
  const pool = new Pool({ connectionString: db.url, max: 5 });
  try {
    await resetDatabase(pool);
    console.log(`Reset and migrated ${db.name}`);

    const config = loadConfig({ workflow: readJson('claims-workflow.json'), users: readJson('users.json') });
    const store = new PostgresWorkflowStore(pool, { lockTimeoutMs: 5000 });
    const clock = new FakeClock(CLOCK_START);
    let logs: string[] = [];
    let paymentRequests = 0;
    const engine = new WorkflowEngine({
      config,
      store,
      clock,
      sideEffects: createBuiltinSideEffects({
        log: (line) => logs.push(line),
        paymentRequestId: () => `pr-${String(++paymentRequests).padStart(4, '0')}`,
      }),
    });

    const results: ScenarioResult[] = [];
    for (const scenario of SCENARIOS) {
      console.log(`\n${scenario.id}. ${scenario.title}`);
      const ctx = new ScenarioContext({ engine, store, clock, users: config.users.users });
      logs = ctx.logs;
      let error: string | undefined;
      try {
        await scenario.run(ctx);
        const { claim, audit } = await ctx.readBack();
        if (!claim) throw new Error(`Claim ${ctx.claimId} not found in the database`);
        expectContiguousSeq(ctx, audit);
        scenario.verify(ctx, claim, audit);
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        console.log(`  ERROR ${error}`);
      }
      for (const c of ctx.checks) console.log(`  ${c.passed ? 'PASS' : 'FAIL'} check: ${c.label}${c.detail ? ` — ${c.detail}` : ''}`);
      results.push({
        id: scenario.id,
        title: scenario.title,
        summary: scenario.summary,
        claimId: ctx.hasClaim ? ctx.claimId : null,
        steps: ctx.steps,
        checks: ctx.checks,
        logs: ctx.logs,
        ...(error !== undefined && { error }),
        passed: error === undefined && ctx.steps.every((s) => s.passed) && ctx.checks.every((c) => c.passed),
      });
    }

    // Read every trail again once all scenarios are done, so the output reflects what is stored.
    const readBack = new Map<string, ReadBack>();
    for (const { claimId } of results) {
      if (claimId === null) continue;
      const [claim, audit]: [Claim | null, AuditEntry[]] = await Promise.all([
        store.getClaim(claimId),
        store.listAuditByClaim(claimId),
      ]);
      readBack.set(claimId, { claim, audit });
    }

    const info: RunInfo = {
      database: db.name,
      config: 'config/claims-workflow.json + config/users.json',
      clockStart: CLOCK_START,
      clockEnd: clock.now().toISOString(),
    };
    mkdirSync(DOCS_DIR, { recursive: true });
    const mdPath = resolve(DOCS_DIR, 'scenario-results.md');
    const jsonPath = resolve(DOCS_DIR, 'audit-output.json');
    writeFileSync(mdPath, renderMarkdown(info, results, readBack));
    writeFileSync(jsonPath, renderAuditJson(info, results, readBack));

    const passed = results.filter((r) => r.passed).length;
    console.log(`\n${passed}/${results.length} scenarios passed`);
    console.log(`Wrote ${relative(process.cwd(), mdPath)} and ${relative(process.cwd(), jsonPath)}`);
    if (passed !== results.length) process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

function expectContiguousSeq(ctx: ScenarioContext, audit: AuditEntry[]): void {
  const seqs = audit.map((e) => e.seq);
  ctx.check(
    'Audit seq is contiguous from 1',
    seqs.every((seq, i) => seq === i + 1),
    `seq ${seqs.join(', ')}`,
  );
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
