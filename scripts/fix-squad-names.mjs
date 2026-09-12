// One-off patch: reconstruct full player names (firstname + lastname) for
// already-built match packs whose squad/predictedXI/confirmedXI were written
// before prefetch-preview.mjs started preferring firstname+lastname over
// API-Football's inconsistent `name` field (see the "Fix squad names
// collapsing to abbreviated form" commit). Matches players by shirt number
// within each team. Does not touch anything else in the file.
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
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  await sleep(260);
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) { console.error(`  af ${path}: HTTP ${r.status}`); return null; }
  return r.json();
}

async function fullNamesByNumber(teamId, season) {
  const byNumber = new Map();
  const first = await af('players', { team: teamId, season, page: 1 });
  const pages = (first && first.paging && first.paging.total) || 1;
  const collect = (j) => {
    for (const row of (j && j.response) || []) {
      const pl = row.player;
      const num = row.statistics && row.statistics[0] && row.statistics[0].games && row.statistics[0].games.number;
      if (pl && has(pl.firstname) && has(pl.lastname) && num != null) {
        byNumber.set(num, `${pl.firstname} ${pl.lastname}`.trim());
      }
    }
  };
  collect(first);
  for (let p = 2; p <= Math.min(pages, 6); p++) collect(await af('players', { team: teamId, season, page: p }));
  return byNumber;
}

function patchList(list, byNumber) {
  if (!Array.isArray(list)) return 0;
  let n = 0;
  for (const p of list) {
    if (p && p.number != null && byNumber.has(p.number) && byNumber.get(p.number) !== p.name) {
      p.name = byNumber.get(p.number);
      n++;
    }
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
      const byNumber = await fullNamesByNumber(teamId, season);
      const t = doc.teams[side];
      touched += patchList(t.squad, byNumber);
      touched += patchList(t.predictedXI, byNumber);
      touched += patchList(t.confirmedXI, byNumber);
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
