import { useState, type FormEvent } from 'react';
import type { Claim, UserConfig, WorkflowConfig } from '@claims/engine';
import { api, errorMessage } from '../api';
import { emptyValue, fieldSpec, toPayload, type FieldSpec, type FieldValues } from '../fields';
import { FieldInput } from './FieldInput';
import { Notice } from './Notice';

interface Props {
  config: WorkflowConfig;
  users: UserConfig[];
  specs: Map<string, FieldSpec>;
  onCreated(claim: Claim): void;
  onCancel(): void;
}

/** Number inputs stay strings until submit; an empty one is left out so the engine reports it as missing. */
function toNumber(value: string): number | undefined {
  return value.trim() === '' ? undefined : Number(value);
}

export function CreateClaimForm({ config, users, specs, onCreated, onCancel }: Props) {
  const inputs = config.actions.createClaim.inputs;
  const [memberId, setMemberId] = useState('');
  const [amount, setAmount] = useState('');
  const [policyLimit, setPolicyLimit] = useState('');
  const [values, setValues] = useState<FieldValues>(() =>
    Object.fromEntries(inputs.map((field) => [field, emptyValue(fieldSpec(specs, field))])),
  );
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const claim = await api.createClaim({
        ...toPayload(inputs, values),
        memberId: memberId.trim(),
        amount: toNumber(amount) as number,
        policyLimit: toNumber(policyLimit) as number,
      });
      onCreated(claim);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="card" onSubmit={submit}>
      <h3>New claim</h3>
      <div className="field">
        <label htmlFor="new-member">memberId</label>
        <input id="new-member" type="text" value={memberId} onChange={(e) => setMemberId(e.target.value)} />
      </div>
      <div className="row">
        <div className="field">
          <label htmlFor="new-amount">amount</label>
          <input id="new-amount" type="number" step="any" value={amount} onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="new-limit">policyLimit</label>
          <input
            id="new-limit"
            type="number"
            step="any"
            value={policyLimit}
            onChange={(e) => setPolicyLimit(e.target.value)}
          />
        </div>
      </div>
      {inputs.map((field) => (
        <FieldInput
          key={field}
          name={field}
          spec={fieldSpec(specs, field)}
          value={values[field]}
          onChange={(value) => setValues((prev) => ({ ...prev, [field]: value }))}
          users={users}
        />
      ))}
      {error && <Notice notice={{ kind: 'error', text: error }} />}
      <div className="row">
        <button type="submit" disabled={busy}>
          Create
        </button>
        <button type="button" className="secondary" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
