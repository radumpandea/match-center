// One-off: docs/data/teams/<teamId>.json caches (TTL 3 days, read verbatim
// on a cache hit) still hold the old `_id` key on squad players and coach --
// written before today's `_id` -> `apiId` rename in prefetch-preview.mjs
// (getSquad()/getCoach() used to strip `_id` before the match file was
// written, so the field name never mattered outside this cache; now it's
// meant to survive into the file, and it needs the current name to pass
// schema validation, which caught this via the Prefetch Preview Data
// failure on 2026-09-13). Renames in place, no API calls, no data loss.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEAMS_DIR = ROOT + 'docs/data/teams';

let filesTouched = 0, playersTouched = 0, coachesTouched = 0;
for (const f of readdirSync(TEAMS_DIR)) {
  if (!f.endsWith('.json') || f.startsWith('_')) continue;   // skip _afcache.json
  const path = `${TEAMS_DIR}/${f}`;
  const doc = JSON.parse(readFileSync(path, 'utf8'));
  let touched = false;
  for (const p of doc.squad || []) {
    if (Object.prototype.hasOwnProperty.call(p, '_id')) {
      p.apiId = p._id;
      delete p._id;
      touched = true;
      playersTouched++;
    }
  }
  if (doc.coach && Object.prototype.hasOwnProperty.call(doc.coach, '_id')) {
    doc.coach.apiId = doc.coach._id;
    delete doc.coach._id;
    touched = true;
    coachesTouched++;
  }
  if (touched) {
    writeFileSync(path, JSON.stringify(doc, null, 2) + '\n');
    filesTouched++;
  }
}
console.log(`Migrated ${filesTouched} team cache file(s): ${playersTouched} player(s), ${coachesTouched} coach(es).`);
