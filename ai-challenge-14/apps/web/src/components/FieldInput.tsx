import { useId, useState } from 'react';
import type { UserConfig } from '@claims/engine';
import { formatValue, type FieldSpec, type FieldValue } from '../fields';

interface Props {
  name: string;
  spec: FieldSpec;
  value: FieldValue;
  onChange(value: FieldValue): void;
  users: UserConfig[];
  /** 'required' or 'one-of' when a precondition marks the field requiresInput. */
  required?: 'required' | 'one-of';
  hints?: string[];
  /** Value already on the claim; shown so the user knows what an empty field keeps. */
  current?: unknown;
}

export function FieldInput({ name, spec, value, onChange, users, required, hints = [], current }: Props) {
  const id = useId();
  return (
    <div className="field">
      <label htmlFor={id}>
        {name}
        {required === 'required' && <span className="required" title="Required by a precondition"> *</span>}
        {required === 'one-of' && <span className="required" title="At least one of the marked fields"> * (one of)</span>}
      </label>
      <Widget id={id} spec={spec} value={value} onChange={onChange} users={users} current={current} />
      {current !== undefined && <div className="muted small">Current: {formatValue(current)}</div>}
      {hints.map((hint) => (
        <div key={hint} className="hint small">
          {hint}
        </div>
      ))}
    </div>
  );
}

function Widget({
  id,
  spec,
  value,
  onChange,
  users,
  current,
}: Pick<Props, 'spec' | 'value' | 'onChange' | 'users' | 'current'> & { id: string }) {
  switch (spec.kind) {
    case 'user': {
      const candidates = users.filter((u) => u.role === spec.role);
      return (
        <select id={id} value={value as string} onChange={(e) => onChange(e.target.value)}>
          <option value="">{current !== undefined ? '(keep current)' : `— select ${spec.role} —`}</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.name} ({u.id})
            </option>
          ))}
        </select>
      );
    }
    case 'list':
      return <ListWidget id={id} options={spec.options} value={value as string[]} onChange={onChange} />;
    case 'text':
      return <textarea id={id} rows={2} value={value as string} onChange={(e) => onChange(e.target.value)} />;
  }
}

function ListWidget({
  id,
  options,
  value,
  onChange,
}: {
  id: string;
  options: string[];
  value: string[];
  onChange(value: string[]): void;
}) {
  const [other, setOther] = useState(() => value.filter((v) => !options.includes(v)).join(', '));

  const extras = (text: string) =>
    text
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s && !options.includes(s));

  const toggle = (option: string, checked: boolean) => {
    const picked = options.filter((o) => (o === option ? checked : value.includes(o)));
    onChange([...picked, ...extras(other)]);
  };

  return (
    <div className="list-widget">
      {options.map((option) => (
        <label key={option} className="checkbox">
          <input type="checkbox" checked={value.includes(option)} onChange={(e) => toggle(option, e.target.checked)} />
          {option}
        </label>
      ))}
      <input
        id={id}
        type="text"
        placeholder="other values, comma-separated"
        value={other}
        onChange={(e) => {
          setOther(e.target.value);
          onChange([...options.filter((o) => value.includes(o)), ...extras(e.target.value)]);
        }}
      />
    </div>
  );
}
