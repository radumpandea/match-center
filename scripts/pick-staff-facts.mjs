// Deterministic, no AI: picks the head coaches and referees whose "fun facts" still have to be
// researched. Like the players' facts they are researched ONCE per person and reused in every pack:
//   docs/data/coaches/<apiId>.json   (coach, keyed by API-Football coach id)
//   docs/data/referees/<key>.json    (referee, keyed by the name: "Willy Delajod" -> willy-delajod)
//
// Order: premium (deep) matches first, then soonest kick-off. A person is "missing" when the file
// does not exist, or exists with no facts and was last checked more than RECHECK_DAYS ago.
// ONLY_SLUG (env): just that match's coaches and referee.
// Output (GITHUB_OUTPUT): staff=<json array of {kind,key,name,country,age,birthDate,team}>, staffCount=<n>.
// Requires Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { refereeKey } from './lib/enrich-pack.mjs';

const PER_RUN = Number(process.env.STAFF_PER_RUN) || 12;
const ONLY_SLUG = (process.env.ONLY_SLUG || '').trim();
const DAYS_AHEAD = 6;
const RECHECK_DAYS = 90;

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim().slice(0, 400));
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const horizon = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const daysSince = (iso) => (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`)) / 86400000;

function needs(path) {
  if (!existsSync(path)) return true;
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return true; }
  if (Array.isArray(j.funfacts) && j.funfacts.some((x) => typeof x === 'string' && x.trim())) return false;
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
    const c = t && t.coach;
    if (!c || !c.name || c.apiId == null) continue;
    const key = `coach:${c.apiId}`;
    if (seen.has(key) || !needs(`docs/data/coaches/${c.apiId}.json`)) continue;
    seen.add(key);
    picked.push({ kind: 'coach', key: String(c.apiId), name: c.name, country: c.country || null, age: c.age != null ? c.age : null, birthDate: c.birthDate || null, team: t.name });
    if (picked.length >= PER_RUN) break outer;
  }
  const r = doc.referee;
  if (r && r.name && r.name !== 'n/d') {
    const rk = refereeKey(r.name);
    const key = `referee:${rk}`;
    if (rk && !seen.has(key) && needs(`docs/data/referees/${rk}.json`)) {
      seen.add(key);
      picked.push({ kind: 'referee', key: rk, name: r.name, country: r.country || null, age: r.age != null ? r.age : null, birthDate: null, team: null });
      if (picked.length >= PER_RUN) break outer;
    }
  }
}

console.log(`${picked.length} coach(es)/referee(s) picked${picked.length ? ': ' + picked.map((p) => `${p.kind} ${p.name}`).join(', ') : ''}.`);
output('staff', JSON.stringify(picked));
output('staffCount', picked.length);
