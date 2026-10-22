import { useCallback, useEffect, useMemo, useState } from 'react';
import type { Claim, UserConfig, WorkflowConfig } from '@claims/engine';
import { api, errorMessage, setCurrentUser } from './api';
import { ClaimDetail } from './components/ClaimDetail';
import { ClaimList } from './components/ClaimList';
import { CreateClaimForm } from './components/CreateClaimForm';
import { Notice } from './components/Notice';
import { buildFieldSpecs } from './fields';

const USER_KEY = 'claims.userId';

interface Bootstrap {
  config: WorkflowConfig;
  users: UserConfig[];
}

export function App() {
  const [boot, setBoot] = useState<Bootstrap | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);

  const loadBoot = useCallback(async () => {
    setBootError(null);
    try {
      const [config, { users }] = await Promise.all([api.getConfig(), api.getUsers()]);
      const saved = localStorage.getItem(USER_KEY);
      const initial = users.find((u) => u.id === saved) ?? users[0];
      // Set before any child renders, so their first requests already carry X-User-Id.
      setCurrentUser(initial.id);
      setUserId(initial.id);
      setBoot({ config, users });
    } catch (error) {
      setBootError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadBoot();
  }, [loadBoot]);

  const selectUser = (id: string) => {
    setCurrentUser(id);
    localStorage.setItem(USER_KEY, id);
    setUserId(id);
  };

  if (bootError) {
    return (
      <div className="boot">
        <Notice notice={{ kind: 'error', text: bootError }} />
        <button onClick={() => void loadBoot()}>Retry</button>
      </div>
    );
  }
  if (!boot || !userId) return <div className="boot muted">Loading…</div>;

  const user = boot.users.find((u) => u.id === userId)!;
  return <Workspace config={boot.config} users={boot.users} user={user} onSelectUser={selectUser} />;
}

interface WorkspaceProps {
  config: WorkflowConfig;
  users: UserConfig[];
  user: UserConfig;
  onSelectUser(id: string): void;
}

function Workspace({ config, users, user, onSelectUser }: WorkspaceProps) {
  const specs = useMemo(() => buildFieldSpecs(config), [config]);
  const [claims, setClaims] = useState<Claim[]>([]);
  const [listError, setListError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const loadClaims = useCallback(async () => {
    try {
      setClaims(await api.listClaims());
      setListError(null);
    } catch (error) {
      setListError(errorMessage(error));
    }
  }, []);

  useEffect(() => {
    void loadClaims();
  }, [loadClaims, user.id]);

  const canCreate = config.actions.createClaim.roles.includes(user.role);

  return (
    <>
      <header className="topbar">
        <h1>Claims Workflow</h1>
        <label className="user-picker">
          Acting as
          <select value={user.id} onChange={(e) => onSelectUser(e.target.value)}>
            {users.map((u) => (
              <option key={u.id} value={u.id}>
                {u.name} — {u.role}
              </option>
            ))}
          </select>
        </label>
        <span className="badge">{user.role}</span>
      </header>

      <main className="layout">
        <section className="panel">
          <div className="panel-head">
            <h2>Claims</h2>
            <button className="secondary" onClick={() => void loadClaims()}>
              Refresh
            </button>
            <button
              onClick={() => setCreating(true)}
              disabled={!canCreate || creating}
              title={canCreate ? undefined : `Requires role ${config.actions.createClaim.roles.join(' or ')}`}
            >
              New claim
            </button>
          </div>
          {creating && (
            <CreateClaimForm
              config={config}
              users={users}
              specs={specs}
              onCancel={() => setCreating(false)}
              onCreated={(claim) => {
                setCreating(false);
                setSelectedId(claim.id);
                void loadClaims();
              }}
            />
          )}
          {listError && <Notice notice={{ kind: 'error', text: listError }} />}
          <ClaimList claims={claims} selectedId={selectedId} onSelect={setSelectedId} />
        </section>

        {selectedId ? (
          <ClaimDetail
            key={selectedId}
            claimId={selectedId}
            user={user}
            users={users}
            config={config}
            specs={specs}
            onChanged={() => void loadClaims()}
          />
        ) : (
          <div className="panel muted">Select a claim to see its state and available transitions.</div>
        )}
      </main>
    </>
  );
}
