// One cleaning pass over every stored career string (see scripts/lib/career.mjs for what is removed). No API, no AI.
//   node scripts/clean-careers.mjs [--dry]
// Covers squad[].career in docs/data/matches/*.json (translations included) and the career cache in
// docs/data/teams/_afcache.json, so that the next prefetch does not put the old strings back. Idempotent.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { cleanCareerString } from './lib/career.mjs';

const DRY = process.argv.includes('--dry');
let strings = 0, files = 0;
const examples = [];

// Cleans every "career" / "tfCareer" that is a string, wherever it sits. Returns how many changed.
function walk(o) {
  let n = 0;
  if (!o || typeof o !== 'object') return n;
  for (const k of Object.keys(o)) {
    const v = o[k];
    if ((k === 'career' || k === 'tfCareer') && typeof v === 'string') {
      const c = cleanCareerString(v);
      if (c !== v) { o[k] = c; n++; if (examples.length < 6) examples.push([v, c]); }
    } else if (v && typeof v === 'object') n += walk(v);
  }
  return n;
}

function process1(path) {
  const text = readFileSync(path, 'utf8');
  let doc;
  try { doc = JSON.parse(text); } catch (e) { console.log(`${path}: not valid JSON, skipped (${e.message})`); return; }
  const n = walk(doc);
  if (!n) return;
  strings += n; files++;
  if (DRY) return;
  // same layout as the file had: its indentation and final newline
  const indent = (text.match(/^[[{]\r?\n( +)/) || [])[1];
  let out = JSON.stringify(doc, null, indent ? indent.length : 0);
  if (/\n$/.test(text)) out += '\n';
  if (text.includes('\r\n')) out = out.replace(/\n/g, '\r\n');
  writeFileSync(path, out);
}

for (const f of readdirSync('docs/data/matches')) if (f.endsWith('.json')) process1(`docs/data/matches/${f}`);
const matchStrings = strings, matchFiles = files;
process1('docs/data/teams/_afcache.json');
console.log(`${DRY ? 'Would clean' : 'Cleaned'}: ${matchStrings} career strings in ${matchFiles} match files; ${strings - matchStrings} in the career cache.`);
for (const [a, b] of examples) console.log(`  - ${a.slice(0, 200)}\n  + ${String(b).slice(0, 200)}`);
