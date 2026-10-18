// Deterministic, no AI, no API calls: validates docs/data/coaches/*.json and docs/data/referees/*.json
// and copies each person's facts into every match pack that has him (teams.<side>.coach.funfacts and
// referee.funfacts). A file replaces what the pack has when they differ (no translation overlay holds
// these yet, so nothing can misalign). A file that is not valid JSON is deleted so the person is retried.
// Run by .github/workflows/build-player-facts.yml after the staff research step. Requires Node 18+.

import { readFileSync, writeFileSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { refereeKey } from './lib/enrich-pack.mjs';

const MATCHES_DIR = 'docs/data/matches';

function load(dir, idField, keyOf) {
  const out = new Map();
  if (!existsSync(dir)) return out;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.json'))) {
    let j;
    try { j = JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')); } catch {
      console.error(`${dir}/${file}: not valid JSON, deleted so it is researched again`); unlinkSync(`${dir}/${file}`); continue;
    }
    const key = file.replace(/\.json$/, '');
    if (String(j[idField]) !== key) { console.error(`${dir}/${file}: ${idField} ${j[idField]} does not match the file name, skipped`); continue; }
    const list = Array.isArray(j.funfacts) ? j.funfacts : [];
    if (list.length > 10 || list.some((x) => typeof x !== 'string' || !x.trim() || x.length > 400)) {
      console.error(`${dir}/${file}: funfacts must be at most 10 non-empty strings of at most 400 characters, skipped`); continue;
    }
    if (list.length) out.set(keyOf ? keyOf(key) : key, list);
  }
  return out;
}

const coaches = load('docs/data/coaches', 'coachId');
const referees = load('docs/data/referees', 'key');
console.log(`${coaches.size} coach(es) and ${referees.size} referee(s) with facts.`);

let changed = 0, set = 0;
for (const file of readdirSync(MATCHES_DIR).filter((f) => f.endsWith('.json') && !f.endsWith('.i18n.json'))) {
  const path = `${MATCHES_DIR}/${file}`;
  let doc;
  try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
  let touched = false;
  for (const side of ['home', 'away']) {
    const c = doc.teams && doc.teams[side] && doc.teams[side].coach;
    if (c && c.apiId != null && coaches.has(String(c.apiId)) && JSON.stringify(c.funfacts) !== JSON.stringify(coaches.get(String(c.apiId)))) {
      c.funfacts = coaches.get(String(c.apiId)).slice(); touched = true; set++;
    }
  }
  const r = doc.referee;
  if (r && r.name) {
    const k = refereeKey(r.name);
    if (k && referees.has(k) && JSON.stringify(r.funfacts) !== JSON.stringify(referees.get(k))) { r.funfacts = referees.get(k).slice(); touched = true; set++; }
  }
  if (touched) { writeFileSync(path, JSON.stringify(doc, null, 2) + '\n', 'utf8'); changed++; }
}
console.log(`Set funfacts on ${set} coach/referee entr${set === 1 ? 'y' : 'ies'} in ${changed} pack(s).`);
