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

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

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

async function main() {
  if (!API_KEY) {
    console.error('APIFOOTBALL_KEY not set.');
    process.exit(1);
  }
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

    let lj;
    try {
      lj = await af('fixtures/lineups', { fixture: f.eventId });
    } catch (e) {
      console.error(`  fetch failed: ${e.message}`);
      continue;
    }
    const rows = lj && lj.response;
    if (!rows || rows.length !== 2) {
      console.log('  not published yet.');
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
