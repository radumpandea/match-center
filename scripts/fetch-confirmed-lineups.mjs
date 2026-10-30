#!/usr/bin/env node
// Catches the officially-confirmed lineup close to kickoff. The logic to
// write confirmedXI/substitutes from API-Football's fixtures/lineups
// endpoint already existed in prefetch-preview.mjs, but that script only
// runs once a day (05:30 UTC) — nowhere near the ~40-75 minute window
// before kickoff when clubs actually publish the official XI, so in
// practice it almost never caught it. This script is the fix: narrow (only
// the lineup fetch, none of prefetch-preview.mjs's squad/form/news work)
// and cheap enough to run on a tight cron (see
// .github/workflows/fetch-confirmed-lineups.yml, every 10 minutes) without
// burning meaningful API-Football budget, since on most ticks nothing is
// within the window yet.
//
// Only touches fixtures whose kickoff is within LINEUP_WINDOW_MINUTES from
// now (or up to GRACE_MINUTES past it, in case the announcement is late)
// AND that don't already have a confirmedXI for both sides. Writes
// confirmedXI + substitutes (and predictedXI, now that it's no longer a
// prediction) directly onto the existing match file; never touches a match
// that isn't already built (no Level 1/2 pack yet).
//
// Backup: when API-Football cannot answer (daily request limit used up, outage)
// or has not published the sheet, the same lineup is taken from ESPN's public
// site API (supabase/functions/_shared/espn-lineups.mjs, no key, no quota) and
// its players are matched to the pack's squad. Only written when all 11
// starters are found in the squad.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
import { decodeDeep } from './lib/enrich-pack.mjs';
import { espnLineups, matchSquadPlayer } from '../supabase/functions/_shared/espn-lineups.mjs';

const DATA_DIR = 'docs/data';
const FIXTURES_PATH = `${DATA_DIR}/fixtures.json`;
const LINEUP_WINDOW_MINUTES = 40;
const GRACE_MINUTES = 15;   // keep trying a little past kickoff in case it's late
const API_KEY = process.env.APIFOOTBALL_KEY;
const API_BASE = 'https://v3.football.api-sports.io';

function readJSON(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function writeJSON(p, v) {
  decodeDeep(v);   // names from the API can carry HTML entities (O&apos;Nien)
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
}
function num(v) {
  return v != null && v !== '' ? Number(v) : null;
}

async function af(path, params) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(`${API_BASE}/${path}?${qs}`, {
    headers: { 'x-apisports-key': API_KEY },
  });
  if (!res.ok) return null;
  return res.json();
}

function toSlots(list) {
  return (list || [])
    .map((e) => e.player)
    .filter((p) => p && p.name)
    .map((p) => ({ apiId: p.id != null ? p.id : null, number: num(p.number), name: p.name, pos: p.pos || 'n/d' }));
}

function minutesToKickoff(f, now) {
  if (!f.kickoff || f.kickoff === 'n/d') return null;
  const ko = new Date(f.kickoff).getTime();
  if (isNaN(ko)) return null;
  return (ko - now) / 60000;
}

// ESPN's lineup for a fixture, written onto the pack the way the API-Football one is. true when something changed.
async function lineupFromEspn(f, doc) {
  let r;
  try { r = await espnLineups({ kickoff: f.kickoff, home: f.home, away: f.away }); }
  catch (e) { console.log(`  backup (ESPN) failed: ${e.message}`); return false; }
  if (!r) { console.log('  backup (ESPN): no published lineup either.'); return false; }
  let changed = false;
  for (const side of ['home', 'away']) {
    const t = doc.teams[side], e = r.teams[side];
    if (t.confirmedXI && t.confirmedXI.length) continue;
    const squad = t.squad || [];
    const pick = (p) => { const m = matchSquadPlayer(squad, p); return m && m.apiId != null ? { apiId: m.apiId, number: p.number != null ? p.number : m.number, name: m.name, pos: p.pos || 'n/d' } : null; };
    const xi = e.startXI.map(pick);
    if (xi.some((x) => !x)) {
      console.log(`  backup (ESPN): ${side} has starters that are not in the squad (${e.startXI.filter((p, i) => !xi[i]).map((p) => p.name).join(', ')}), skipped.`);
      continue;
    }
    t.confirmedXI = xi;
    t.predictedXI = xi.map((x) => ({ ...x }));
    if (e.formation) t.formation = e.formation;
    const subs = e.substitutes.map(pick).filter(Boolean);
    if (subs.length && (!t.substitutes || !t.substitutes.length)) t.substitutes = subs;
    changed = true;
  }
  if (changed) console.log(`  lineup taken from ESPN (backup)${r.teams.home.approx || r.teams.away.approx ? ', placement on the pitch approximate' : ''}.`);
  return changed;
}

async function main() {
  if (!API_KEY) console.error('APIFOOTBALL_KEY not set: using the backup source only.');
  const fixtures = readJSON(FIXTURES_PATH);
  const now = Date.now();

  const due = fixtures.filter((f) => {
    if (!f.eventId) return false;
    const mins = minutesToKickoff(f, now);
    return mins !== null && mins <= LINEUP_WINDOW_MINUTES && mins >= -GRACE_MINUTES;
  });

  if (!due.length) {
    console.log('No fixtures inside the lineup window right now.');
    return;
  }

  let changedCount = 0;
  for (const f of due) {
    const path = `${DATA_DIR}/matches/${f.slug}.json`;
    if (!existsSync(path)) continue;

    let doc;
    try {
      doc = readJSON(path);
    } catch (e) {
      console.error(`Could not read ${path}, skipping:`, e.message);
      continue;
    }
    if (!doc.teams || !doc.teams.home || !doc.teams.away) continue;

    const stillMissing = ['home', 'away'].some(
      (s) => !doc.teams[s].confirmedXI || !doc.teams[s].confirmedXI.length
    );
    if (!stillMissing) continue;

    const mins = minutesToKickoff(f, now);
    console.log(`Checking lineup for ${f.slug} (kickoff in ${mins.toFixed(0)} min)...`);

    let lj = null;
    if (API_KEY) {
      try {
        lj = await af('fixtures/lineups', { fixture: f.eventId });
      } catch (e) {
        console.error(`  fetch failed: ${e.message}`);
      }
    }
    const rows = lj && lj.response;
    if (!rows || rows.length !== 2) {
      // An API error (daily quota used up, rate limit) also comes back as an empty response: show it, so
      // "not published yet" is not reported when the call itself was refused.
      const err = lj && lj.errors && (Array.isArray(lj.errors) ? lj.errors.length : Object.keys(lj.errors).length) ? ` API errors: ${JSON.stringify(lj.errors)}` : '';
      console.log(`  not published yet (${rows ? rows.length : 'no'} lineup rows, results=${lj && lj.results}).${err}`);
      // the backup source: a refused / failed API call (quota) or a sheet it does not have yet
      if (await lineupFromEspn(f, doc)) { writeJSON(path, doc); changedCount++; }
      continue;
    }

    let docChanged = false;
    for (const side of rows) {
      const teamId = side.team && side.team.id;
      const teamSide = teamId === f.homeId ? 'home' : teamId === f.awayId ? 'away' : null;
      if (!teamSide) continue;

      const xi = toSlots(side.startXI);
      const subs = toSlots(side.substitutes);
      if (xi.length === 11 && (!doc.teams[teamSide].confirmedXI || !doc.teams[teamSide].confirmedXI.length)) {
        doc.teams[teamSide].confirmedXI = xi;
        doc.teams[teamSide].predictedXI = xi;   // no longer a prediction
        if (side.formation) doc.teams[teamSide].formation = side.formation;
        docChanged = true;
      }
      if (subs.length && (!doc.teams[teamSide].substitutes || !doc.teams[teamSide].substitutes.length)) {
        doc.teams[teamSide].substitutes = subs;
        docChanged = true;
      }
    }

    if (docChanged) {
      writeJSON(path, doc);
      changedCount++;
      console.log(`  lineup confirmed and written for ${f.slug}.`);
    } else {
      console.log('  no new data.');
    }
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `changed=${changedCount}\n`);
  console.log(changedCount ? `${changedCount} match(es) updated.` : 'Nothing changed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
