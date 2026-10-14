// Deterministic, no AI, no API calls: validates docs/data/players/*.json and copies
// each player's facts into every match pack that includes him (squad[].funfacts).
// Fill-only, exactly like prefetch-preview.mjs's applyPlayerFacts(): a pack that
// already has funfacts for that player is left alone, because the translation overlay
// maps arrays by index and rewriting a translated array would misalign it.
//
// Run by .github/workflows/build-player-facts.yml right after the research step, so a
// new fact shows up in the packs at once instead of at the next daily prefetch.
// Requires Node 18+.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs';

const PLAYERS_DIR = 'docs/data/players';
const MATCHES_DIR = 'docs/data/matches';

const facts = new Map();
let bad = 0;
for (const file of readdirSync(PLAYERS_DIR).filter((f) => f.endsWith('.json'))) {
  let j;
  try { j = JSON.parse(readFileSync(`${PLAYERS_DIR}/${file}`, 'utf8')); } catch { console.error(`${file}: not valid JSON, skipped`); bad++; continue; }
  const id = Number(file.replace(/\.json$/, ''));
  if (j.apiId !== id) { console.error(`${file}: apiId ${j.apiId} does not match the file name, skipped`); bad++; continue; }
  const list = Array.isArray(j.funfacts) ? j.funfacts : [];
  if (list.length > 10 || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 400)) {
    console.error(`${file}: funfacts must be at most 10 non-empty strings of at most 400 characters, skipped`); bad++; continue;
  }
  if (list.length) facts.set(id, list);
}
console.log(`${facts.size} player(s) with facts${bad ? `, ${bad} invalid file(s)` : ''}.`);

let changed = 0, filled = 0;
for (const file of readdirSync(MATCHES_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.i18n.json'))) {
  const path = `${MATCHES_DIR}/${file}`;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  let touched = false;
  for (const side of ['home', 'away']) {
    for (const p of (doc.teams && doc.teams[side] && doc.teams[side].squad) || []) {
      if (p.apiId == null || (Array.isArray(p.funfacts) && p.funfacts.length) || !facts.has(p.apiId)) continue;
      p.funfacts = facts.get(p.apiId).slice();
      touched = true; filled++;
    }
  }
  if (touched) { writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8'); changed++; }
}
console.log(`Filled ${filled} player entr${filled === 1 ? 'y' : 'ies'} in ${changed} pack(s).`);
if (bad) process.exitCode = 0;   // invalid store files are reported, not fatal: the rest still applies
