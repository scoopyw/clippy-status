// Checks every service in services.json once, then updates the data the
// status page reads and raises or clears alerts.
//
// Runs on GitHub Actions every five minutes (see .github/workflows/check.yml),
// deliberately off the server it watches: a status page on the same box goes
// down with it, which is exactly when it is needed (2026-11-13).
//
// Node 20+, no dependencies.

import { readFile, writeFile, mkdir } from 'node:fs/promises';

const UA = 'ClippyStatus/1.0 (+https://status.clippy.gg)';
const TIMEOUT_MS = 15000;
const SLOW_MS = 4000;          // answered, but slowly: "slow", not down
const RETRIES = 2;             // a failure is retried before it counts
const RETRY_GAP_MS = 15000;
const HISTORY_DAYS = 90;
const MAX_INCIDENTS = 60;

const root = new URL('../', import.meta.url);
const path = (p) => new URL(p, root);

async function readJson(p, fallback) {
  try { return JSON.parse(await readFile(path(p), 'utf8')); } catch { return fallback; }
}
async function writeJson(p, value) {
  await mkdir(new URL('.', path(p)), { recursive: true });
  await writeFile(path(p), JSON.stringify(value, null, 2) + '\n');
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function codeOk(expect, code) {
  if (expect.startsWith('<')) return code > 0 && code < Number(expect.slice(1));
  return String(code) === expect;
}

/** One attempt. Returns { ok, code, ms, why }. */
async function attempt(svc) {
  const t0 = Date.now();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(svc.url, {
      method: svc.method ?? 'GET',
      headers: { 'user-agent': UA, accept: svc.json || svc.fresh ? 'application/json' : 'text/html' },
      redirect: 'follow',
      signal: ctl.signal,
      cache: 'no-store',
    });
    const body = svc.method === 'HEAD' ? '' : await res.text();
    const ms = Date.now() - t0;
    if (!codeOk(svc.expect, res.status)) return { ok: false, code: res.status, ms, why: `HTTP ${res.status}` };
    if (svc.json || svc.fresh) {
      let data;
      try { data = JSON.parse(body); } catch { return { ok: false, code: res.status, ms, why: 'not JSON' }; }
      if (typeof svc.json === 'string' && !data?.[svc.json]) {
        return { ok: false, code: res.status, ms, why: `no "${svc.json}" in the answer` };
      }
      if (svc.fresh) {
        const at = Date.parse(data?.[svc.fresh.field]);
        const age = (Date.now() - at) / 60000;
        if (!Number.isFinite(age)) return { ok: false, code: res.status, ms, why: 'no timestamp' };
        if (age > svc.fresh.minutes) return { ok: false, code: res.status, ms, why: `not refreshed for ${Math.round(age)} min` };
      }
    }
    return { ok: true, code: res.status, ms, why: '' };
  } catch (e) {
    const ms = Date.now() - t0;
    const why = e?.name === 'AbortError' ? `no answer in ${TIMEOUT_MS / 1000} s` : (e?.cause?.code || e?.message || 'failed');
    return { ok: false, code: 0, ms, why };
  } finally {
    clearTimeout(timer);
  }
}

async function check(svc) {
  let r = await attempt(svc);
  for (let i = 0; !r.ok && i < RETRIES; i++) {
    await sleep(RETRY_GAP_MS);
    r = await attempt(svc);
  }
  const status = !r.ok ? 'down' : r.ms > SLOW_MS ? 'slow' : 'up';
  return { ...r, status };
}

// ---------- alerts ----------

const REPO = process.env.GITHUB_REPOSITORY;
const GH_TOKEN = process.env.GITHUB_TOKEN;
const WEBHOOK = process.env.DISCORD_WEBHOOK;

async function gh(method, url, body) {
  if (!REPO || !GH_TOKEN) return null;
  const res = await fetch(`https://api.github.com/repos/${REPO}${url}`, {
    method,
    headers: {
      authorization: `Bearer ${GH_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': UA,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) { console.log(`github ${method} ${url}: ${res.status}`); return null; }
  return res.json();
}

async function discord(content) {
  if (!WEBHOOK) return;
  const res = await fetch(WEBHOOK, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ content, username: 'Clippy status', allowed_mentions: { parse: [] } }),
  });
  if (!res.ok) console.log(`discord: ${res.status}`);
}

function minutes(fromIso, toIso) {
  return Math.max(1, Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 60000));
}

// ---------- main ----------

const services = JSON.parse(await readFile(path('services.json'), 'utf8'));
const now = new Date().toISOString();
const today = now.slice(0, 10);

const previous = await readJson('data/current.json', { services: [] });
const prevById = new Map(previous.services.map((s) => [s.id, s]));
const history = await readJson('data/history.json', {});
const incidents = await readJson('data/incidents.json', []);

const results = await Promise.all(services.map((s) => check(s)));
const current = { checkedAt: now, services: [] };

for (let i = 0; i < services.length; i++) {
  const svc = services[i];
  const r = results[i];
  const prev = prevById.get(svc.id);
  const wasDown = prev?.status === 'down';
  const isDown = r.status === 'down';
  const since = prev && (prev.status === 'down') === isDown ? prev.since : now;

  current.services.push({
    id: svc.id, status: r.status, code: r.code, ms: r.ms, why: r.why, since,
  });

  // Daily buckets: how many checks, how many passed, total response time.
  const h = (history[svc.id] ??= {});
  const d = (h[today] ??= { total: 0, up: 0, ms: 0 });
  d.total += 1;
  if (!isDown) { d.up += 1; d.ms += r.ms; }

  if (isDown && !wasDown) {
    const issue = await gh('POST', '/issues', {
      title: `${svc.name} is down`,
      body: `**${svc.name}** (${svc.url}) stopped answering at ${now}.\n\nReason: ${r.why}\n\nThis issue closes by itself when it is back.`,
      labels: ['outage'],
    });
    incidents.unshift({
      id: `${svc.id}-${now}`, service: svc.id, start: now, end: null, why: r.why, issue: issue?.number ?? null,
    });
    await discord(`🔴 **${svc.name} is down** (${r.why}). <https://status.clippy.gg>`);
  } else if (!isDown && wasDown) {
    const open = incidents.find((x) => x.service === svc.id && !x.end);
    if (open) {
      open.end = now;
      if (open.issue) {
        await gh('POST', `/issues/${open.issue}/comments`, { body: `Back at ${now}, after about ${minutes(open.start, now)} min.` });
        await gh('PATCH', `/issues/${open.issue}`, { state: 'closed' });
      }
    }
    await discord(`🟢 **${svc.name} is back**${open ? ` after about ${minutes(open.start, now)} min` : ''}. <https://status.clippy.gg>`);
  }
}

// Keep 90 days of buckets and the newest incidents; drop services that left the list.
const cutoff = new Date(Date.now() - HISTORY_DAYS * 86400000).toISOString().slice(0, 10);
for (const id of Object.keys(history)) {
  if (!services.some((s) => s.id === id)) { delete history[id]; continue; }
  for (const day of Object.keys(history[id])) if (day < cutoff) delete history[id][day];
}
incidents.length = Math.min(incidents.length, MAX_INCIDENTS);

await writeJson('data/current.json', current);
await writeJson('data/history.json', history);
await writeJson('data/incidents.json', incidents);

for (const s of current.services) console.log(`${s.status.padEnd(4)} ${String(s.code).padStart(3)} ${String(s.ms).padStart(5)} ms  ${s.id} ${s.why}`);
