'use client';
import { useState } from 'react';

type Section = { label: string; roles: string[] };

/**
 * Pick a role from the company's role list (grouped), keep a name that isn't on the list, or type a new one.
 * A plain select, so every role shows whatever is currently chosen (a typed-in suggestion list hides the others).
 */
export default function RolePicker({ value, onChange, sections, required, ariaLabel }: { value: string; onChange: (v: string) => void; sections: Section[]; required?: boolean; ariaLabel?: string }) {
  const known = sections.some((g) => g.roles.some((r) => r.toLowerCase() === value.trim().toLowerCase()));
  const match = sections.flatMap((g) => g.roles).find((r) => r.toLowerCase() === value.trim().toLowerCase());
  const [typing, setTyping] = useState(false);
  if (typing || !sections.length)
    return (
      <span className="role-picker">
        <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Role name" required={required} maxLength={100} aria-label={ariaLabel} autoFocus={typing} />
        {sections.length > 0 && (
          <button type="button" className="btn ghost small" onClick={() => setTyping(false)}>Pick from list</button>
        )}
      </span>
    );
  return (
    <select
      value={known ? match : value}
      required={required}
      aria-label={ariaLabel}
      onChange={(e) => {
        if (e.target.value === '__other') setTyping(true);
        else onChange(e.target.value);
      }}
    >
      {!value && <option value="">Choose a role…</option>}
      {value && !known && <option value={value}>{value} (not on the role list)</option>}
      {sections.map((g) => (
        <optgroup key={g.label} label={g.label}>
          {g.roles.map((n) => <option key={n} value={n}>{n}</option>)}
        </optgroup>
      ))}
      <option value="__other">Other (type a name)…</option>
    </select>
  );
}
