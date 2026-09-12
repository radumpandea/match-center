// One-off: fix already-built match packs whose coach.name is still
// API-Football's abbreviated "X. Surname" form (see the getCoach() fix in
// prefetch-preview.mjs, which only applies to future builds). Re-fetches
// /coachs for each team, picks the current coach the same way (latest start
// date among end:null rows -- API-Football doesn't reliably backfill `end`
// on a departure), and reconstructs the full name with the same
// surname-preservation safety check used for squad names.
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

async function currentCoachFullName(teamId) {
  const j = await af('coachs', { team: teamId });
  const list = (j && j.response) || [];
  let cur = null;
  let curStart = '';
  for (const c of list) {
    const row = (c.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
    if (row && (row.start || '') > curStart) { cur = c; curStart = row.start || ''; }
  }
  if (!cur || !cur.name) return null;
  if (!looksAbbreviated(cur.name)) return null;   // nothing to fix
  const surname = cur.name.replace(/^\S+\.\s*/, '');
  const full = has(cur.firstname) && has(cur.lastname) ? `${cur.firstname} ${cur.lastname}`.trim() : null;
  if (full && norm(full).includes(norm(surname))) return full;
  return null;
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
      if (!coach || !looksAbbreviated(coach.name) || teamId == null) continue;
      const full = await currentCoachFullName(teamId);
      if (full && full !== coach.name) {
        console.log(`${slug} (${side}): "${coach.name}" -> "${full}"`);
        coach.name = full;
        touched++;
      }
    }
    if (touched) writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
  }
}

main();
