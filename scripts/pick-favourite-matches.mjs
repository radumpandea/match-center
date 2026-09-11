// Deterministic, no AI: finds match slugs favourited by ANY user (via a
// Supabase RPC that only ever returns the slug list, never who favourited
// it — see mc_favourite_slugs() in docs/supabase.sql) that are due soon and
// haven't had the deep editorial pass yet. Feeds the matrix job in
// build-match-data-favourites.yml. Exits 0 with an empty list whenever
// Supabase isn't configured or nothing qualifies — this is a "maybe
// nothing to do today" script, not a failure mode.
//
// Requires Node 18+ (global fetch).

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

const DAYS_AHEAD = 6;    // same horizon prefetch-preview.mjs uses
const MAX_PER_RUN = 6;   // safety ceiling — favourites are capped at 4/user
                          // by the DB, but several users could still stack up

function readSupabaseConfig() {
  const src = readFileSync('docs/app/config.js', 'utf8');
  const url = (src.match(/supabaseUrl:\s*'([^']*)'/) || [])[1];
  const key = (src.match(/supabaseAnonKey:\s*'([^']*)'/) || [])[1];
  return url && key ? { url, key } : null;
}

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim());
}

async function main() {
  const cfg = readSupabaseConfig();
  if (!cfg) { console.log('Supabase not configured — nothing to do.'); output('slugs', '[]'); return; }

  const res = await fetch(`${cfg.url}/rest/v1/rpc/mc_favourite_slugs`, {
    method: 'POST',
    headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}`, 'Content-Type': 'application/json' },
    body: '{}',
  });
  if (!res.ok) {
    console.error(`Favourites RPC failed: HTTP ${res.status} — ${await res.text()}`);
    output('slugs', '[]');
    return;
  }
  const rows = await res.json();
  const favSlugs = new Set((rows || []).map((r) => r.match_slug).filter(Boolean));
  if (!favSlugs.size) { console.log('No favourited matches.'); output('slugs', '[]'); return; }

  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
  const from = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const to = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const byKickoff = (a, b) => String(a.kickoff).localeCompare(String(b.kickoff));

  const due = fixtures
    .filter((f) => favSlugs.has(f.slug) && f.date && f.date >= from && f.date <= to)
    .sort(byKickoff);

  const picked = [];
  for (const f of due) {
    const path = `docs/data/matches/${f.slug}.json`;
    if (!existsSync(path)) continue;   // no Level 1 pack yet — nothing to build on
    let doc;
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch (e) { continue; }
    if (doc.researchDepth === 'deep') continue;   // already at the best level
    picked.push(f.slug);
    if (picked.length >= MAX_PER_RUN) break;
  }

  console.log(picked.length
    ? `Favourited, due for the deep pass: ${picked.join(', ')}`
    : 'All favourited matches already at the deep level (or too far out / not prefetched yet).');
  output('slugs', JSON.stringify(picked));
}

main().catch((e) => { console.error(e); output('slugs', '[]'); });
