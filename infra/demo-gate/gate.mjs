// LaborOps demo gate (demoapp.laborops.app).
// Starts the demo stack (demo-db, demo-api, demo-web) when someone opens the demo, proxies to it while it runs, wipes and
// restarts it every 2 hours, and shuts it down after an hour with nobody using it. While it boots, visitors see a
// spinning logo with an estimated percentage. No dependencies: Node's http module plus the docker CLI.
import http from 'node:http';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';

const env = (k, d) => process.env[k] ?? d;
const PROJECT = env('COMPOSE_PROJECT', 'laborops');
const PROJECT_DIR = env('PROJECT_DIR', '/project');
const SERVICES = env('DEMO_SERVICES', 'demo-db demo-api demo-web').split(/\s+/).filter(Boolean);
const API = env('DEMO_API', 'http://demo-api:4000');
const WEB = env('DEMO_WEB', 'http://demo-web:3000');
const RESET_MS = Number(env('DEMO_RESET_MIN', '120')) * 60_000;
const IDLE_MS = Number(env('DEMO_IDLE_MIN', '60')) * 60_000;
const EXPECT_MS = Number(env('DEMO_EXPECTED_BOOT_S', '40')) * 1000;
const PASSWORD = env('DEMO_PASSWORD', 'LaborOps-Demo-1');
const LOGO = readFileSync(new URL('./logo.png', import.meta.url));

/** off → starting → on → (reset: starting again | idle: off) */
const st = { phase: 'off', startedAt: 0, readyAt: 0, lastSeen: 0, milestone: 0, error: null };

const compose = (...args) =>
  new Promise((resolve, reject) =>
    execFile('docker', ['compose', '-p', PROJECT, '--project-directory', PROJECT_DIR, '-f', `${PROJECT_DIR}/docker-compose.yml`, '--profile', 'demo', ...args],
      { timeout: 300_000 }, (err, stdout, stderr) => (err ? reject(new Error(String(stderr || err.message).slice(-500))) : resolve(String(stdout)))));

const reachable = (url) =>
  new Promise((resolve) => {
    const req = http.get(url, { timeout: 2500 }, (res) => { res.resume(); resolve(res.statusCode && res.statusCode < 500); });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let booting = null;
async function start() {
  if (st.phase === 'on' || booting) return booting;
  booting = (async () => {
    Object.assign(st, { phase: 'starting', startedAt: Date.now(), milestone: 3, error: null, lastSeen: Date.now() });
    try {
      // Fresh containers every time: the database lives in memory (tmpfs), so this is also the reset.
      await compose('up', '-d', '--no-build', '--force-recreate', ...SERVICES);
      st.milestone = 30;
      const deadline = Date.now() + 240_000;
      while (!(await reachable(`${API}/api/health`))) { if (Date.now() > deadline) throw new Error('the demo API did not start'); await sleep(1000); }
      st.milestone = 85; // migrations and sample data are done before the API answers
      while (!(await reachable(`${WEB}/login`))) { if (Date.now() > deadline) throw new Error('the demo web app did not start'); await sleep(1000); }
      Object.assign(st, { phase: 'on', readyAt: Date.now(), milestone: 100 });
      console.log(`demo up in ${Math.round((Date.now() - st.startedAt) / 1000)} s`);
    } catch (e) {
      console.error('demo start failed:', e.message);
      Object.assign(st, { phase: 'off', error: 'The demo could not start. Please try again in a minute.' });
      await compose('rm', '-sf', ...SERVICES).catch(() => undefined);
    } finally {
      booting = null;
    }
  })();
  return booting;
}

async function stop(reason) {
  if (st.phase === 'off' || booting) return;
  console.log(`demo stopping (${reason})`);
  st.phase = 'off';
  await compose('rm', '-sf', ...SERVICES).catch((e) => console.error('demo stop failed:', e.message));
}

/** Estimated progress: the larger of the last real milestone and a time-based guess, never quite 100 until it is up. */
function progress() {
  if (st.phase === 'on') return 100;
  if (st.phase !== 'starting') return 0;
  const byTime = Math.min(97, ((Date.now() - st.startedAt) / EXPECT_MS) * 95);
  return Math.round(Math.max(st.milestone, byTime));
}
const status = () => ({
  phase: st.phase, progress: progress(), error: st.error,
  resetsAt: st.phase === 'on' ? new Date(st.readyAt + RESET_MS).toISOString() : null,
  stopsWhenIdleAt: st.phase === 'on' ? new Date(st.lastSeen + IDLE_MS).toISOString() : null,
  password: PASSWORD,
  accounts: [
    { label: 'Admin', email: 'admin@demo.laborops.app' }, { label: 'HR', email: 'hr@demo.laborops.app' },
    { label: 'Labor Coordinator', email: 'manager@demo.laborops.app' }, { label: 'Crew member', email: 'crew1@demo.laborops.app' },
  ],
});

// Every 30 s: reset after 2 hours (only if someone is still around), stop after an hour of nobody.
let misses = 0;
setInterval(async () => {
  if (st.phase !== 'on') return;
  // Containers gone (server restart, deploy): forget them, the next visitor starts a fresh demo.
  if (!(await reachable(`${API}/api/health`))) {
    if (++misses >= 3) { misses = 0; return stop('not reachable'); }
  } else misses = 0;
  const idle = Date.now() - st.lastSeen;
  if (idle > IDLE_MS) return stop('idle');
  if (Date.now() - st.readyAt > RESET_MS) {
    if (idle > 10 * 60_000) return stop('reset time, nobody active');
    console.log('demo reset');
    st.phase = 'resetting';
    await compose('rm', '-sf', ...SERVICES).catch(() => undefined);
    st.phase = 'off';
    start();
  }
}, 30_000).unref();

// On boot, adopt a demo that is already running (the gate was restarted by a deploy).
compose('ps', '--status', 'running', '-q', ...SERVICES).then((out) => {
  if (out.trim().split('\n').filter(Boolean).length === SERVICES.length) Object.assign(st, { phase: 'on', startedAt: Date.now(), readyAt: Date.now(), lastSeen: Date.now(), milestone: 100 });
}).catch(() => undefined);

// ---------- HTTP ----------
function proxy(req, res, head) {
  const target = new URL(req.url.startsWith('/api/') ? API : WEB);
  const headers = { ...req.headers, 'x-forwarded-host': req.headers.host ?? '', 'x-forwarded-proto': 'https' };
  const up = http.request({ host: target.hostname, port: target.port, method: req.method, path: req.url, headers }, (r) => {
    res.writeHead(r.statusCode ?? 502, r.headers);
    r.pipe(res);
  });
  up.on('error', () => {
    if (!res.headersSent) { res.writeHead(502, { 'content-type': 'text/plain' }); res.end('The demo is restarting. Reload in a moment.'); }
  });
  req.pipe(up);
  void head;
}

const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };

const server = http.createServer((req, res) => {
  const path = (req.url ?? '/').split('?')[0];
  if (path === '/__demo/status') {
    // The banner polls this only while the page is visible, so it counts as someone using the demo.
    if (st.phase === 'on' && req.headers['x-demo-active'] === '1') st.lastSeen = Date.now();
    return json(res, 200, status());
  }
  if (path === '/__demo/start' && req.method === 'POST') { start(); return json(res, 202, status()); }
  if (path === '/__demo/logo.png') { res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' }); return res.end(LOGO); }
  if (path === '/__demo/health') return json(res, 200, { ok: true });
  if (st.phase === 'on') {
    st.lastSeen = Date.now();
    return proxy(req, res);
  }
  if (path.startsWith('/api/')) return json(res, 503, { error: 'The demo is starting. Try again in a few seconds.' });
  if (req.method === 'GET' && String(req.headers.accept ?? '').includes('text/html')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(LOADING);
  }
  res.writeHead(503, { 'content-type': 'text/plain', 'retry-after': '5' });
  res.end('The demo is starting.');
});
server.on('upgrade', (req, socket, head) => {
  if (st.phase !== 'on') return socket.destroy();
  st.lastSeen = Date.now();
  const target = new URL(req.url.startsWith('/api/') ? API : WEB);
  const up = http.request({ host: target.hostname, port: target.port, path: req.url, method: req.method, headers: req.headers });
  up.on('upgrade', (r, upSock, upHead) => {
    socket.write(`HTTP/1.1 101 Switching Protocols\r\n${Object.entries(r.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n')}\r\n\r\n`);
    if (upHead?.length) socket.write(upHead);
    if (head?.length) upSock.write(head);
    upSock.pipe(socket).pipe(upSock);
  });
  up.on('error', () => socket.destroy());
  up.end();
});
server.listen(8080, () => console.log('demo gate on :8080'));

const LOADING = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Starting the LaborOps demo</title><meta name="robots" content="noindex">
<style>
:root{--bg:#f6fafd;--card:#fff;--text:#092c4c;--muted:#7e92a2;--primary:#514ef3;--soft:#ececfe;--border:#eaeef4}
@media (prefers-color-scheme:dark){:root{--bg:#0f1d2b;--card:#132536;--text:#e8f0f7;--muted:#8fa3b5;--primary:#7b79f7;--soft:rgba(123,121,247,.16);--border:#20364b}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;background:var(--bg);color:var(--text);font:16px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;padding:24px 16px}
.card{width:100%;max-width:460px;background:var(--card);border:1px solid var(--border);border-radius:20px;padding:32px 28px;text-align:center}
.spin{width:96px;height:96px;margin:0 auto 18px;position:relative}
.spin img{width:64px;height:64px;position:absolute;inset:16px;border-radius:14px;animation:pulse 1.6s ease-in-out infinite}
.spin svg{position:absolute;inset:0;animation:rot 1.1s linear infinite}
@keyframes rot{to{transform:rotate(360deg)}}@keyframes pulse{50%{transform:scale(.92)}}
@media (prefers-reduced-motion:reduce){.spin svg,.spin img{animation:none}}
h1{font-size:1.35rem;margin:0 0 4px}.muted{color:var(--muted);font-size:.92rem}
.pct{font-size:2.2rem;font-weight:800;color:var(--primary);font-variant-numeric:tabular-nums;margin:14px 0 6px}
.bar{height:8px;background:var(--soft);border-radius:8px;overflow:hidden}.bar span{display:block;height:100%;width:0;background:var(--primary);border-radius:8px;transition:width .6s ease}
.logins{margin-top:22px;text-align:left;border-top:1px solid var(--border);padding-top:16px}
.logins table{width:100%;border-collapse:collapse;font-size:.9rem}.logins td{padding:4px 0}.logins td:first-child{color:var(--muted);width:42%}
code{font-family:ui-monospace,Menlo,monospace;font-size:.85rem}
.err{color:#d9474c;margin-top:12px}button{font:inherit;font-weight:600;border:0;border-radius:999px;background:var(--primary);color:#fff;padding:10px 20px;margin-top:12px;cursor:pointer}
</style></head><body>
<main class="card" aria-live="polite">
  <div class="spin" aria-hidden="true">
    <svg viewBox="0 0 96 96" width="96" height="96"><circle cx="48" cy="48" r="44" fill="none" stroke="currentColor" stroke-opacity=".12" stroke-width="6"/><path d="M48 4a44 44 0 0 1 44 44" fill="none" stroke="#514ef3" stroke-width="6" stroke-linecap="round"/></svg>
    <img src="/__demo/logo.png" alt="">
  </div>
  <h1>Spinning up your demo</h1>
  <div class="muted" id="msg">Loading a sample company with crew, events and timesheets…</div>
  <div class="pct" id="pct">0%</div>
  <div class="bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" id="bar"><span id="fill"></span></div>
  <div class="err" id="err" hidden></div>
  <section class="logins">
    <div class="muted" style="margin-bottom:6px">Sign in with any of these (password <code>${PASSWORD}</code>):</div>
    <table>
      <tr><td>Admin</td><td><code>admin@demo.laborops.app</code></td></tr>
      <tr><td>HR</td><td><code>hr@demo.laborops.app</code></td></tr>
      <tr><td>Labor Coordinator</td><td><code>manager@demo.laborops.app</code></td></tr>
      <tr><td>Crew member</td><td><code>crew1@demo.laborops.app</code></td></tr>
    </table>
    <div class="muted" style="margin-top:8px">The demo is shared and wiped every 2 hours.</div>
  </section>
</main>
<script>
const $ = (id) => document.getElementById(id);
let shown = 0;
async function tick() {
  try {
    const s = await fetch('/__demo/status', { cache: 'no-store' }).then((r) => r.json());
    if (s.phase === 'on') { shown = 100; paint(); $('msg').textContent = 'Ready! Opening the sign-in page…'; setTimeout(() => location.replace(location.pathname === '/' ? '/login' : location.href), 600); return; }
    if (s.phase === 'off') {
      if (s.error) { $('err').hidden = false; $('err').innerHTML = s.error + '<br><button onclick="go()">Try again</button>'; return; }
      await fetch('/__demo/start', { method: 'POST' });
    }
    shown = Math.max(shown, s.progress || 0); paint();
  } catch (e) {}
  setTimeout(tick, 1000);
}
function paint() { $('pct').textContent = shown + '%'; $('fill').style.width = shown + '%'; $('bar').setAttribute('aria-valuenow', shown); }
function go() { $('err').hidden = true; fetch('/__demo/start', { method: 'POST' }).then(() => setTimeout(tick, 500)); }
fetch('/__demo/start', { method: 'POST' }).finally(tick);
</script>
</body></html>`;
