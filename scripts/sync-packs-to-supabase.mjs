// Copies the match packs into Supabase (table mc_packs, see supabase/access.sql) so they can be handed
// out only to signed-in users through the mc_get_pack() function, instead of being public files.
//
// Window: matches from 45 days ago to 21 days ahead (the archive stays readable, the table stays small).
// Only packs whose content changed (sha-256 over the pack and its translation sidecar) are uploaded, so
// running this often is cheap. Rows outside the window are deleted.
//
// Needs SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (the service role bypasses RLS; this runs unattended).
// If the table does not exist yet (supabase/access.sql not applied) it says so and exits 0.
// Requires Node 18+.

import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';

const URL_BASE = (process.env.SUPABASE_URL || '').replace(/\/$/, '');
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || '';
if (!URL_BASE || !KEY) { console.log('SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set - nothing to do.'); process.exit(0); }

const DAYS_BACK = 45;
const DAYS_AHEAD = 21;
const BATCH_BYTES = 2_500_000;
const H = { apikey: KEY, Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

const now = Date.now();
const lo = now - DAYS_BACK * 86400000;
const hi = now + DAYS_AHEAD * 86400000;

const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
const wanted = [];
for (const f of fixtures) {
  const t = Date.parse(f.kickoff || `${f.date}T12:00:00Z`);
  if (!f.slug || Number.isNaN(t) || t < lo || t > hi) continue;
  const path = `docs/data/matches/${f.slug}.json`;
  if (!existsSync(path)) continue;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  const i18nPath = `docs/data/matches/${f.slug}.i18n.json`;
  let i18n = null;
  if (existsSync(i18nPath)) { try { i18n = JSON.parse(readFileSync(i18nPath, 'utf8')); } catch { i18n = null; } }
  const premium = f.researchDepth === 'deep' || doc.researchDepth === 'deep';
  const hash = createHash('sha256').update(JSON.stringify(doc)).update(JSON.stringify(i18n)).update(premium ? 'P' : 'S').digest('hex');
  wanted.push({ slug: f.slug, premium, doc, i18n, hash, kickoff: f.kickoff || null });
}
console.log(`${wanted.length} pack(s) in the window.`);

async function rest(path, opts = {}) {
  const r = await fetch(`${URL_BASE}/rest/v1/${path}`, { ...opts, headers: { ...H, ...(opts.headers || {}) } });
  const text = await r.text();
  return { ok: r.ok, status: r.status, text };
}

const have = await rest('mc_packs?select=slug,hash');
if (!have.ok) {
  if (have.status === 404 || /PGRST205|does not exist|schema cache/i.test(have.text)) {
    console.log('mc_packs does not exist yet - apply supabase/access.sql first. Nothing uploaded.');
    process.exit(0);
  }
  console.error(`could not read mc_packs: HTTP ${have.status} ${have.text.slice(0, 300)}`);
  process.exit(1);
}
const known = new Map(JSON.parse(have.text).map((r) => [r.slug, r.hash]));
const todo = wanted.filter((w) => known.get(w.slug) !== w.hash);
console.log(`${todo.length} changed or new.`);

let batch = [], bytes = 0, uploaded = 0, failed = 0;
async function flush() {
  if (!batch.length) return;
  const r = await rest('mc_packs?on_conflict=slug', { method: 'POST', headers: { Prefer: 'resolution=merge-duplicates,return=minimal' }, body: JSON.stringify(batch.map((w) => ({ ...w, updated_at: new Date().toISOString() }))) });
  if (r.ok) uploaded += batch.length; else { failed += batch.length; console.error(`upload failed: HTTP ${r.status} ${r.text.slice(0, 300)}`); }
  batch = []; bytes = 0;
}
for (const w of todo) {
  const size = JSON.stringify(w).length;
  if (bytes + size > BATCH_BYTES) await flush();
  batch.push(w); bytes += size;
}
await flush();

// rows that fell out of the window (or whose fixture is gone)
const keep = new Set(wanted.map((w) => w.slug));
const stale = [...known.keys()].filter((s) => !keep.has(s));
let removed = 0;
for (const slug of stale) {
  const r = await rest(`mc_packs?slug=eq.${encodeURIComponent(slug)}`, { method: 'DELETE', headers: { Prefer: 'return=minimal' } });
  if (r.ok) removed++;
}
console.log(`uploaded ${uploaded}, failed ${failed}, removed ${removed}.`);
if (failed) process.exit(1);
