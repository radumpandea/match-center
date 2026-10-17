// Deterministic, no AI, no API calls: validates docs/data/players/*.json and copies
// each player's facts into every match pack that includes him (squad[].funfacts).
// Fill-only (except that a rev-2 file replaces the first pass's facts), like prefetch-preview.mjs's applyPlayerFacts(): a pack that
// already has funfacts for that player is left alone, because the translation overlay
// maps arrays by index and rewriting a translated array would misalign it.
//
// Run by .github/workflows/build-player-facts.yml right after the research step, so a
// new fact shows up in the packs at once instead of at the next daily prefetch.
// Requires Node 18+.

import { readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';

const PLAYERS_DIR = 'docs/data/players';
const MATCHES_DIR = 'docs/data/matches';

const REV = 2;
const facts = new Map();
const pron = new Map();       // ids with a pronunciation
const careful = new Set();   // ids whose store file is rev >= 2: allowed to REPLACE facts already in a pack
let bad = 0;
for (const file of readdirSync(PLAYERS_DIR).filter((f) => f.endsWith('.json'))) {
  let j;
  try { j = JSON.parse(readFileSync(`${PLAYERS_DIR}/${file}`, 'utf8')); } catch {
    // A broken file (usually an unescaped quote inside a fact) would be committed as junk; drop it so the player is retried.
    console.error(`${file}: not valid JSON, deleted so the player is researched again`); unlinkSync(`${PLAYERS_DIR}/${file}`); bad++; continue;
  }
  const id = Number(file.replace(/\.json$/, ''));
  if (j.apiId !== id) { console.error(`${file}: apiId ${j.apiId} does not match the file name, skipped`); bad++; continue; }
  const list = Array.isArray(j.funfacts) ? j.funfacts : [];
  if (list.length > 10 || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 400)) {
    console.error(`${file}: funfacts must be at most 10 non-empty strings of at most 400 characters, skipped`); bad++; continue;
  }
  if (list.length) { facts.set(id, list); if (j.rev >= REV) careful.add(id); }
  if (typeof j.pronunciation === 'string' && j.pronunciation.trim() && j.pronunciation.length <= 120) pron.set(id, j.pronunciation.trim());
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
      // pronunciation: fill-only (the deep build may already have written one)
      if (p.apiId != null && pron.has(p.apiId) && !p.pronunciation) { p.pronunciation = pron.get(p.apiId); touched = true; filled++; }
      if (p.apiId == null || !facts.has(p.apiId)) continue;
      const have = Array.isArray(p.funfacts) && p.funfacts.length;
      // Fill-only, except that a careful (rev 2) file replaces what the first pass wrote. No
      // translation overlay holds funfacts yet, so replacing cannot misalign one.
      if (have && !(careful.has(p.apiId) && JSON.stringify(p.funfacts) !== JSON.stringify(facts.get(p.apiId)))) continue;
      p.funfacts = facts.get(p.apiId).slice();
      touched = true; filled++;
    }
  }
  if (touched) { writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8'); changed++; }
}
console.log(`Filled ${filled} player entr${filled === 1 ? 'y' : 'ies'} in ${changed} pack(s).`);
if (bad) process.exitCode = 0;   // invalid store files are reported, not fatal: the rest still applies
