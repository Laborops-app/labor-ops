'use client';
import { useEffect, useState } from 'react';
import { api } from '@/lib/api';

export type Section = { label: string; roles: string[] };

/** Active roles arranged by group (ungrouped ones last), for drop-downs with headings. */
export function useSkillSections() {
  const [sections, setSections] = useState<Section[]>([]);
  useEffect(() => {
    api<{ groups: { id: string; name: string }[]; skills: { name: string; active: boolean; groupId: string | null }[] }>('/api/skills')
      .then((r) => {
        const live = r.skills.filter((s) => s.active);
        const out: Section[] = r.groups.map((g) => ({ label: g.name, roles: live.filter((s) => s.groupId === g.id).map((s) => s.name) })).filter((g) => g.roles.length);
        const loose = live.filter((s) => !s.groupId || !r.groups.some((g) => g.id === s.groupId)).map((s) => s.name);
        if (loose.length) out.push({ label: out.length ? 'Other roles' : 'Roles', roles: loose });
        setSections(out);
      })
      .catch(() => {});
  }, []);
  return sections;
}

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
export default function SkillPicker({ value, onChange, options, sections, label = 'Add a skill…' }: { value: string[]; onChange: (v: string[]) => void; options: string[]; sections?: Section[]; label?: string }) {
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
          {sections && sections.length > 1
            ? sections.map((g) => {
                const r = g.roles.filter((o) => left.includes(o));
                return r.length ? (
                  <optgroup key={g.label} label={g.label}>
                    {r.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </optgroup>
                ) : null;
              })
            : left.map((o) => (
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
