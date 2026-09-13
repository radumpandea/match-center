// Sync canonical referee-name entities into Supabase (mc_entities, see
// docs/supabase.sql) -- same local-scan pattern as
// scripts/sync-player-entities.mjs, adapted for referees.
//
// Referees have no id from API-Football (fixture.referee is a bare string),
// so there is no safe equivalent of apiId to key by. This uses the surname
// plus the first name's initial as a stand-in identity -- stable across an
// abbreviated ("F. Maresca") and full ("Fabio Maresca") spelling of the SAME
// person, while still requiring the initial to match so two different
// referees who happen to share a surname aren't merged. It's a weaker
// guarantee than an id (a genuine same-surname-same-initial coincidence
// would incorrectly merge two people), which is why docs/app/match.js only
// ever accepts a STRICTLY LONGER name from this overlay, never a same-length
// rewrite -- the failure mode this can't rule out is "didn't expand a name
// that could have been", never "silently replaced a correct name".
//
// No API calls: the match-data-json skill already expands abbreviated
// referee names to full form via WebSearch per match (see SKILL.md); this
// just propagates whatever full form already exists in ANY file to every
// other file mentioning what looks like the same referee, at zero API cost.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing ${name} env var.`); process.exit(1); }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATCHES_DIR = ROOT + 'docs/data/matches';

// Kept in exact sync with refKey()/has() in docs/app/match.js -- if either
// side changes its normalization, entity_key values stop lining up.
function has(v) { return v != null && v !== '' && v !== 'n/d'; }
function refKey(name) {
  const n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z\s.]/g, '').replace(/\./g, '').trim();
  const tokens = n.split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  const surname = tokens[tokens.length - 1];
  const initial = tokens.length > 1 ? tokens[0][0] : '';
  return `name:${surname}${initial ? '-' + initial : ''}`;
}

async function upsertEntities(rows) {
  if (!rows.length) return;
  const res = await fetch(`${SUPABASE_URL}/rest/v1/mc_entities?on_conflict=kind,entity_key`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Supabase upsert failed: HTTP ${res.status} ${body}`);
  }
}

async function main() {
  const files = readdirSync(MATCHES_DIR).filter((f) => f.endsWith('.json'));
  const tally = new Map();   // key -> Map(name -> count)
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(`${MATCHES_DIR}/${f}`, 'utf8')); } catch { continue; }
    const name = doc.referee && doc.referee.name;
    if (!has(name)) continue;
    const key = refKey(name);
    if (!key) continue;
    const bucket = tally.get(key) || new Map();
    bucket.set(name, (bucket.get(name) || 0) + 1);
    tally.set(key, bucket);
  }
  console.log(`${tally.size} distinct referee key(s) across ${files.length} match file(s).`);

  const now = new Date().toISOString();
  const rows = [];
  for (const [key, bucket] of tally) {
    // Only worth a row if there's a longer form to offer -- if every sighting
    // is the same length (all full, or all abbreviated the same way), there's
    // nothing for the overlay to expand.
    const names = [...bucket.keys()].sort((a, b) => b.length - a.length || bucket.get(b) - bucket.get(a));
    const longest = names[0];
    if (names.every((n) => n.length === longest.length)) continue;
    rows.push({ kind: 'referee', entity_key: key, api_id: null, base: { name: longest }, base_synced_at: now });
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) await upsertEntities(rows.slice(i, i + CHUNK));
  console.log(`Synced ${rows.length} referee entit${rows.length === 1 ? 'y' : 'ies'} with an expansion worth propagating (of ${tally.size} distinct keys seen).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
