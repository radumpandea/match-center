// Validates one or more match-data JSON files against docs/data/schema.json.
//
//   node scripts/validate-match.mjs docs/data/matches/l1-e4-toulouse-lille.json
//   node scripts/validate-match.mjs docs/data/matches/*.json
//
// Exits non-zero if any file is invalid. Used locally and by
// .github/workflows/build-match-data.yml before it commits.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';

const SCHEMA_PATH = fileURLToPath(new URL('../docs/data/schema.json', import.meta.url));

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/validate-match.mjs <file.json> [more.json ...]');
  process.exit(2);
}

const schema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(schema);

let ok = true;
for (const f of files) {
  // *.i18n.json sidecars (docs/data/matches/<slug>.i18n.json, see
  // scripts/validate-i18n.mjs) live in this same directory but follow a
  // completely different shape -- a `docs/data/matches/*.json` glob picks
  // them up too, so skip them here rather than fail them against this
  // schema.
  if (f.endsWith('.i18n.json')) { console.log(`- ${f} (i18n sidecar, not a match file — see validate-i18n.mjs)`); continue; }
  let data;
  try {
    data = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`✗ ${f}: cannot read/parse — ${e.message}`);
    ok = false;
    continue;
  }
  if (validate(data)) {
    // venue.cityInfo is read on air: hard rules, so a draft that breaks them is fixed before it is committed
    const cityErrs = cityInfoErrors(data);
    if (cityErrs.length) {
      ok = false;
      console.error(`✗ ${f}: venue.cityInfo`);
      cityErrs.forEach((e) => console.error(`  ${e}`));
      continue;
    }
    // Light semantic checks beyond the JSON Schema.
    const warnings = semanticWarnings(data);
    if (warnings.length) {
      console.log(`✓ ${f}  (valid, with ${warnings.length} warning(s))`);
      warnings.forEach((w) => console.log(`  ! ${w}`));
    } else {
      console.log(`✓ ${f}`);
    }
  } else {
    ok = false;
    console.error(`✗ ${f}: schema invalid`);
    for (const err of validate.errors) {
      const extra = err.params && err.params.additionalProperty
        ? ` (property: "${err.params.additionalProperty}")` : '';
      console.error(`  ${err.instancePath || '/'} ${err.message}${extra}`);
    }
  }
}

// venue.cityInfo: exactly 3 short sentences, at most 600 characters, no rankings / superlatives.
// ("Primul Război Mondial" and "Al Doilea Război Mondial" are names, not rankings.)
export function cityInfoErrors(d) {
  const RANKING = /(?<![\p{L}])(cel mai|cea mai|cei mai|cele mai|al doilea(?! război)|al treilea|a doua ca|primul(?! război)|singur(?:ul|a)?|unic[ăa]?|record|numărul (?:unu|1))(?![\p{L}])/iu;
  const t = d && d.venue && d.venue.cityInfo;
  if (t == null || t === '') return [];
  const e = [];
  if (typeof t !== 'string') return ['must be a string'];
  if (t.length > 600) e.push(`${t.length} characters, at most 600`);
  const sentences = t.trim().split(/(?<=[.!?])\s+(?=[A-ZȘȚĂÂÎ„"«])/).filter(Boolean);
  if (sentences.length !== 3) e.push(`${sentences.length} sentences, exactly 3 are needed`);
  sentences.forEach((x, i) => { if (x.split(/\s+/).length > 30) e.push(`sentence ${i + 1} has ${x.split(/\s+/).length} words, at most 30`); });
  const m = RANKING.exec(t);
  if (m) e.push(`"${m[0]}": no rankings or superlatives unless the article's opening paragraph states it; rewrite without it`);
  return e;
}

function semanticWarnings(d) {
  const w = [];
  for (const side of ['home', 'away']) {
    const t = d.teams?.[side];
    if (!t) continue;
    if ((t.predictedXI?.length ?? 0) !== 11) {
      w.push(`teams.${side}.predictedXI has ${t.predictedXI?.length ?? 0} entries, expected 11`);
    }
    if ((t.squad?.length ?? 0) < 16) {
      w.push(`teams.${side}.squad has only ${t.squad?.length ?? 0} players`);
    }
    const gk = (t.squad || []).filter((p) => p.role === 'GK').length;
    if (gk < 2) w.push(`teams.${side}.squad lists ${gk} goalkeeper(s) — verify against the official list`);
  }
  if ((d.storyOfTheMatch?.length ?? 0) < 4) {
    w.push(`storyOfTheMatch has only ${d.storyOfTheMatch?.length ?? 0} bullets (aim for 6-10)`);
  }
  if (!d.sources?.length) w.push('sources[] is empty');
  return w;
}

process.exit(ok ? 0 : 1);
