// One-off patch: reconstruct full player names (firstname + lastname) for
// already-built match packs whose squad/predictedXI/confirmedXI still show
// API-Football's abbreviated "X. Surname" form (see the "Fix squad names
// collapsing to abbreviated form" commit, which fixed this for future
// prefetch-preview.mjs runs but doesn't touch already-built files).
//
// Matches players by id (via /players/squads, the authoritative current
// roster), NOT by shirt number: this squad data has genuine duplicate shirt
// numbers (current players and departed/loaned ones who wore the same number
// at different points in the season), so a number-keyed map collapses
// distinct players onto the same name. Only overwrites a name that actually
// looks abbreviated ("X. Surname") -- an already-normal name like "António
// Silva" is left untouched, since firstname+lastname reconstruction can
// itself be incomplete for multi-part surnames.
//
// Usage: APIFOOTBALL_KEY=... node scripts/fix-squad-names.mjs <slug> [<slug> ...]

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.APIFOOTBALL_KEY;
if (!API_KEY) { console.error('Missing APIFOOTBALL_KEY env var.'); process.exit(1); }
const HOST = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_KEY };
const ROOT = fileURLToPath(new URL('..', import.meta.url));

function currentSeason(d = new Date()) {
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? y : y - 1;
}
function has(v) { return v != null && v !== '' && v !== 'n/d'; }
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}
const looksAbbreviated = (name) => name != null && /^\S+\.\s/.test(name);
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  await sleep(260);
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) { console.error(`  af ${path}: HTTP ${r.status}`); return null; }
  return r.json();
}

// Full names keyed by player id, cross-checked against the current squad
// roster (/players/squads) so a stale/loaned player from /players season
// stats can never be matched to a name that isn't actually on this roster.
async function fullNamesById(teamId, season) {
  const rosterJ = await af('players/squads', { team: teamId });
  const roster = (rosterJ && rosterJ.response && rosterJ.response[0] && rosterJ.response[0].players) || [];
  const rosterIds = new Set(roster.map((p) => p.id));

  const byId = new Map();
  const first = await af('players', { team: teamId, season, page: 1 });
  const pages = (first && first.paging && first.paging.total) || 1;
  const collect = (j) => {
    for (const row of (j && j.response) || []) {
      const pl = row.player;
      if (pl && pl.id != null && rosterIds.has(pl.id) && has(pl.firstname) && has(pl.lastname)) {
        byId.set(pl.id, `${pl.firstname} ${pl.lastname}`.trim());
      }
    }
  };
  collect(first);
  for (let p = 2; p <= Math.min(pages, 6); p++) collect(await af('players', { team: teamId, season, page: p }));

  // Map roster id -> current abbreviated/short name too, so we can match a
  // match-file entry (which only has a name, no id) back to a roster id by
  // normalized name rather than by number.
  const byNormName = new Map();
  for (const p of roster) {
    const full = byId.get(p.id);
    if (!full) continue;
    // Sanity check: API-Football's firstname/lastname split can silently drop
    // part of a compound surname (seen for "J. Maja" -> reconstructed name
    // missing "Maja" entirely). Reject the reconstruction if it doesn't even
    // contain the surname everyone already knows the player by.
    const surname = looksAbbreviated(p.name) ? p.name.replace(/^\S+\.\s*/, '') : p.name;
    if (!norm(full).includes(norm(surname))) continue;
    byNormName.set(norm(p.name), full);
  }
  return byNormName;
}

function patchList(list, byNormName) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const p of list) {
    if (!p || !looksAbbreviated(p.name)) continue;
    const full = byNormName.get(norm(p.name));
    if (full && full !== p.name) { p.name = full; n++; }
  }
  return n;
}

async function main() {
  const slugs = process.argv.slice(2);
  if (!slugs.length) { console.error('Usage: node scripts/fix-squad-names.mjs <slug> [<slug> ...]'); process.exit(1); }
  const fixtures = JSON.parse(readFileSync(`${ROOT}docs/data/fixtures.json`, 'utf8'));
  const season = currentSeason();
  for (const slug of slugs) {
    const fx = fixtures.find((f) => f.slug === slug);
    if (!fx || fx.homeId == null || fx.awayId == null) { console.log(`${slug}: no team ids in fixtures.json, skipping`); continue; }
    const path = `${ROOT}docs/data/matches/${slug}.json`;
    const doc = JSON.parse(readFileSync(path, 'utf8'));
    let touched = 0;
    for (const [side, teamId] of [['home', fx.homeId], ['away', fx.awayId]]) {
      const byNormName = await fullNamesById(teamId, season);
      const t = doc.teams[side];
      touched += patchList(t.squad, byNormName);
      touched += patchList(t.predictedXI, byNormName);
      touched += patchList(t.confirmedXI, byNormName);
    }
    if (touched) {
      writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
      console.log(`${slug}: patched ${touched} name field(s)`);
    } else {
      console.log(`${slug}: nothing to patch`);
    }
  }
}

main();
