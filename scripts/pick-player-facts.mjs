// Deterministic, no AI: picks the players the next "Player facts" run should research.
//
// Fun facts per player (docs/data/players/<apiId>.json, see the match-data-json skill)
// used to be written by the same unattended run that builds a match pack, and that
// run only gets to a handful of players (a lookup budget shared with everything else:
// 8 of 22 starters on a deep Oțelul–Csíkszereda pack). This job decouples it: a
// separate, small run does nothing but those facts, a batch at a time, so coverage
// of the matches people actually use grows steadily.
//
// Order: premium (deep) matches first, then the rest, each soonest kick-off first;
// within a match the likely XI players. A player is "missing" when his store file does
// not exist, or exists with no facts and was never checked, or was last checked more
// than RECHECK_DAYS ago while still empty (a young player with no sources today may
// have a Wikipedia page next season). A file with facts but without "rev": 2 was written by
// the first, less careful pass and is queued again (see scripts/stamp-player-facts.mjs).
//
// ONLY_SLUG (env): research exactly that match's likely starters instead of the queue --
// used by the premium (deep) build, which calls the facts job right after the pack is
// finished so a premium pack comes out complete in one go. Any date is accepted then,
// but a pack still marked "partial" is skipped (nobody's lineup is known yet).
//
// Output (GITHUB_OUTPUT): players=<json array of {apiId,name,team,slug}>, count=<n>.
// Requires Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const PER_RUN = Number(process.env.PER_RUN) || 18;
const ONLY_SLUG = (process.env.ONLY_SLUG || '').trim();
const DAYS_AHEAD = 6;
const RECHECK_DAYS = 60;
const REV = 2;   // files without "rev": 2 are from the first (Haiku) pass and are researched again

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim().slice(0, 400));
}

const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const horizon = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const daysSince = (iso) => (Date.parse(`${today}T12:00:00Z`) - Date.parse(`${String(iso).slice(0, 10)}T12:00:00Z`)) / 86400000;

function needsFacts(apiId) {
  const path = `docs/data/players/${apiId}.json`;
  if (!existsSync(path)) return true;
  let j;
  try { j = JSON.parse(readFileSync(path, 'utf8')); } catch { return true; }
  if (Array.isArray(j.funfacts) && j.funfacts.some((x) => typeof x === 'string' && x.trim())) return !(j.rev >= REV);
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
    if (!t) continue;
    const ids = new Set([].concat(t.predictedXI || [], t.confirmedXI || []).map((x) => x && x.apiId).filter((x) => x != null));
    for (const p of t.squad || []) {
      if (p.apiId == null || !ids.has(p.apiId) || seen.has(p.apiId) || !needsFacts(p.apiId)) continue;
      seen.add(p.apiId);
      picked.push({ apiId: p.apiId, name: p.name, team: t.name, age: p.age != null ? p.age : null, slug: f.slug });
      if (picked.length >= PER_RUN) break outer;
    }
  }
}

console.log(`${picked.length} player(s) picked${picked.length ? ': ' + picked.map((p) => `${p.name} (${p.team})`).join(', ') : ''}.`);
output('players', JSON.stringify(picked));
output('count', picked.length);
