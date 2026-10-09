'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

/** Names of the company's active skills / roles, for drop-downs. */
export function useSkillNames() {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    api<{ skills: { name: string; active: boolean }[] }>('/api/skills')
      .then((r) => setNames(r.skills.filter((s) => s.active).map((s) => s.name)))
      .catch(() => {});
  }, []);
  return names;
}

/** Pick skills from the company list with a drop-down; chosen ones show as removable chips. */
export default function SkillPicker({ value, onChange, options, label = 'Add a skill…' }: { value: string[]; onChange: (v: string[]) => void; options: string[]; label?: string }) {
  const [text, setText] = useState('');
  const left = options.filter((o) => !value.some((v) => v.toLowerCase() === o.toLowerCase()));
  const add = (s: string) => {
    const t = s.trim();
    if (t && !value.some((v) => v.toLowerCase() === t.toLowerCase())) onChange([...value, t]);
  };
  return (
    <div className="skill-picker">
      {value.length > 0 && (
        <div className="skill-chips">
          {value.map((s) => (
            <span key={s} className="chip">
              {s}
              <button type="button" className="chip-x" onClick={() => onChange(value.filter((x) => x !== s))} aria-label={`Remove ${s}`}>
                ✕
              </button>
            </span>
          ))}
        </div>
      )}
      {options.length > 0 ? (
        <select
          value=""
          aria-label={label}
          onChange={(e) => {
            add(e.target.value);
          }}
          disabled={left.length === 0}
        >
          <option value="">{left.length ? label : 'All skills added'}</option>
          {left.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      ) : (
        <input
          value={text}
          placeholder="Type a skill and press Enter"
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add(text);
              setText('');
            }
          }}
          aria-label={label}
        />
      )}
    </div>
  );
}
