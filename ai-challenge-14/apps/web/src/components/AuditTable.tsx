import type { AuditEntry } from '@claims/engine';
import { formatValue } from '../fields';

function rowClass(entry: AuditEntry): string | undefined {
  if (entry.type === 'TRANSITION_REJECTED' || entry.type === 'ACTION_REJECTED') return 'audit-rejected';
  if (entry.type === 'SIDE_EFFECT' && entry.data?.status === 'failed') return 'audit-failed';
  if (entry.type === 'SIDE_EFFECT') return 'audit-effect';
  return undefined;
}

/** Error code of a rejection; reason already carries the message (and a failed side effect's error). */
function rejectionCode(entry: AuditEntry): string | null {
  if (entry.type !== 'TRANSITION_REJECTED' && entry.type !== 'ACTION_REJECTED') return null;
  return formatValue(entry.data?.code);
}

/**
 * Action entries keep the state unchanged (from = to), which reads like a transition, so they show the action instead.
 * MEMBER_ACKNOWLEDGED data holds only the written fields, so its action comes from the type.
 */
function actionName(entry: AuditEntry): string | null {
  if (entry.type === 'ACTION_REJECTED') return formatValue(entry.data?.action);
  if (entry.type === 'MEMBER_ACKNOWLEDGED') return 'acknowledge';
  return null;
}

export function AuditTable({ entries }: { entries: AuditEntry[] }) {
  if (entries.length === 0) return <div className="muted">No audit entries.</div>;
  return (
    <div className="table-scroll">
      <table className="audit">
        <thead>
          <tr>
            <th>#</th>
            <th>Time</th>
            <th>Event</th>
            <th>By</th>
            <th>Reason / data</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const action = actionName(entry);
            return (
              <tr key={entry.id} className={rowClass(entry)}>
                <td>{entry.seq}</td>
                <td className="nowrap">{new Date(entry.timestamp).toLocaleString()}</td>
                <td>
                  <code>{entry.type}</code>
                  {action ? (
                    <>
                      <div className="small">action {action}</div>
                      <div className="muted small">in {entry.fromState ?? '—'}</div>
                    </>
                  ) : (
                    <div className="small">
                      {entry.fromState ?? '—'} → {entry.toState ?? '—'}
                    </div>
                  )}
                  {entry.transitionId && <div className="muted small">{entry.transitionId}</div>}
                </td>
                <td className="nowrap">
                  {entry.triggeredBy.userId}
                  <div className="muted small">{entry.triggeredBy.role}</div>
                </td>
                <td>
                  <div>{entry.reason}</div>
                  {entry.notes && entry.notes !== entry.reason && <div className="muted small">notes: {entry.notes}</div>}
                  {rejectionCode(entry) && <code className="small">{rejectionCode(entry)}</code>}
                  {entry.data && (
                    <details>
                      <summary className="muted small">JSON</summary>
                      <pre>{JSON.stringify(entry.data, null, 2)}</pre>
                    </details>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
