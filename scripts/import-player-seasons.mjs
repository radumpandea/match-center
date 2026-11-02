#!/usr/bin/env node
// Imports every player's season-by-season record (apps, minutes, goals, assists, cards per club and competition)
// from API-Football into docs/data/seasons/<apiId>.json. One call lists the seasons a player has data for
// (players/seasons), then one call per season (players?id=&season=). A veteran is ~12 calls, so this is a
// background import that works through a queue in batches and stops at the API limits, never past them:
//
//   - per run:    at most MAX_CALLS calls (default 300);
//   - per day:    stops when the daily allowance the API reports (x-ratelimit-requests-remaining) drops to
//                 RESERVE (default 6300 of the 7500/day Pro tier), so it only ever uses what the prefetch
//                 (~5500/day) and the lineup fetch leave over, and does nothing at all after they ran;
//   - per minute: AF_THROTTLE_MS between calls, and a pause + one retry on a 429; a second 429 ends the run.
//
// A season that is over never changes, so it is fetched once and kept. The current season is refreshed
// when it is older than CURRENT_TTL_DAYS. Progress is written after every player, so the next run (the
// workflow is hourly at night) resumes where this one stopped.
//
// Queue = players of the matches in the next DAYS_AHEAD days, soonest kick-off first, the likely/confirmed
// XI before the rest of the squad. Players without an apiId are skipped.
//
//   APIFOOTBALL_KEY=... [MAX_CALLS=300] [RESERVE=6300] [ONLY_SLUG=<slug>] node scripts/import-player-seasons.mjs
// Requires Node 18+.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.APIFOOTBALL_KEY;
if (!API_KEY) { console.error('Missing APIFOOTBALL_KEY env var.'); process.exit(1); }

const HOST = 'https://v3.football.api-sports.io';
const MAX_CALLS = Number(process.env.MAX_CALLS) || 300;
const RESERVE = process.env.RESERVE !== undefined && process.env.RESERVE !== '' ? Number(process.env.RESERVE) : 6300;
const ONLY_SLUG = (process.env.ONLY_SLUG || '').trim();
const DAYS_AHEAD = 6;
const PLAYERS_PER_TEAM = 30;
const CURRENT_TTL_DAYS = 3;
const SEASONS_LIST_TTL_DAYS = 60;
const AF_THROTTLE_MS = 250;

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = ROOT + 'docs/data/fixtures.json';
const MATCHES_DIR = ROOT + 'docs/data/matches';
const OUT_DIR = ROOT + 'docs/data/seasons';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const readJSON = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
const todayISO = () => new Date().toISOString();
const daysSince = (iso) => (iso ? (Date.now() - new Date(iso).getTime()) / 86400000 : Infinity);
const num = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
const fnum = (v) => { const n = parseFloat(v); return Number.isNaN(n) ? null : n; };
const currentSeason = (d = new Date()) => (d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1);

/* ---------- the API, with limit awareness ---------- */
let calls = 0, last = 0, remaining = null, stopReason = null;

async function af(path, params) {
  if (stopReason) return null;
  if (calls >= MAX_CALLS) { stopReason = `run cap of ${MAX_CALLS} calls reached`; return null; }
  if (remaining != null && remaining <= RESERVE) { stopReason = `daily allowance down to ${remaining} (reserve ${RESERVE})`; return null; }
  const qs = Object.entries(params).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  for (let attempt = 0; attempt < 2; attempt++) {
    const gap = Date.now() - last;
    if (gap < AF_THROTTLE_MS) await sleep(AF_THROTTLE_MS - gap);
    calls++; last = Date.now();
    let r;
    try { r = await fetch(`${HOST}/${path}?${qs}`, { headers: { 'x-apisports-key': API_KEY } }); }
    catch (e) { console.error(`  ${path}: ${e.message}`); return null; }
    const rem = parseInt(r.headers.get('x-ratelimit-requests-remaining'), 10);
    if (!Number.isNaN(rem)) remaining = rem;
    if (r.status === 429) {
      if (attempt === 0) { console.error('  429 (minute limit): pausing 20s, retrying once'); await sleep(20000); continue; }
      stopReason = 'rate limit (429) twice in a row'; return null;
    }
    if (!r.ok) { console.error(`  ${path}: HTTP ${r.status}`); return null; }
    let j; try { j = await r.json(); } catch { return null; }
    const errs = j && j.errors;
    const errText = Array.isArray(errs) ? errs.join(' ') : (errs ? Object.values(errs).join(' ') : '');
    if (errText) {
      console.error(`  ${path}: ${errText}`);
      if (/limit|quota|too many/i.test(errText)) stopReason = `API refused: ${errText.slice(0, 80)}`;
      return null;
    }
    return j;
  }
  return null;
}

/* ---------- queue ---------- */
function queue() {
  const fixtures = readJSON(FIXTURES) || [];
  const from = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const to = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const fx = fixtures
    .filter((f) => f.date && f.date >= from && f.date <= to && (!ONLY_SLUG || f.slug === ONLY_SLUG))
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  const seen = new Set(), out = [];
  for (const f of fx) {
    const doc = readJSON(`${MATCHES_DIR}/${f.slug}.json`);
    if (!doc || !doc.teams) continue;
    for (const side of ['home', 'away']) {
      const t = doc.teams[side];
      const xi = new Set([].concat(t.confirmedXI || [], t.predictedXI || [], t.substitutes || []).map((x) => x.apiId).filter((x) => x != null));
      const ps = (t.squad || []).filter((p) => p.apiId != null)
        .sort((a, b) => (xi.has(b.apiId) - xi.has(a.apiId)) || (((b.stats && b.stats.minutes) || 0) - ((a.stats && a.stats.minutes) || 0)))
        .slice(0, PLAYERS_PER_TEAM);
      for (const p of ps) if (!seen.has(p.apiId)) { seen.add(p.apiId); out.push({ id: p.apiId, name: p.name, slug: f.slug }); }
    }
  }
  return out;
}

/* ---------- one season of one player -> compact rows ---------- */
function rowsFrom(resp) {
  const stats = (resp && resp.response && resp.response[0] && resp.response[0].statistics) || [];
  return stats
    .filter((s) => s && s.team && s.league)
    .map((s) => {
      const g = s.games || {}, go = s.goals || {}, c = s.cards || {};
      const apps = num(g.appearences);
      return {
        team: s.team.name, teamId: s.team.id ?? null,
        league: s.league.name, leagueId: s.league.id ?? null, country: s.league.country || null,
        apps, lineups: num(g.lineups), minutes: num(g.minutes),
        goals: num(go.total), assists: num(go.assists),
        yellow: num(c.yellow), red: (num(c.red) || 0) + (num(c.yellowred) || 0) || null,
        rating: apps ? fnum(g.rating) : null,
      };
    })
    .filter((r) => r.apps || r.minutes || r.goals || r.assists)      // a registered-but-never-played row is noise
    .sort((a, b) => (b.minutes || 0) - (a.minutes || 0));
}

/* ---------- import one player; returns true when the file is complete ---------- */
async function importPlayer(p) {
  const path = `${OUT_DIR}/${p.id}.json`;
  const file = readJSON(path) || { apiId: p.id, name: p.name, seasons: {} };
  file.name = p.name || file.name;
  const cur = currentSeason();
  let changed = false;

  if (!Array.isArray(file.available) || daysSince(file.availableAt) > SEASONS_LIST_TTL_DAYS) {
    const j = await af('players/seasons', { player: p.id });
    if (!j) return false;
    file.available = (j.response || []).filter((y) => Number.isInteger(y)).sort((a, b) => a - b);
    file.availableAt = todayISO();
    changed = true;
  }
  // newest first: the seasons a commentator reads first are filled before the old ones
  const todo = file.available.slice().reverse().filter((y) => {
    if (!(String(y) in file.seasons)) return true;
    return y >= cur && daysSince(file.fetched && file.fetched[y]) > CURRENT_TTL_DAYS;
  });
  file.fetched = file.fetched || {};
  for (const y of todo) {
    const j = await af('players', { id: p.id, season: y });
    if (!j) break;                                   // limit reached or error: keep what we have, resume next run
    file.seasons[y] = rowsFrom(j);
    file.fetched[y] = todayISO();
    changed = true;
  }
  const missing = file.available.filter((y) => !(String(y) in file.seasons));
  file.complete = missing.length === 0;
  file.updatedAt = todayISO();
  if (changed) { mkdirSync(OUT_DIR, { recursive: true }); writeFileSync(path, JSON.stringify(file) + '\n'); }
  return { complete: file.complete, changed, missing: missing.length };
}

/* ---------- main ---------- */
const q = queue();
console.log(`${q.length} player(s) in the queue (next ${DAYS_AHEAD} days${ONLY_SLUG ? `, only ${ONLY_SLUG}` : ''}); run cap ${MAX_CALLS} calls, daily reserve ${RESERVE}.`);
let done = 0, partial = 0, skipped = 0, written = 0;
for (const p of q) {
  if (stopReason) break;
  const path = `${OUT_DIR}/${p.id}.json`;
  const have = existsSync(path) ? readJSON(path) : null;
  if (have && have.complete && have.available && daysSince(have.availableAt) <= SEASONS_LIST_TTL_DAYS &&
      !have.available.some((y) => y >= currentSeason() && daysSince(have.fetched && have.fetched[y]) > CURRENT_TTL_DAYS)) { skipped++; continue; }
  const r = await importPlayer(p);
  if (!r) { partial++; continue; }
  if (r.changed) written++;
  if (r.complete) done++; else partial++;
}
console.log(`complete ${done}, partial ${partial} (resumes next run), up to date ${skipped}, files written ${written}.`);
console.log(`API calls this run: ${calls}${remaining != null ? `, daily allowance left: ${remaining}` : ' (no rate-limit header seen)'}${stopReason ? ` — stopped: ${stopReason}` : ''}.`);
