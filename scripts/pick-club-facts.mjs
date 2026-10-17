// Deterministic, no AI: picks the clubs whose "talking points" (docs/data/clubs/<teamId>.json)
// still have to be researched.
//
// A club's history (founding, honours, records, famous players, stadium, derbies) does not
// change from match to match, so it is researched ONCE per club and reused in every pack that
// has the club -- the same idea as docs/data/players/. Order: premium (deep) matches first,
// then soonest kick-off. A club is "missing" when its file does not exist, or exists with no
// facts and was last checked more than RECHECK_DAYS ago.
//
// ONLY_SLUG (env): just the two clubs of that match (used right after a premium build).
// Output (GITHUB_OUTPUT): clubs=<json array of {teamId,name,venue,city}>, clubCount=<n>.
// Requires Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { teamIdFromLogo } from './lib/enrich-pack.mjs';

const PER_RUN = Number(process.env.CLUBS_PER_RUN) || 8;
const ONLY_SLUG = (process.env.ONLY_SLUG || '').trim();
const DAYS_AHEAD = 6;
const RECHECK_DAYS = 180;

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim().slice(0, 400));
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const horizon = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const daysSince = (iso) => (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`)) / 86400000;

function needsClub(teamId) {
  const path = `docs/data/clubs/${teamId}.json`;
  if (!existsSync(path)) return true;
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return true; }
  if (Array.isArray(j.facts) && j.facts.some((x) => typeof x === 'string' && x.trim())) return false;
  return !j.checkedAt || daysSince(j.checkedAt) > RECHECK_DAYS;
}

const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'))
  .filter((f) => (ONLY_SLUG ? f.slug === ONLY_SLUG : f.date && f.date >= today && f.date <= horizon))
  .sort((a, b) => ((b.researchDepth === 'deep') - (a.researchDepth === 'deep')) || String(a.kickoff).localeCompare(String(b.kickoff)));

const picked = [];
const seen = new Set();
outer:
for (const f of fixtures) {
  const path = `docs/data/matches/${f.slug}.json`;
  if (!existsSync(path)) continue;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  if (ONLY_SLUG && doc.partial) continue;
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    const teamId = t && teamIdFromLogo(t.logo);
    if (!teamId || seen.has(teamId) || !needsClub(teamId)) continue;
    seen.add(teamId);
    picked.push({ teamId, name: t.name, venue: (doc.venue && doc.venue.name) || null, city: (doc.venue && doc.venue.city) || null, slug: f.slug });
    if (picked.length >= PER_RUN) break outer;
  }
}

console.log(`${picked.length} club(s) picked${picked.length ? ': ' + picked.map((p) => p.name).join(', ') : ''}.`);
output('clubs', JSON.stringify(picked));
output('clubCount', picked.length);
