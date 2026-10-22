import { useState, type FormEvent } from 'react';
import type { AvailableTransition, Claim, UserConfig } from '@claims/engine';
import { emptyValue, fieldSpec, toPayload, type FieldSpec, type FieldValues } from '../fields';
import { FieldInput } from './FieldInput';

interface Props {
  transition: AvailableTransition;
  claim: Claim;
  users: UserConfig[];
  specs: Map<string, FieldSpec>;
  busy: boolean;
  /** Resolves true on success, so the form can clear itself. */
  onSubmit(payload: Record<string, unknown>, notes: string): Promise<boolean>;
}

/** Fields the user must fill, from preview rules marked requiresInput (dot paths count by their first segment). */
function requiredInputs(transition: AvailableTransition) {
  const required = new Map<string, 'required' | 'one-of'>();
  const hints = new Map<string, string[]>();
  for (const rule of transition.preconditions.rules) {
    if (!rule.requiresInput || !rule.field) continue;
    const field = rule.field.split('.')[0];
    const kind = /(^|\.)any\[/.test(rule.path) ? 'one-of' : 'required';
    if (required.get(field) !== 'required') required.set(field, kind);
    hints.set(field, [...(hints.get(field) ?? []), rule.message]);
  }
  return { required, hints };
}

function blockedReasons(transition: AvailableTransition): string[] {
  const reasons: string[] = [];
  if (!transition.allowedForCurrentUser) reasons.push(`Requires role ${transition.roles.join(' or ')}`);
  // A failed leaf under a satisfied `any` doesn't block, so leaves only matter when the whole tree fails.
  if (!transition.preconditions.passed) {
    for (const rule of transition.preconditions.rules) {
      if (!rule.passed && !rule.requiresInput) reasons.push(rule.message);
    }
  }
  if (transition.cycleLimit && transition.cycleLimit.remaining <= 0) {
    reasons.push(`Cycle limit reached (${transition.cycleLimit.used}/${transition.cycleLimit.max})`);
  }
  return reasons;
}

export function TransitionCard({ transition, claim, users, specs, busy, onSubmit }: Props) {
  const initialValues = (): FieldValues =>
    Object.fromEntries(transition.inputs.map((field) => [field, emptyValue(fieldSpec(specs, field))]));

  const [values, setValues] = useState<FieldValues>(initialValues);
  const [notes, setNotes] = useState('');
  const [formKey, setFormKey] = useState(0);

  const { required, hints } = requiredInputs(transition);
  const reasons = blockedReasons(transition);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const ok = await onSubmit(toPayload(transition.inputs, values), notes.trim());
    if (ok) {
      setValues(initialValues());
      setNotes('');
      setFormKey((k) => k + 1);
    }
  };

  return (
    <div className={`card transition ${transition.enabled ? '' : 'disabled'}`}>
      <div className="transition-head">
        <strong>
          {claim.status} → {transition.to}
        </strong>
        <code className="muted">{transition.transitionId}</code>
        <span className="badge">{transition.roles.join(' | ')}</span>
        {transition.cycleLimit && (
          <span className="muted small">
            cycle {transition.cycleLimit.used}/{transition.cycleLimit.max}
          </span>
        )}
      </div>
      <div className="muted">{transition.description}</div>

      {reasons.length > 0 && (
        <ul className="reasons">
          {reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}

      {transition.enabled && (
        <form key={formKey} onSubmit={submit}>
          {transition.inputs.map((field) => (
            <FieldInput
              key={field}
              name={field}
              spec={fieldSpec(specs, field)}
              value={values[field]}
              onChange={(value) => setValues((prev) => ({ ...prev, [field]: value }))}
              users={users}
              required={required.get(field)}
              hints={hints.get(field)}
              current={claim.data[field]}
            />
          ))}
          <div className="field">
            <label>notes (optional)</label>
            <input type="text" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <button type="submit" disabled={busy}>
            Move to {transition.to}
          </button>
        </form>
      )}
    </div>
  );
}
