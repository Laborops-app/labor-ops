import type { PoolClient } from 'pg';
import { roleKeyOf } from './pay';

/**
 * Leads are chosen per event: an assignment marked as lead (or on a lead role such as "Audio Lead") leads
 * its department at that event. A department is the role's group under Roles & rates (Audio, Lighting,
 * Stage Hand…); a role in no group is its own department.
 */
const LEAD_SUFFIX = /\s*(\(\s*lead\s*\)|\blead)\s*$/i;
/** "Audio Lead" / "Audio (Lead)" → the key of "Audio". */
const baseKey = (role: string) => roleKeyOf(role.replace(LEAD_SUFFIX, '') || role);

export type Departments = { of: (role: string) => string; nameOf: (role: string) => string; isLeadRole: (role: string) => boolean };

export async function loadDepartments(c: PoolClient): Promise<Departments> {
  const rows = (await c.query('SELECT name, group_id, is_lead FROM skills')).rows as { name: string; group_id: string | null; is_lead: boolean }[];
  const byKey = new Map<string, { group: string | null; lead: boolean }>();
  for (const r of rows) {
    const k = roleKeyOf(r.name);
    const prev = byKey.get(k);
    if (!prev || (!prev.group && r.group_id)) byKey.set(k, { group: r.group_id, lead: r.is_lead });
  }
  const groups = new Map(((await c.query('SELECT id, name FROM skill_groups')).rows as { id: string; name: string }[]).map((g) => [g.id, g.name]));
  const find = (role: string) => byKey.get(roleKeyOf(role)) ?? byKey.get(baseKey(role));
  return {
    of: (role) => {
      const hit = find(role);
      return hit?.group ? `g:${hit.group}` : `r:${baseKey(role)}`;
    },
    nameOf: (role) => {
      const hit = find(role);
      return (hit?.group && groups.get(hit.group)) || role.replace(LEAD_SUFFIX, '').trim() || role;
    },
    isLeadRole: (role) => !!byKey.get(roleKeyOf(role))?.lead || LEAD_SUFFIX.test(role),
  };
}
