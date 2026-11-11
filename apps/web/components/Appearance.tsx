'use client';
import { useEffect, useState } from 'react';

type Look = 'classic' | 'modern';
type Theme = 'light' | 'dark' | 'device';

const read = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const write = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage blocked: applies for this visit only */ } };
const deviceTheme = () => (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');

/** Profile › Appearance: the look of the app (Classic or Modern) and light, dark or match-the-device. Saved on this device. */
export default function Appearance() {
  const [look, setLook] = useState<Look>('classic');
  const [theme, setTheme] = useState<Theme>('device');
  useEffect(() => {
    setLook(read('lo-look') === 'modern' ? 'modern' : 'classic');
    const t = read('lo-theme');
    setTheme(t === 'light' || t === 'dark' ? t : 'device');
  }, []);
  const pickLook = (l: Look) => { setLook(l); document.documentElement.dataset.look = l; write('lo-look', l); };
  const pickTheme = (t: Theme) => {
    setTheme(t);
    document.documentElement.dataset.theme = t === 'device' ? deviceTheme() : t;
    write('lo-theme', t === 'device' ? null : t);
  };
  const looks: { k: Look; name: string; text: string; side: string; page: string; card: string; accent: string }[] = [
    { k: 'classic', name: 'Classic', text: 'The original LaborOps look: soft glass menu and rounded panels.', side: '#fde9dc', page: '#f6fafd', card: '#ffffff', accent: '#e58025' },
    { k: 'modern', name: 'Modern', text: 'Navy menu, crisp white cards with soft shadows and bolder numbers.', side: '#0b2540', page: '#f2f4f8', card: '#ffffff', accent: '#514ef3' },
  ];
  return (
    <section className="card">
      <h2>Appearance</h2>
      <p className="muted small">How LaborOps looks for you on this device. Other people aren’t affected.</p>
      <div className="ap-grid" role="radiogroup" aria-label="Look">
        {looks.map((l) => (
          <button key={l.k} type="button" role="radio" aria-checked={look === l.k} className={look === l.k ? 'ap-opt on' : 'ap-opt'} onClick={() => pickLook(l.k)}>
            <span className="ap-prev" aria-hidden="true" style={{ background: l.page }}>
              <i style={{ background: l.side }} />
              <span>
                <b style={{ background: l.card }} />
                <b style={{ background: l.card }} />
                <em style={{ background: l.accent }} />
              </span>
            </span>
            <span className="ap-name">{l.name}{look === l.k && <span className="chip open">In use</span>}</span>
            <span className="muted small">{l.text}</span>
          </button>
        ))}
      </div>
      <div className="row" style={{ marginTop: 14, gap: 12 }}>
        <span className="small" id="ap-theme-label" style={{ fontWeight: 600 }}>Theme</span>
        <div className="seg" role="radiogroup" aria-labelledby="ap-theme-label">
          {([['light', 'Light'], ['dark', 'Dark'], ['device', 'Match device']] as const).map(([k, label]) => (
            <button key={k} type="button" role="radio" aria-checked={theme === k} className={theme === k ? 'active' : ''} onClick={() => pickTheme(k)}>{label}</button>
          ))}
        </div>
      </div>
    </section>
  );
}
