import { useCallback, useEffect, useRef, useState } from 'react';
import type { AuditEntry, AvailableTransitions, UserConfig, WorkflowConfig } from '@claims/engine';
import { api, errorMessage, isReloadError } from '../api';
import { formatValue, type FieldSpec } from '../fields';
import { AuditTable } from './AuditTable';
import { Notice, type NoticeState } from './Notice';
import { TransitionCard } from './TransitionCard';

interface Props {
  claimId: string;
  user: UserConfig;
  users: UserConfig[];
  config: WorkflowConfig;
  specs: Map<string, FieldSpec>;
  /** Bumped by writes outside this panel (system tasks, clock) that can change the claim. */
  refreshKey: number;
  /** A write succeeded or the claim was reloaded with a new state; the list should refresh. */
  onChanged(): void;
}

export function ClaimDetail({ claimId, user, users, config, specs, refreshKey, onChanged }: Props) {
  const [view, setView] = useState<AvailableTransitions | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<NoticeState | null>(null);
  const [busy, setBusy] = useState(false);
  const [ackNotes, setAckNotes] = useState('');
  const requestSeq = useRef(0);

  // Ignores responses that arrive after a newer load (claim or user switched meanwhile).
  const load = useCallback(async () => {
    const seq = ++requestSeq.current;
    try {
      const [result, entries] = await Promise.all([api.getClaim(claimId), api.getAudit(claimId)]);
      if (seq !== requestSeq.current) return;
      setView(result);
      setAudit(entries);
      setLoadError(null);
    } catch (error) {
      if (seq !== requestSeq.current) return;
      setView(null);
      setLoadError(errorMessage(error));
    }
  }, [claimId]);

  useEffect(() => {
    setView(null);
    setNotice(null);
    void load();
  }, [load, user.id]);

  useEffect(() => {
    if (refreshKey > 0) void load();
  }, [load, refreshKey]);

  /** Every write sends expectedVersion; STALE_CLAIM / CLAIM_BUSY reload instead of failing silently. */
  const write = async (action: () => Promise<unknown>, success: string): Promise<boolean> => {
    setBusy(true);
    try {
      await action();
      setNotice({ kind: 'success', text: success });
      await load();
      onChanged();
      return true;
    } catch (error) {
      if (isReloadError(error)) {
        setNotice({ kind: 'warning', text: `${error.message}. The claim has been reloaded; review it and try again.` });
        await load();
        onChanged();
      } else {
        setNotice({ kind: 'error', text: errorMessage(error) });
        // Rejections are audited even though the claim is unchanged.
        await load();
      }
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (loadError) return <div className="panel"><Notice notice={{ kind: 'error', text: loadError }} /></div>;
  if (!view) return <div className="panel muted">Loading {claimId}…</div>;

  const { claim, transitions } = view;
  const state = config.states.find((s) => s.id === claim.status);
  const ackAction = config.actions.acknowledge;
  const ackApplies = ackAction.allowedStates.includes(claim.status);
  const acknowledged = claim.data.memberAcknowledged === true;
  const canAck = ackAction.roles.includes(user.role);

  return (
    <>
      <div className="panel">
        <div className="detail-head">
          <h2>{claim.id}</h2>
          <span className="state">{claim.status}</span>
          <span className="muted small">v{claim.version}</span>
          <button className="secondary" onClick={() => void load()} disabled={busy}>
            Reload
          </button>
        </div>
        {state && <div className="muted">{state.description}</div>}

        {notice && <Notice notice={notice} onClose={() => setNotice(null)} />}

        <dl className="facts">
          <dt>Member</dt>
          <dd>{claim.memberId}</dd>
          <dt>Amount</dt>
          <dd>{claim.amount}</dd>
          <dt>Policy limit</dt>
          <dd>{claim.policyLimit}</dd>
          <dt>State entered</dt>
          <dd>{new Date(claim.stateEnteredAt).toLocaleString()}</dd>
          <dt>Created</dt>
          <dd>
            {new Date(claim.createdAt).toLocaleString()} by {claim.createdBy}
          </dd>
          {Object.entries(claim.data).map(([key, value]) => (
            <FactRow key={key} name={key} value={value} />
          ))}
        </dl>

        <h3>Transitions</h3>
        {state?.terminal && <div className="muted">Terminal state; no transitions.</div>}
        {!state?.terminal && transitions.length === 0 && <div className="muted">No transitions from {claim.status}.</div>}
        {transitions.map((transition) => (
          <TransitionCard
            key={`${claim.id}:${transition.transitionId}`}
            transition={transition}
            claim={claim}
            users={users}
            specs={specs}
            busy={busy}
            onSubmit={(payload, notes) =>
              write(
                () =>
                  api.transition(claim.id, {
                    to: transition.to,
                    payload,
                    notes: notes || undefined,
                    expectedVersion: claim.version,
                  }),
                `${transition.transitionId}: ${claim.status} → ${transition.to}`,
              )
            }
          />
        ))}

        {ackApplies && (
          <>
            <h3>Member acknowledgement</h3>
            <div className="card">
              {acknowledged ? (
                <div>
                  Recorded at {formatValue(claim.data.memberAcknowledgedAt)} by {formatValue(claim.data.memberAcknowledgedBy)}
                </div>
              ) : (
                <form
                  onSubmit={async (event) => {
                    event.preventDefault();
                    const ok = await write(
                      () =>
                        api.acknowledge(claim.id, { notes: ackNotes.trim() || undefined, expectedVersion: claim.version }),
                      'Member acknowledgement recorded',
                    );
                    if (ok) setAckNotes('');
                  }}
                >
                  {!canAck && <ul className="reasons"><li>Requires role {ackAction.roles.join(' or ')}</li></ul>}
                  <div className="field">
                    <label>notes (optional)</label>
                    <input type="text" value={ackNotes} onChange={(e) => setAckNotes(e.target.value)} disabled={!canAck} />
                  </div>
                  <button type="submit" disabled={busy || !canAck}>
                    Acknowledge
                  </button>
                </form>
              )}
            </div>
          </>
        )}
      </div>

      <section className="panel audit-panel">
        <div className="panel-head">
          <h2>Audit trail — {claim.id}</h2>
        </div>
        <AuditTable entries={audit} />
      </section>
    </>
  );
}

function FactRow({ name, value }: { name: string; value: unknown }) {
  return (
    <>
      <dt>{name}</dt>
      <dd>{formatValue(value)}</dd>
    </>
  );
}
