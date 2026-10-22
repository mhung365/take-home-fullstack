import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import {
  FakeClock,
  InMemoryWorkflowStore,
  WorkflowEngine,
  createBuiltinSideEffects,
  loadConfig,
  type AuditEntry,
  type Condition,
  type TransitionConfig,
  type WorkflowConfig,
} from '@claims/engine';
import { ScenarioContext } from './context';
import { auditTable, checkList, logBlock, mark, stepsTable } from './report';

// dist/config-diff.js → repo root.
const ROOT = resolve(__dirname, '..', '..', '..');
const BASE = 'config/claims-workflow.json';
const EXAMPLE = 'examples/with-escalation.json';
const USERS = 'config/users.json';
const OUTPUT = resolve(ROOT, 'docs', 'config-diff.md');
const CLOCK_START = '2026-05-04T09:00:00.000Z';

const CLERK = 'u-clerk-1';
const LEAD = 'u-lead-1';
const ASSESSOR = 'u-assessor-1';
const ASSESSOR_2 = 'u-assessor-2';
const SYSTEM = 'u-system';
const ALL_DOCS = ['claim_form', 'invoice', 'id_proof'];

const readJson = (file: string): unknown => JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));

function unifiedDiff(): string {
  const result = spawnSync('git', ['diff', '--no-index', '--no-color', BASE, EXAMPLE], { cwd: ROOT, encoding: 'utf8' });
  // git diff --no-index exits 1 when the files differ.
  if (result.status !== 1) throw new Error(`git diff failed (${result.status}): ${result.stderr || result.error}`);
  return result.stdout.trimEnd();
}

function formatCondition(node: Condition): string {
  if ('all' in node) return `all[${(node.all as Condition[]).map(formatCondition).join(', ')}]`;
  if ('any' in node) return `any[${(node.any as Condition[]).map(formatCondition).join(', ')}]`;
  if ('not' in node) return `not(${formatCondition(node.not as Condition)})`;
  const { rule, field, message: _message, ...rest } = node as Record<string, unknown>;
  return `${String(rule)}(${[field, ...Object.values(rest)].map(String).join(', ')})`;
}

function transitionRow(t: TransitionConfig): string {
  const preconditions = [t.preconditions ? formatCondition(t.preconditions) : '—'];
  if (t.cycleLimit) preconditions.push(`cycleLimit.max = ${t.cycleLimit.max}`);
  const sideEffects = t.sideEffects.map(({ name, params }) => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (name === 'notify') return `notify(${String(p.to)})`;
    if (name === 'setField') return `setField(${String(p.field)}, ${String(p.value)})`;
    return name;
  });
  const inputs = t.inputs.map((i) => `\`${i}\``).join(', ') || '—';
  return `| \`${t.id}\` | ${t.from} → ${t.to} | ${t.roles.join(', ')} | ${inputs} | \`${preconditions.join('`; `')}\` | \`${sideEffects.join('`, `')}\` |`;
}

/** Same check as engine case 25: removing the additions gives back the base config exactly. */
function additions(base: WorkflowConfig, example: WorkflowConfig) {
  const baseStates = new Set(base.states.map((s) => s.id));
  const baseTransitions = new Set(base.transitions.map((t) => t.id));
  const states = example.states.filter((s) => !baseStates.has(s.id));
  const transitions = example.transitions.filter((t) => !baseTransitions.has(t.id));
  const stripped = {
    ...example,
    states: example.states.filter((s) => baseStates.has(s.id)),
    transitions: example.transitions.filter((t) => baseTransitions.has(t.id)),
  };
  return { states, transitions, onlyAdditions: isDeepStrictEqual(stripped, base) };
}

interface Run {
  title: string;
  summary: string;
  ctx: ScenarioContext;
  audit: AuditEntry[];
}

async function main(): Promise<void> {
  const base = loadConfig({ workflow: readJson(BASE), users: readJson(USERS) });
  const config = loadConfig({ workflow: readJson(EXAMPLE), users: readJson(USERS) });
  const added = additions(base.workflow, config.workflow);

  const store = new InMemoryWorkflowStore();
  const clock = new FakeClock(CLOCK_START);
  let logs: string[] = [];
  const engine = new WorkflowEngine({
    config,
    store,
    clock,
    sideEffects: createBuiltinSideEffects({ log: (line) => logs.push(line), paymentRequestId: () => 'pr-0001' }),
  });
  const newContext = () => {
    const ctx = new ScenarioContext({ engine, store, clock, users: config.users.users });
    logs = ctx.logs;
    return ctx;
  };
  const toUnderAssessment = async (ctx: ScenarioContext, memberId: string) => {
    await ctx.createClaim(CLERK, { memberId, amount: 4200, policyLimit: 10000, documents: ALL_DOCS });
    await ctx.transition({ userId: CLERK, to: 'DOCUMENTS_VERIFIED' });
    await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } });
  };
  const runs: Run[] = [];

  console.log('\nA. Escalated, rejected by the team lead, closed after the appeal period');
  {
    const ctx = newContext();
    const escalationReason = 'Invoice total does not match the itemised bill; possible duplicate claim';
    await toUnderAssessment(ctx, 'm-2001');
    await ctx.transition({ userId: ASSESSOR, to: 'ESCALATED', payload: { escalationReason } });
    await ctx.transition({
      userId: LEAD,
      to: 'REJECTED',
      payload: { rejectionReason: 'Duplicate of claim already paid under the same invoice' },
    });
    ctx.advanceClock(30);
    await ctx.runSystemTasks(SYSTEM, { processed: 'CLOSED' });

    const { claim, audit } = await ctx.readBack();
    const path = audit.filter((e) => e.type === 'TRANSITION').map((e) => `${e.fromState} → ${e.toState}`);
    ctx.check(
      'Path includes UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED',
      path.slice(-3).join(', ') === 'UNDER_ASSESSMENT → ESCALATED, ESCALATED → REJECTED, REJECTED → CLOSED',
      path.join(', '),
    );
    ctx.check('escalationReason stored in claim.data', claim?.data.escalationReason === escalationReason);
    ctx.check(
      'escalate audit reason is the escalationReason (reasonField)',
      audit.find((e) => e.transitionId === 'escalate' && e.type === 'TRANSITION')?.reason === escalationReason,
    );
    ctx.check(
      'Every SIDE_EFFECT entry has status ok',
      audit.filter((e) => e.type === 'SIDE_EFFECT').every((e) => e.data?.status === 'ok'),
    );
    runs.push({
      title: 'A. UNDER_ASSESSMENT → ESCALATED → REJECTED → CLOSED',
      summary:
        'The assessor escalates, the team lead rejects through the new `reject_escalated`, and the existing ' +
        '`close_rejected` system task closes the claim once the fake clock passes the 30-day appeal period.',
      ctx,
      audit,
    });
  }

  console.log('\nB. Second return_to_assessment blocked by cycleLimit');
  {
    const ctx = newContext();
    await toUnderAssessment(ctx, 'm-2002');
    await ctx.transition({ userId: ASSESSOR, to: 'ESCALATED', payload: { escalationReason: 'Unclear medical necessity' } });
    await ctx.transition({ userId: LEAD, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR_2 } });
    await ctx.transition({
      userId: ASSESSOR_2,
      to: 'ESCALATED',
      payload: { escalationReason: 'Still unclear after second opinion' },
    });
    const before = await store.getClaim(ctx.claimId);
    const { transitions } = await engine.getAvailableTransitions(ctx.claimId, LEAD);
    const returnAgain = transitions.find((t) => t.transitionId === 'return_to_assessment');
    const message = config.workflow.transitions.find((t) => t.id === 'return_to_assessment')!.cycleLimit!.message;
    await ctx.transition(
      { userId: LEAD, to: 'UNDER_ASSESSMENT', payload: { assessorId: ASSESSOR } },
      { code: 'CYCLE_LIMIT_EXCEEDED', message },
    );

    const { claim, audit } = await ctx.readBack();
    ctx.check(
      'Available transitions showed return_to_assessment disabled before the attempt',
      returnAgain?.enabled === false && returnAgain.cycleLimit?.remaining === 0,
      `cycleLimit ${JSON.stringify(returnAgain?.cycleLimit)}, enabled ${String(returnAgain?.enabled)}`,
    );
    ctx.check('Claim unchanged by the rejected attempt', isDeepStrictEqual(claim, before), `status ${claim?.status}`);
    ctx.check(
      'Rejected attempt audited as TRANSITION_REJECTED with CYCLE_LIMIT_EXCEEDED',
      audit.at(-1)?.type === 'TRANSITION_REJECTED' && audit.at(-1)?.data?.code === 'CYCLE_LIMIT_EXCEEDED',
    );
    runs.push({
      title: 'B. Second return_to_assessment is blocked',
      summary:
        'The first `return_to_assessment` succeeds; after a second escalation, the team lead tries again and the ' +
        '`cycleLimit` (max 1) declared in the example config rejects it.',
      ctx,
      audit,
    });
  }

  const loadPassed = added.onlyAdditions && config.warnings.length === 0;
  const allPassed =
    loadPassed && runs.every(({ ctx }) => ctx.steps.every((s) => s.passed) && ctx.checks.every((c) => c.passed));

  const newTransitions = added.transitions;
  const wording = newTransitions.flatMap((t) => [
    ...(t.cycleLimit ? [`- \`${t.id}\` \`cycleLimit.message\`: "${t.cycleLimit.message}"`] : []),
    ...t.sideEffects
      .filter((s) => s.name === 'notify')
      .map((s) => {
        const p = s.params as { to: string; template: string };
        return `- \`${t.id}\` \`notify\` → \`${p.to}\`: "${p.template}"`;
      }),
  ]);

  const out: string[] = [
    '# Config diff: adding an ESCALATED state',
    '',
    'Generated by `pnpm config-diff` (`apps/scenarios/src/config-diff.ts`). Do not edit by hand; re-run the command instead.',
    '',
    `\`${EXAMPLE}\` is \`${BASE}\` plus ${added.states.length} state and ${newTransitions.length} transitions. ` +
      'Nothing else changed: no engine, API or UI code, and no new rule or side effect handler. The new transitions only ' +
      'reuse `providedInRequest`, `userHasRole`, `notify`, `setField` and `cycleLimit`. The new field `escalationReason` ' +
      'is declared in `inputs` and stored in `claim.data`; the `Claim` type is unchanged.',
    '',
    `**Result: ${mark(allPassed)} ${allPassed ? 'all steps and checks passed' : 'some steps or checks failed'}**`,
    '',
    '## New transitions',
    '',
    `New state: ${added.states.map((s) => `\`${s.id}\` (${s.description})`).join(', ')}.`,
    '',
    '| id | from → to | roles | inputs | preconditions | side effects |',
    '|---|---|---|---|---|---|',
    ...newTransitions.map(transitionRow),
    '',
    '## Wording chosen for this demo',
    '',
    'The brief does not define an ESCALATED state, so every message and notification text below is our own wording, ' +
      'not taken from the brief. (The only message the brief specifies is the info-request cycle limit, ' +
      '"Maximum information requests exceeded — escalate to team lead", which is in the base config and unchanged.)',
    '',
    ...wording,
    '',
    '## Diff',
    '',
    '```diff',
    unifiedDiff(),
    '```',
    '',
    '## Trial run',
    '',
    `Engine on \`${EXAMPLE}\` + \`${USERS}\` with an in-memory store and \`FakeClock\` starting at ${CLOCK_START}; ` +
      'claims are created through `createClaim` and the appeal period is reached by advancing the clock.',
    '',
    '### Load',
    '',
    '```text',
    `loadConfig(${EXAMPLE}): ok`,
    `  states:      ${config.workflow.states.length} (${BASE}: ${base.workflow.states.length})`,
    `  transitions: ${config.workflow.transitions.length} (${BASE}: ${base.workflow.transitions.length})`,
    `  warnings:    ${config.warnings.length}`,
    `  added:       state ${added.states.map((s) => s.id).join(', ')}; transitions ${newTransitions.map((t) => t.id).join(', ')}`,
    `  removing the additions gives back ${BASE} exactly: ${added.onlyAdditions}`,
    '```',
  ];

  for (const { title, summary, ctx, audit } of runs) {
    out.push('', `### ${title}`, '', summary, '', `Claim: \`${ctx.claimId}\``, '', ...stepsTable(ctx.steps));
    out.push('', '**Checks**', '', ...checkList(ctx.checks));
    out.push('', '**Side effect console output**', '', ...logBlock(ctx.logs));
    out.push('', '**Audit trail**', '', ...auditTable(audit));
  }

  mkdirSync(resolve(ROOT, 'docs'), { recursive: true });
  writeFileSync(OUTPUT, `${out.join('\n')}\n`);
  console.log(`\n${allPassed ? 'All steps and checks passed' : 'FAILED'}`);
  console.log(`Wrote ${relative(process.cwd(), OUTPUT)}`);
  if (!allPassed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error((error as Error).message);
  process.exit(1);
});
