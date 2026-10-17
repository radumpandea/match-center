// Deterministic, no AI, no API calls: validates docs/data/clubs/*.json and copies each club's
// talking points into every match pack that includes the club (teams.<side>.clubFacts).
//
// The club is identified by its API-Football team id, read from the pack's team logo URL
// (".../football/teams/95.png"). A club file replaces what the pack has when they differ (clubFacts
// has no translation overlay yet, so nothing can misalign).
// Run by .github/workflows/build-player-facts.yml after the club research step. Requires Node 18+.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { teamIdFromLogo } from './lib/enrich-pack.mjs';

const CLUBS_DIR = 'docs/data/clubs';
const MATCHES_DIR = 'docs/data/matches';

const facts = new Map();
let bad = 0;
if (existsSync(CLUBS_DIR)) {
  for (const file of readdirSync(CLUBS_DIR).filter((f) => f.endsWith('.json'))) {
    let j;
    try { j = JSON.parse(readFileSync(`${CLUBS_DIR}/${file}`, 'utf8')); } catch {
      // a broken file (usually an unescaped quote inside a fact) would be committed as junk; drop it so the club is retried
      console.error(`${file}: not valid JSON, deleted so the club is researched again`); unlinkSync(`${CLUBS_DIR}/${file}`); bad++; continue;
    }
    const id = Number(file.replace(/\.json$/, ''));
    if (j.teamId !== id) { console.error(`${file}: teamId ${j.teamId} does not match the file name, skipped`); bad++; continue; }
    const list = Array.isArray(j.facts) ? j.facts : [];
    if (list.length > 10 || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 400)) {
      console.error(`${file}: facts must be at most 10 non-empty strings of at most 400 characters, skipped`); bad++; continue;
    }
    if (list.length) facts.set(id, list);
  }
}
console.log(`${facts.size} club(s) with facts${bad ? `, ${bad} invalid file(s)` : ''}.`);

let changed = 0, filled = 0;
for (const file of readdirSync(MATCHES_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.i18n.json'))) {
  const path = `${MATCHES_DIR}/${file}`;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  let touched = false;
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    const id = t && teamIdFromLogo(t.logo);
    if (!id || !facts.has(id)) continue;
    if (JSON.stringify(t.clubFacts) === JSON.stringify(facts.get(id))) continue;
    t.clubFacts = facts.get(id).slice();
    touched = true; filled++;
  }
  if (touched) { writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8'); changed++; }
}
console.log(`Set clubFacts on ${filled} team entr${filled === 1 ? 'y' : 'ies'} in ${changed} pack(s).`);
