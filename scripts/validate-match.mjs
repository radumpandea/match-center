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
  let data;
  try {
    data = JSON.parse(readFileSync(f, 'utf8'));
  } catch (e) {
    console.error(`✗ ${f}: cannot read/parse — ${e.message}`);
    ok = false;
    continue;
  }
  if (validate(data)) {
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
      console.error(`  ${err.instancePath || '/'} ${err.message}`);
    }
  }
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
