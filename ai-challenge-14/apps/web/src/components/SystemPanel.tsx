import { useEffect, useState } from 'react';
import type { SystemTasksResult, UserConfig, WorkflowConfig } from '@claims/engine';
import { api, errorMessage, type ClockState } from '../api';
import { Notice, type NoticeState } from './Notice';

interface Props {
  config: WorkflowConfig;
  user: UserConfig;
  /** Claims may have changed: refresh the list and the open claim. */
  onChanged(): void;
}

export function SystemPanel({ config, user, onChanged }: Props) {
  const [result, setResult] = useState<SystemTasksResult | null>(null);
  const [clock, setClock] = useState<ClockState | null>(null);
  const [days, setDays] = useState('30');
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);

  // GET /dev/clock exists only with DEMO_MODE=true; any failure keeps the clock controls hidden.
  useEffect(() => {
    let active = true;
    api.getClock().then(
      (state) => active && setClock(state),
      () => active && setClock(null),
    );
    return () => {
      active = false;
    };
  }, []);

  const runRoles = config.actions.runSystemTasks.roles;
  const canRun = runRoles.includes(user.role);

  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      onChanged();
    } catch (error) {
      setNotice({ kind: 'error', text: errorMessage(error) });
    } finally {
      setBusy(false);
    }
  };

  const runTasks = () =>
    run(async () => {
      setResult(await api.runSystemTasks());
    });

  const advance = () =>
    run(async () => {
      const state = await api.advanceClock(Number(days));
      setClock(state);
      setNotice({ kind: 'success', text: `Clock advanced by ${days} day(s)` });
    });

  return (
    <section className="panel">
      <div className="panel-head">
        <h2>System</h2>
      </div>

      <div className="row align-center">
        <button onClick={() => void runTasks()} disabled={busy || !canRun}>
          Run system tasks
        </button>
        {!canRun && <span className="muted small">Requires role {runRoles.join(' or ')}</span>}
      </div>

      {clock && (
        <div className="clock">
          <div className="muted small">
            Clock: {new Date(clock.now).toLocaleString()}
            {clock.offsetMs > 0 && ` (+${(clock.offsetMs / 86_400_000).toFixed(1)} days)`}
          </div>
          <div className="row align-center">
            <input
              type="number"
              min="0"
              step="any"
              value={days}
              onChange={(e) => setDays(e.target.value)}
              aria-label="Days to advance"
              className="days"
            />
            <span>days</span>
            <button className="secondary" onClick={() => void advance()} disabled={busy}>
              Advance clock
            </button>
          </div>
        </div>
      )}

      {notice && <Notice notice={notice} onClose={() => setNotice(null)} />}

      {result && <TasksResult result={result} />}
    </section>
  );
}

function TasksResult({ result }: { result: SystemTasksResult }) {
  return (
    <div className="tasks-result">
      <h3>Processed ({result.processed.length})</h3>
      {result.processed.length === 0 ? (
        <div className="muted">None.</div>
      ) : (
        <ul>
          {result.processed.map((task) => (
            <li key={`${task.claimId}:${task.transitionId}`}>
              <strong>{task.claimId}</strong> {task.transitionId}: {task.from} → {task.to}{' '}
              <span className="muted small">v{task.version}</span>
            </li>
          ))}
        </ul>
      )}
      <h3>Skipped ({result.skipped.length})</h3>
      {result.skipped.length === 0 ? (
        <div className="muted">None.</div>
      ) : (
        <ul>
          {result.skipped.map((task) => (
            <li key={`${task.claimId}:${task.transitionId}`}>
              <strong>{task.claimId}</strong> {task.transitionId}: <code>{task.reason}</code>
              <div className="muted small">{task.message}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
