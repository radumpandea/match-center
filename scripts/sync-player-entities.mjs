// Sync canonical player-name entities into Supabase (mc_entities, see
// docs/supabase.sql) -- same pattern as scripts/sync-entities.mjs (coaches),
// applied to players.
//
// Unlike coaches, a player's identity doesn't need a fresh API call to stay
// current -- a person's name doesn't change season to season, only its
// SPELLING across files does (abbreviated in one, fixed in another, by
// whichever script or skill run touched that file last). So this makes NO
// API-Football calls at all: it scans every match file already on disk
// (squad[], predictedXI[], confirmedXI[]), all of which now carry apiId
// after scripts/fix-squad-names.mjs and the daily prefetch, and for each
// apiId picks the best spelling already sitting in some file -- preferring
// any full (non-abbreviated) name over an abbreviated "X. Surname" one, and
// among full names the one seen most often. That becomes mc_entities.base
// for that player; docs/app/match.js overlays just the name, the same
// restrained, name-only overlay used for coaches (see the commit that
// scoped connectEntities() down after the Manuel Baum test) -- age, height,
// career etc. stay owned by whichever file did the actual research.
//
// Requires SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (bypasses RLS; this runs
// unattended, not as a signed-in user).

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
for (const [name, v] of Object.entries({ SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY })) {
  if (!v) { console.error(`Missing ${name} env var.`); process.exit(1); }
}

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MATCHES_DIR = ROOT + 'docs/data/matches';
const looksAbbreviated = (name) => name != null && /^\S+\.\s/.test(name);

function collectFrom(list, tally) {
  if (!Array.isArray(list)) return;
  for (const p of list) {
    if (!p || p.apiId == null || !p.name) continue;
    const bucket = tally.get(p.apiId) || new Map();
    bucket.set(p.name, (bucket.get(p.name) || 0) + 1);
    tally.set(p.apiId, bucket);
  }
}

function bestName(bucket) {
  const full = [...bucket.entries()].filter(([name]) => !looksAbbreviated(name));
  const pool = full.length ? full : [...bucket.entries()];
  pool.sort((a, b) => b[1] - a[1]);
  return pool[0][0];
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
  const tally = new Map();   // apiId -> Map(name -> count)
  for (const f of files) {
    let doc;
    try { doc = JSON.parse(readFileSync(`${MATCHES_DIR}/${f}`, 'utf8')); } catch { continue; }
    for (const side of ['home', 'away']) {
      const t = doc.teams && doc.teams[side];
      if (!t) continue;
      collectFrom(t.squad, tally);
      collectFrom(t.predictedXI, tally);
      collectFrom(t.confirmedXI, tally);
    }
  }
  console.log(`${tally.size} distinct player id(s) across ${files.length} match file(s).`);

  const now = new Date().toISOString();
  const rows = [];
  for (const [apiId, bucket] of tally) {
    const name = bestName(bucket);
    rows.push({ kind: 'player', entity_key: `af:${apiId}`, api_id: apiId, base: { apiId, name }, base_synced_at: now });
  }

  const CHUNK = 200;
  for (let i = 0; i < rows.length; i += CHUNK) await upsertEntities(rows.slice(i, i + CHUNK));
  console.log(`Synced ${rows.length} player entit${rows.length === 1 ? 'y' : 'ies'}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
