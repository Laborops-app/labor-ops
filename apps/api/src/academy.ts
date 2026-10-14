import type { PoolClient } from 'pg';
import { decrypt, encrypt } from './crypto';

/**
 * Upstage Academy helpers: the per-company settings (shared secret and site address) and the course catalog,
 * read from the academy's public WordPress REST API (course groups are the `ual_group` taxonomy on `ual_course`).
 */

export type AcademyConfig = { secret: string; url: string };
export type CatalogCourse = { id: number; title: string; url: string };
export type CatalogGroup = { id: number; name: string; slug: string; description: string; url: string; courses: CatalogCourse[] };

export async function readAcademy(c: PoolClient): Promise<AcademyConfig> {
  const { rows } = await c.query("SELECT config_enc FROM integration_settings WHERE provider = 'academy'");
  if (!rows[0]) return { secret: '', url: '' };
  try {
    const v = JSON.parse(decrypt(rows[0].config_enc));
    return { secret: String(v.secret ?? ''), url: String(v.url ?? '') };
  } catch {
    return { secret: '', url: '' };
  }
}

export async function writeAcademy(c: PoolClient, tid: string, patch: Partial<AcademyConfig>, by: string | null) {
  const next = { ...(await readAcademy(c)), ...patch };
  await c.query(
    `INSERT INTO integration_settings (tenant_id, provider, config_enc, updated_by) VALUES ($1,'academy',$2,$3)
     ON CONFLICT (tenant_id, provider) DO UPDATE SET config_enc = EXCLUDED.config_enc, updated_by = COALESCE(EXCLUDED.updated_by, integration_settings.updated_by), updated_at = now()`,
    [tid, encrypt(JSON.stringify(next)), by],
  );
  return next;
}

/** "https://academy.example.com/some/path" → "https://academy.example.com". Only https sites are accepted. */
export function siteOrigin(raw: string): string | null {
  try {
    const u = new URL(raw.trim());
    if (u.protocol !== 'https:' || u.username || u.password) return null;
    return u.origin;
  } catch {
    return null;
  }
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“' };
/** WordPress sends titles as HTML ("Rock &#038; Roll"); turn that into plain text. */
export function plain(s: unknown): string {
  return String(s ?? '')
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}

export class AcademyError extends Error {}

async function getAll(base: string, path: string): Promise<any[]> {
  const out: any[] = [];
  for (let page = 1; page <= 20; page++) {
    let res: Response;
    try {
      res = await fetch(`${base}/wp-json/wp/v2/${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(20000),
        redirect: 'follow',
      });
    } catch {
      throw new AcademyError(`Could not reach the academy at ${base}. Check the address under Integrations.`);
    }
    if (res.status === 400 && page > 1) break; // past the last page
    if (!res.ok) throw new AcademyError(`The academy answered HTTP ${res.status} for ${path.split('?')[0]}. Check that the Upstage Academy LMS plugin is active.`);
    const list = await res.json().catch(() => null);
    if (!Array.isArray(list)) throw new AcademyError('The academy sent something unexpected. Check the address under Integrations.');
    out.push(...list);
    const pages = Number(res.headers.get('x-wp-totalpages') ?? '1');
    if (page >= pages || list.length < 100) break;
  }
  return out;
}

/** Every course group with its published courses. */
export async function fetchCatalog(base: string): Promise<CatalogGroup[]> {
  const [groups, courses] = await Promise.all([
    getAll(base, 'ual_group?_fields=id,name,slug,description,link'),
    getAll(base, 'ual_course?_fields=id,title,link,ual_group,menu_order&orderby=title&order=asc'),
  ]);
  return groups
    .filter((g) => Number.isInteger(g?.id))
    .map((g) => ({
      id: g.id,
      name: plain(g.name).slice(0, 200) || `Group ${g.id}`,
      slug: String(g.slug ?? '').slice(0, 200),
      description: plain(g.description).slice(0, 1000),
      url: siteOrigin(String(g.link ?? '')) === base ? String(g.link) : `${base}/courses/?ual_cat=${encodeURIComponent(String(g.slug ?? ''))}`,
      courses: courses
        .filter((c) => Array.isArray(c?.ual_group) && c.ual_group.includes(g.id))
        .map((c) => ({ id: Number(c.id), title: plain(c.title?.rendered ?? c.title).slice(0, 200), url: siteOrigin(String(c.link ?? '')) === base ? String(c.link) : `${base}/?p=${Number(c.id)}` })),
    }));
}

/** Where a new student signs up. With a course ID they are enrolled in it right after creating the account. */
export const signupUrl = (base: string, firstCourseId?: number) => `${base}/enroll/${firstCourseId ? `?ual_join=${firstCourseId}` : ''}`;
