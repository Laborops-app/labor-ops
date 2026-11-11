import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import ExcelJS from 'exceljs';
import type { PoolClient } from 'pg';
import { pool, audit } from './db';
import { roleKeyOf } from './pay';
import { refreshRating, reviewRoleKey } from './reviews';

// ---------- reading a spreadsheet ----------

/** A CSV line split into cells (quotes, doubled quotes and commas inside quotes handled). */
function csvRows(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (ch === '"') q = false;
      else cell += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',' || ch === ';' || ch === '\t') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); out.push(row); row = []; cell = '';
    } else cell += ch;
  }
  if (cell || row.length) { row.push(cell); out.push(row); }
  return out.filter((r) => r.some((c) => c.trim()));
}

const cellText = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') {
    const o = v as any;
    if (o.text) return String(o.text);                       // hyperlink / rich text cell
    if (o.richText) return o.richText.map((r: any) => r.text).join('');
    if (o.result !== undefined) return String(o.result);     // formula
    if (v instanceof Date) return v.toISOString().slice(0, 10);
  }
  return String(v);
};

/** The first sheet of an .xlsx (or a .csv) as rows of text cells. */
export async function readSheet(buf: Buffer, filename: string): Promise<string[][]> {
  if (/\.(csv|txt|tsv)$/i.test(filename)) return csvRows(buf.toString('utf8').replace(/^﻿/, ''));
  if (!/\.xlsx$/i.test(filename)) throw new ImportError('Upload an Excel file (.xlsx) or a CSV. Older .xls files: open in Excel and Save As .xlsx.');
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buf as any);
  } catch {
    throw new ImportError('That file could not be read as an Excel workbook.');
  }
  const ws = wb.worksheets.find((w) => w.actualRowCount > 0);
  if (!ws) return [];
  const rows: string[][] = [];
  ws.eachRow({ includeEmpty: false }, (r) => {
    const cells: string[] = [];
    for (let i = 1; i <= Math.max(r.cellCount, ws.columnCount); i++) cells.push(cellText(r.getCell(i).value).trim());
    if (cells.some(Boolean)) rows.push(cells);
  });
  return rows;
}

export class ImportError extends Error {}

// ---------- which column is which ----------

export const FIELDS = ['name', 'first', 'last', 'email', 'phone', 'roles', 'address', 'emergencyName', 'emergencyPhone', 'notes'] as const;
export type Field = (typeof FIELDS)[number];
const GUESS: [Field, RegExp][] = [
  ['emergencyPhone', /emergency.*(phone|number|tel)|(ice|emergency).*(cell|mobile)/],
  ['emergencyName', /emergency|ice contact|next of kin/],
  ['first', /^first|given name|first name|fname/],
  ['last', /^last|surname|family name|last name|lname/],
  ['email', /e-?mail/],
  ['phone', /phone|mobile|cell|tel|number/],
  ['roles', /role|position|skill|job|title|department|trade|craft/],
  ['address', /address|street|city/],
  ['notes', /note|comment|remark/],
  ['name', /name|crew|employee|worker|person/],
];

/** Header row → field per column (first match wins; each field used once). */
export function guessColumns(header: string[]): (Field | null)[] {
  const used = new Set<Field>();
  return header.map((h) => {
    const t = h.toLowerCase().trim();
    for (const [f, re] of GUESS) if (!used.has(f) && re.test(t)) { used.add(f); return f; }
    return null;
  });
}

export type ImportRow = {
  row: number; name: string; email: string; phone: string | null; roles: string[]; address: string | null;
  emergencyName: string | null; emergencyPhone: string | null; notes: string | null; problems: string[];
};

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Spreadsheet rows → people to add, each with any problems found (bad email, duplicate, already registered). */
export async function previewImport(c: PoolClient, rows: string[][], columns?: (Field | null)[]) {
  if (rows.length < 2) throw new ImportError('The sheet needs a header row and at least one person.');
  if (rows.length > 2001) throw new ImportError('Import up to 2,000 people at a time.');
  const header = rows[0];
  const cols = columns && columns.length === header.length ? columns : guessColumns(header);
  if (!cols.includes('email')) throw new ImportError('No email column found. Add a column called "Email" (every person needs one to sign in).');
  if (!cols.includes('name') && !cols.includes('first')) throw new ImportError('No name column found. Add a "Name" column (or "First name" and "Last name").');
  const get = (r: string[], f: Field) => { const i = cols.indexOf(f); return i >= 0 ? (r[i] ?? '').trim() : ''; };
  const skills = (await c.query('SELECT name FROM skills WHERE active')).rows.map((r) => r.name as string);
  const byKey = new Map(skills.map((s) => [roleKeyOf(s), s]));
  const unknown = new Set<string>();
  const seen = new Set<string>();
  const out: ImportRow[] = [];
  rows.slice(1).forEach((r, i) => {
    const name = get(r, 'name') || [get(r, 'first'), get(r, 'last')].filter(Boolean).join(' ');
    const email = get(r, 'email').toLowerCase();
    if (!name && !email) return;
    const roles = [...new Set(get(r, 'roles').split(/[,;/|\n]+/).map((x) => x.trim()).filter(Boolean).map((x) => {
      const hit = byKey.get(roleKeyOf(x));
      if (!hit) unknown.add(x);
      return hit ?? x;
    }))].slice(0, 30);
    const problems: string[] = [];
    if (!name) problems.push('No name');
    if (!email) problems.push('No email');
    else if (!EMAIL.test(email)) problems.push('Email doesn’t look right');
    else if (seen.has(email)) problems.push('Same email as a row above');
    if (email) seen.add(email);
    out.push({
      row: i + 2, name: name.slice(0, 100), email: email.slice(0, 200), phone: get(r, 'phone').slice(0, 40) || null, roles,
      address: get(r, 'address').slice(0, 300) || null, emergencyName: get(r, 'emergencyName').slice(0, 100) || null,
      emergencyPhone: get(r, 'emergencyPhone').slice(0, 40) || null, notes: get(r, 'notes').slice(0, 1000) || null, problems,
    });
  });
  // Already registered (in any company: an email signs in to one account).
  const emails = out.filter((x) => !x.problems.length).map((x) => x.email);
  for (const e of emails) {
    if ((await pool.query('SELECT 1 FROM auth_find_user($1)', [e])).rowCount) out.find((x) => x.email === e)!.problems.push('Already has a LaborOps account');
  }
  return { header, columns: cols, rows: out, unknownRoles: [...unknown].sort(), ready: out.filter((x) => !x.problems.length).length };
}

/** Add the people. Rows with problems are skipped and listed. New role names can be added to the role list. */
export async function runImport(c: PoolClient, tid: string, by: string, rows: ImportRow[], o: { createRoles: boolean; invite: (user: any) => Promise<void> }) {
  let created = 0, rolesAdded = 0;
  const skipped: { row: number; name: string; reason: string }[] = [];
  if (o.createRoles) {
    const have = new Set((await c.query('SELECT name FROM skills')).rows.map((r) => roleKeyOf(r.name)));
    for (const name of new Set(rows.flatMap((r) => r.roles))) {
      if (have.has(roleKeyOf(name))) continue;
      await c.query('INSERT INTO skills (tenant_id, name, pay_rate) VALUES ($1,$2,0) ON CONFLICT DO NOTHING', [tid, name.slice(0, 40)]);
      have.add(roleKeyOf(name));
      rolesAdded++;
    }
  }
  for (const r of rows) {
    if (r.problems?.length) { skipped.push({ row: r.row, name: r.name, reason: r.problems.join(', ') }); continue; }
    if (!r.name || !EMAIL.test(r.email)) { skipped.push({ row: r.row, name: r.name, reason: 'Name and a valid email are needed' }); continue; }
    if ((await pool.query('SELECT 1 FROM auth_find_user($1)', [r.email])).rowCount) { skipped.push({ row: r.row, name: r.name, reason: 'Already has a LaborOps account' }); continue; }
    await c.query('SAVEPOINT imp');
    try {
      const hash = await bcrypt.hash(crypto.randomBytes(12).toString('base64url'), 8);
      const u = (await c.query(
        `INSERT INTO users (tenant_id, email, name, role, password_hash, phone, skills, address, emergency_name, emergency_phone, coordinator_notes)
         VALUES ($1,$2,$3,'crew',$4,$5,$6,$7,$8,$9,$10) RETURNING id, name, email, role, phone`,
        [tid, r.email, r.name, hash, r.phone, r.roles.map((x) => x.slice(0, 40)), r.address, r.emergencyName, r.emergencyPhone, r.notes],
      )).rows[0];
      await c.query('RELEASE SAVEPOINT imp');
      await o.invite(u);
      created++;
    } catch (e) {
      await c.query('ROLLBACK TO SAVEPOINT imp');
      skipped.push({ row: r.row, name: r.name, reason: (e as any)?.code === '23505' ? 'Email already used' : 'Could not be added' });
    }
  }
  await audit(c, tid, by, 'crew.import', 'user', null, { created, skipped: skipped.length, rolesAdded });
  return { created, skipped, rolesAdded };
}

// ---------- demo crew ----------

const FIRST = ['Avery', 'Blake', 'Cameron', 'Dakota', 'Emerson', 'Finley', 'Gray', 'Harley', 'Indy', 'Jesse', 'Kai', 'Logan', 'Marley', 'Noel', 'Oakley', 'Parker', 'Quinn',
  'Reese', 'Sage', 'Tatum', 'Val', 'Wren', 'Ari', 'Bo', 'Cruz', 'Devon', 'Eli', 'Frankie', 'Hayden', 'Jules', 'Kendall', 'Lane', 'Milan', 'Nico', 'Rowan', 'Skyler', 'Toby', 'Jamie',
  'Morgan', 'Riley', 'Casey', 'Drew', 'Ellis', 'Jordan', 'Kris', 'Lee', 'Max', 'Robin', 'Sam', 'Taylor'];
const LAST = ['Alvarez', 'Bennett', 'Castillo', 'Dawson', 'Ellis', 'Foster', 'Garcia', 'Hughes', 'Ibarra', 'Jensen', 'Kim', 'Lopez', 'Moreno', 'Nash', 'Ortiz', 'Patel', 'Quintero',
  'Ramos', 'Silva', 'Torres', 'Underwood', 'Vasquez', 'Walsh', 'Xu', 'Young', 'Zamora', 'Avila', 'Brooks', 'Chavez', 'Diaz', 'Evans', 'Flores', 'Gomez', 'Hale', 'Irwin', 'James',
  'Kerr', 'Lin', 'Mendez', 'Novak', 'Price', 'Reed', 'Shaw', 'Tran', 'Vega', 'Webb', 'Cole', 'Fox', 'Grant', 'Hart'];
const NOTES: Record<number, string[]> = {
  5: ['Excellent. Would book again anytime.', 'Ran the crew like a pro.', 'Fast, careful and great with clients.'],
  4: ['Solid work all day.', 'Reliable, good attitude.', 'Knows the gear well.'],
  3: ['Did the job; needed some direction.', 'Okay, a bit slow on the strike.'],
  2: ['Showed up late and left early.', 'Needed a lot of supervision.'],
  1: ['Would not book again.'],
};
const GOOD_TAGS = ['on_time', 'hard_worker', 'skilled', 'team_player', 'safe', 'rehire'];

/**
 * Sample crew for trying things out: `perRole` people for each active role, each with a few star ratings for that role.
 * They're marked as demo (so they can be removed in one go), can't sign in, and get no emails or texts.
 */
export async function addDemoCrew(c: PoolClient, tid: string, by: string, perRole = 15) {
  const roles = (await c.query('SELECT name FROM skills WHERE active ORDER BY name')).rows.map((r) => r.name as string);
  if (!roles.length) throw new ImportError('Add some roles first (Roles page), then add demo crew for them.');
  const slug = (await c.query('SELECT lower(regexp_replace(name, \'[^a-zA-Z0-9]+\', \'\', \'g\')) AS s FROM tenants WHERE id = $1', [tid])).rows[0]?.s?.slice(0, 20) || 'co';
  const tag = crypto.randomBytes(3).toString('hex');
  const hash = await bcrypt.hash(crypto.randomBytes(16).toString('base64url'), 8);
  let made = 0, reviews = 0, n = 0;
  for (const role of roles) {
    for (let i = 0; i < perRole; i++, n++) {
      const first = FIRST[(n * 7 + i) % FIRST.length], last = LAST[(n * 11 + roles.indexOf(role) * 3) % LAST.length];
      const name = `${first} ${last}`;
      const email = `${first}.${last}.${tag}${n}@demo-crew.${slug}.invalid`.toLowerCase();
      // Some people are also good at a second role.
      const second = roles.length > 1 && Math.random() < 0.3 ? roles[(roles.indexOf(role) + 1 + Math.floor(Math.random() * (roles.length - 1))) % roles.length] : null;
      const phone = `555${String(1000000 + Math.floor(Math.random() * 8999999)).slice(0, 7)}`;
      const u = (await c.query(
        `INSERT INTO users (tenant_id, email, name, role, password_hash, phone, skills, is_demo, notify_email, notify_sms)
         VALUES ($1,$2,$3,'crew',$4,$5,$6, true, false, false) RETURNING id`,
        [tid, email, name, hash, phone, second ? [role, second] : [role]],
      )).rows[0];
      made++;
      // A typical spread: most crew 4–5 stars, a few 3, the odd 2.
      const base = [5, 5, 5, 4, 4, 4, 4, 4, 3, 3, 2][Math.floor(Math.random() * 11)];
      for (const r of second ? [role, second] : [role]) {
        const key = reviewRoleKey(r);
        const count = 2 + Math.floor(Math.random() * 5);
        for (let k = 0; k < count; k++) {
          const stars = Math.max(1, Math.min(5, base + [0, 0, 0, 1, -1][Math.floor(Math.random() * 5)]));
          const tags = stars >= 4 ? [GOOD_TAGS[Math.floor(Math.random() * GOOD_TAGS.length)]] : stars <= 2 ? [['late', 'needs_supervision', 'left_early'][Math.floor(Math.random() * 3)]] : [];
          const note = Math.random() < 0.6 ? NOTES[stars][Math.floor(Math.random() * NOTES[stars].length)] : null;
          await c.query(
            `INSERT INTO crew_reviews (tenant_id, user_id, role_key, stars, tags, note, rated_by, created_at, updated_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7, now() - ($8 || ' days')::interval, now() - ($8 || ' days')::interval)`,
            [tid, u.id, key, stars, tags, note, by, String(Math.floor(Math.random() * 180))],
          );
          reviews++;
        }
        await refreshRating(c, tid, u.id, key);
      }
    }
  }
  await audit(c, tid, by, 'crew.demo_add', 'user', null, { made, roles: roles.length, perRole });
  return { made, roles: roles.length, reviews };
}

export async function removeDemoCrew(c: PoolClient, tid: string, by: string) {
  const r = await c.query('DELETE FROM users WHERE is_demo RETURNING id');
  await audit(c, tid, by, 'crew.demo_remove', 'user', null, { removed: r.rowCount });
  return { removed: r.rowCount ?? 0 };
}

// ---------- export for Rentman's crew import ----------

/** "Dana Marie Lee" → first, middle, last (one word goes in the last name). */
export function splitName(full: string) {
  const parts = full.trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { first: '', middle: '', last: parts[0] ?? '' };
  return { first: parts[0], middle: parts.slice(1, -1).join(' '), last: parts[parts.length - 1] };
}

/**
 * Active crew as a one-sheet .xlsx in Rentman's crew import layout (Crew members › Import): plain-text cells, the first
 * row as headers named like Rentman's fields so they match on their own. Folder is each person's first role, so Rentman
 * files them by position. Demo crew are left out; `onlyMissing` leaves out people already linked to Rentman crew.
 */
export async function rentmanCrewSheet(c: PoolClient, o: { onlyMissing: boolean; folders: boolean }) {
  const rows = (
    await c.query(
      `SELECT u.name, u.email, u.phone, u.skills, u.address, u.emergency_name, u.emergency_phone
         FROM users u
        WHERE u.active AND u.role = 'crew' AND NOT u.is_demo
          AND ($1::boolean IS NOT TRUE OR NOT EXISTS (SELECT 1 FROM rentman_crew rc WHERE rc.user_id = u.id))
        ORDER BY lower(u.name)`,
      [o.onlyMissing],
    )
  ).rows;
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Crew members');
  const head = ['First name', 'Middle name', 'Last name', 'Email', 'Phone', ...(o.folders ? ['Folder'] : []), 'Description', 'Emergency contact', 'Address'];
  ws.addRow(head);
  for (const r of rows) {
    const n = splitName(r.name);
    const skills: string[] = r.skills ?? [];
    const emergency = [r.emergency_name, r.emergency_phone].filter(Boolean).join(' ');
    ws.addRow([
      n.first, n.middle, n.last, r.email ?? '', r.phone ?? '', ...(o.folders ? [skills[0] ?? ''] : []),
      skills.length ? `Roles: ${skills.join(', ')}` : '', emergency, (r.address ?? '').replace(/\s*\n\s*/g, ', '),
    ].map((v) => String(v)));
  }
  // Plain text everywhere (phone numbers keep their leading zeros and dashes).
  ws.eachRow((row) => row.eachCell((cell) => { cell.numFmt = '@'; }));
  ws.columns.forEach((col, i) => { col.width = Math.max(14, head[i].length + 4); });
  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), count: rows.length };
}
