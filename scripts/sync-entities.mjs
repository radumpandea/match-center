// Deterministic sync of canonical coach entities into Supabase (mc_entities,
// see docs/supabase.sql). NO AI — same "API-Football only, no hallucination
// risk" guarantee as scripts/prefetch-preview.mjs.
//
// Why this exists: today a coach's name/career/trophies are copied into every
// match file that mentions their team, so a correction (Augsburg: Thorup ->
// Wagner -> Baum, all wrong at some point in 2026-09) has to be found and
// re-applied file by file — one bulk patch alone touched 60 files for a
// single coach-name bug class. mc_entities holds ONE row per real coach,
// keyed by API-Football's own id ('af:<id>'); docs/app/match.js reads it at
// render time and overlays it onto the embedded (possibly stale) copy in the
// match file, so a fix here reaches every match instantly, with no file
// patching. Players/referees/teams follow the same `kind` column later —
// this first pass covers coaches only, the exact pain point from this
// session.
//
// Scope v1: for every distinct team id referenced in docs/data/fixtures.json,
// fetch that team's CURRENT coach (same "latest start date among
// career[].end:null rows" + abbreviated-name reconstruction logic as
// prefetch-preview.mjs's getCoach(), kept in sync deliberately) plus their
// trophy record, and upsert it as mc_entities.base. Never touches `overrides`
// (the user-correction layer) — the upsert only sets the columns it sends.
//
// Requires Node 18+ (global fetch) and env APIFOOTBALL_KEY, SUPABASE_URL,
// SUPABASE_SERVICE_ROLE_KEY (the service-role key bypasses RLS — needed
// because this runs unattended, not as a signed-in user).

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, v] of Object.entries({ APIFOOTBALL_KEY: API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing ${name} env var.`); process.exit(1); }
}
const HEADERS = { 'x-apisports-key': API_KEY };
const AF_THROTTLE_MS = 250;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = ROOT + 'docs/data/fixtures.json';

function has(v) { return v != null && v !== '' && v !== 'n/d'; }
function num(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

let _last = 0;
async function af(path, params) {
  const qs = Object.entries(params || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const gap = Date.now() - _last;
    if (gap < AF_THROTTLE_MS) await sleep(AF_THROTTLE_MS - gap);
    _last = Date.now();
    let r;
    try { r = await fetch(url, { headers: HEADERS }); }
    catch (e) { console.error(`  af ${path}: ${e.message}`); return null; }
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1500); continue; }
    if (!r.ok) { console.error(`  af ${path}: HTTP ${r.status}`); return null; }
    let j;
    try { j = await r.json(); } catch { return null; }
    if (j && j.errors && (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors).length)) {
      console.error(`  af ${path}: ${JSON.stringify(j.errors)}`);
      return null;
    }
    return j;
  }
  return null;
}

// Same "current coach" pick + abbreviated-name reconstruction as
// prefetch-preview.mjs's getCoach() — kept identical on purpose so the two
// pipelines (per-match prefill, cross-match entity sync) never disagree.
async function currentCoach(teamId) {
  const j = await af('coachs', { team: teamId });
  const list = (j && j.response) || [];
  let cur = null, curStart = '';
  for (const c of list) {
    const row = (c.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
    if (row && (row.start || '') > curStart) { cur = c; curStart = row.start || ''; }
  }
  if (!cur) return null;
  const baseName = cur.name || 'n/d';
  const abbrev = /^\S+\.\s/.test(baseName);
  const surname = abbrev ? baseName.replace(/^\S+\.\s*/, '') : null;
  const full = abbrev && has(cur.firstname) && has(cur.lastname)
    ? `${cur.firstname} ${cur.lastname}`.trim() : null;
  const name = (full && surname && norm(full).includes(norm(surname))) ? full : baseName;
  const career = (cur.career || [])
    .filter((e) => e.team && e.team.name)
    .map((e) => ({
      club: e.team.name,
      period: `${(e.start || '').slice(0, 4) || '?'}–${e.end ? (e.end || '').slice(0, 4) : 'prezent'}`,
      note: null,
    }))
    .slice(0, 12);
  const tenure = (cur.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
  const trophiesJ = await af('trophies', { coach: cur.id });
  const trophies = ((trophiesJ && trophiesJ.response) || [])
    .filter((r) => r.league && r.place)
    .map((r) => ({ competition: r.league, country: r.country || null, season: r.season != null ? String(r.season) : null, place: r.place }))
    .slice(0, 20);
  return {
    apiId: cur.id,
    name,
    country: cur.nationality || null,
    age: num(cur.age),
    tenureFrom: tenure && tenure.start ? tenure.start.slice(0, 7) : null,
    career,
    trophies,
  };
}

async function upsertEntities(rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mc_entities?on_conflict=kind,entity_key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase upsert failed: HTTP ${res.status} ${body}`);
  }
}

async function main() {
  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const teamIds = [...new Set(fixtures.flatMap((f) => [f.homeId, f.awayId]).filter((id) => id != null))];
  console.log(`${teamIds.length} distinct team(s) across ${fixtures.length} fixture(s).`);

  const rows = [];
  const now = new Date().toISOString();
  for (const teamId of teamIds) {
    let coach;
    try { coach = await currentCoach(teamId); }
    catch (e) { console.error(`  team ${teamId}: ${e.message}`); continue; }
    if (!coach) { console.log(`  team ${teamId}: no current coach found, skipping`); continue; }
    rows.push({
      kind: 'coach',
      entity_key: `af:${coach.apiId}`,
      api_id: coach.apiId,
      base: coach,
      base_synced_at: now,
    });
    console.log(`  team ${teamId}: ${coach.name} (af:${coach.apiId})`);
  }

  // Batch upserts, Supabase/PostgREST-friendly chunk size.
  const CHUNK = 50;
  for (let i = 0; i < rows.length; i += CHUNK) await upsertEntities(rows.slice(i, i + CHUNK));
  console.log(`Synced ${rows.length} coach entit${rows.length === 1 ? 'y' : 'ies'}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
