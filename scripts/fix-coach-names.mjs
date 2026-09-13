// One-off: (1) fix already-built match packs whose coach.name is still
// API-Football's abbreviated "X. Surname" form (see the getCoach() fix in
// prefetch-preview.mjs, which only applies to future builds), and (2)
// backfill coach.apiId so these existing files can use the live mc_entities
// overlay (docs/app/match.js connectEntities()) instead of waiting to be
// rebuilt. Re-fetches /coachs for each team, picks the current coach the same
// way (latest start date among end:null rows -- API-Football doesn't
// reliably backfill `end` on a departure).
//
// Safety: apiId is only set when the fetched current-coach's surname is
// actually found in the file's existing coach.name (or the name is empty) --
// same principle as the surname-preservation check for squad names. This is
// what protects against the Everton case (the "latest start" heuristic once
// picked Leighton Baines, an assistant, over David Moyes): if the file
// already holds a name that doesn't match, apiId is left unset and a mismatch
// is logged instead of silently linking the wrong person.
//
// Usage: APIFOOTBALL_KEY=... node scripts/fix-coach-names.mjs <slug> [<slug> ...]
//        node scripts/fix-coach-names.mjs --all   (every match file with a fixtures.json entry)

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.APIFOOTBALL_KEY;
if (!API_KEY) { console.error('Missing APIFOOTBALL_KEY env var.'); process.exit(1); }
const HOST = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_KEY };
const ROOT = fileURLToPath(new URL('..', import.meta.url));

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

async function currentCoachInfo(teamId) {
  const j = await af('coachs', { team: teamId });
  const list = (j && j.response) || [];
  let cur = null;
  let curStart = '';
  for (const c of list) {
    const row = (c.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
    if (row && (row.start || '') > curStart) { cur = c; curStart = row.start || ''; }
  }
  if (!cur || !cur.name) return null;
  const abbrev = looksAbbreviated(cur.name);
  const surname = abbrev ? cur.name.replace(/^\S+\.\s*/, '') : (has(cur.lastname) ? cur.lastname : cur.name.split(/\s+/).pop());
  const full = has(cur.firstname) && has(cur.lastname) ? `${cur.firstname} ${cur.lastname}`.trim() : null;
  const name = (abbrev && full && norm(full).includes(norm(surname))) ? full : cur.name;
  return { apiId: cur.id, name, surname };
}

async function main() {
  const args = process.argv.slice(2);
  if (!args.length) { console.error('Usage: node scripts/fix-coach-names.mjs <slug> [<slug> ...] | --all'); process.exit(1); }
  const fixtures = JSON.parse(readFileSync(`${ROOT}docs/data/fixtures.json`, 'utf8'));
  let slugs = args;
  if (args[0] === '--all') {
    const files = readdirSync(`${ROOT}docs/data/matches`).filter((f) => f.endsWith('.json'));
    slugs = files.map((f) => f.replace(/\.json$/, ''));
  }
  for (const slug of slugs) {
    const path = `${ROOT}docs/data/matches/${slug}.json`;
    let doc;
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { console.log(`${slug}: no such file, skipping`); continue; }
    const fx = fixtures.find((f) => f.slug === slug);
    let touched = 0;
    for (const [side, teamId] of [['home', fx && fx.homeId], ['away', fx && fx.awayId]]) {
      const coach = doc.teams && doc.teams[side] && doc.teams[side].coach;
      if (!coach || teamId == null) continue;
      if (coach.apiId != null && !looksAbbreviated(coach.name)) continue;   // already fine
      const info = await currentCoachInfo(teamId);
      if (!info) continue;
      const matches = !has(coach.name) || norm(coach.name).includes(norm(info.surname));
      if (!matches) {
        console.log(`${slug} (${side}): SKIP -- existing "${coach.name}" doesn't match current-coach surname "${info.surname}" (af:${info.apiId})`);
        continue;
      }
      if (info.name !== coach.name) console.log(`${slug} (${side}): "${coach.name}" -> "${info.name}"`);
      coach.name = info.name;
      if (coach.apiId !== info.apiId) { coach.apiId = info.apiId; console.log(`${slug} (${side}): apiId -> af:${info.apiId}`); }
      touched++;
    }
    if (touched) writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  }
}

main();
