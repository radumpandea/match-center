// Deterministic, no AI: picks the likely starters whose NAME PRONUNCIATION has not been looked
// at yet (docs/data/players/<apiId>.json without "pronChecked"), premium matches first, then
// soonest kick-off. Only players that already have a store file are picked -- the facts run
// creates that file first (and a missing file means the player has no Wikipedia page, so there
// is no IPA to work from anyway).
//
// ONLY_SLUG (env): just that match's starters. PRON_PER_RUN (env, default 40).
// Output (GITHUB_OUTPUT): pron=<json array of {apiId,name,team,age}>, pronCount=<n>.
// Requires Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';
import { xiPlayers } from './lib/enrich-pack.mjs';

const PER_RUN = Number(process.env.PRON_PER_RUN) || 40;
const ONLY_SLUG = (process.env.ONLY_SLUG || '').trim();
const DAYS_AHEAD = 6;

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim().slice(0, 400));
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const horizon = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });

function needsPron(apiId) {
  const path = `docs/data/players/${apiId}.json`;
  if (!existsSync(path)) return false;
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return false; }
  return !j.pronChecked;
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
  for (const { side, p } of xiPlayers(doc)) {
    if (seen.has(p.apiId) || !needsPron(p.apiId)) continue;
    seen.add(p.apiId);
    picked.push({ apiId: p.apiId, name: p.name, team: doc.teams[side].name, age: p.age != null ? p.age : null });
    if (picked.length >= PER_RUN) break outer;
  }
}

console.log(`${picked.length} player(s) picked for pronunciation${picked.length ? ': ' + picked.map((p) => p.name).join(', ') : ''}.`);
output('pron', JSON.stringify(picked));
output('pronCount', picked.length);
