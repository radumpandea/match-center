// Deterministic, no AI: checks that a premium (deep) pack really has the editorial parts a premium pack is
// supposed to have, and says what is missing so a short, targeted pass can fill only that.
//
//   node scripts/check-premium-complete.mjs <slug>
//       -> GITHUB_OUTPUT: missing=["stories:home","stories:away","research"], missingCount=<n>
//   node scripts/check-premium-complete.mjs --list
//       -> GITHUB_OUTPUT: slugs=[...up to MAX_PER_RUN premium packs with something missing, soonest first], count=<n>
//
// What counts as missing:
//   stories:<side>  fewer than MIN_STORIES bars (title + bullets) for that team (the "informatii echipa" column)
//   research        fewer than MIN_RESEARCH commentatorResearch cards (the "Research pentru comentator" panel)
//   city            no venue.cityInfo (the 3 sentences about the city, in the stadium section) while the venue has a city
// Referee statistics are not checked: for most Superliga / Liga 2 referees no source has them, so a retry
// would never succeed.
// Requires Node 18+.

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const MIN_STORIES = 2;
const MIN_RESEARCH = 4;
const MAX_PER_RUN = Number(process.env.MAX_PER_RUN) || 6;
const MIN_LEAD_MS = 90 * 60000;   // do not start a completion when the match is about to kick off

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim().slice(0, 400));
}

export function missingOf(doc) {
  const out = [];
  for (const side of ['home', 'away']) {
    const t = (doc.teams && doc.teams[side]) || {};
    const ok = (t.stories || []).filter((s) => s && s.title && Array.isArray(s.bullets) && s.bullets.length).length;
    if (ok < MIN_STORIES) out.push(`stories:${side}`);
  }
  const cards = (doc.commentatorResearch || []).filter((c) => c && c.topic && c.fact).length;
  if (cards < MIN_RESEARCH) out.push('research');
  const v = doc.venue || {};
  const city = typeof v.city === 'string' && v.city.trim() && v.city.trim() !== 'n/d';
  // too long (> 700 chars) counts as missing too: the text is meant to be read on air in three short sentences
  if (city && !(typeof v.cityInfo === 'string' && v.cityInfo.trim() && v.cityInfo.length <= 700)) out.push('city');
  return out;
}

const arg = process.argv[2];
if (arg === '--list') {
  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'))
    .filter((f) => f.researchDepth === 'deep' && f.kickoff && Date.parse(f.kickoff) > Date.now() + MIN_LEAD_MS)
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  // packs without the team story columns first (the bigger gap), then by kick-off
  const found = [];
  for (const f of fixtures) {
    const path = `docs/data/matches/${f.slug}.json`;
    if (!existsSync(path)) continue;
    let doc;
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (doc.partial || doc.researchDepth !== 'deep') continue;
    const m = missingOf(doc);
    if (m.length) found.push({ slug: f.slug, stories: m.some((x) => x.startsWith('stories')) });
  }
  found.sort((a, b) => (b.stories - a.stories));   // stable: kick-off order is kept inside each group
  const slugs = found.slice(0, MAX_PER_RUN).map((x) => x.slug);
  console.log(`${slugs.length} premium pack(s) with parts missing.`);
  output('slugs', JSON.stringify(slugs));
  output('count', slugs.length);
} else if (arg) {
  const path = `docs/data/matches/${arg}.json`;
  let missing = [];
  try { missing = missingOf(JSON.parse(readFileSync(path, 'utf8'))); } catch (e) { console.log(`cannot read ${path}: ${e.message}`); }
  console.log(missing.length ? `Missing in ${arg}: ${missing.join(', ')}` : `${arg} is complete.`);
  output('missing', JSON.stringify(missing));
  output('missingCount', missing.length);
} else {
  console.error('usage: check-premium-complete.mjs <slug> | --list');
  process.exit(2);
}
