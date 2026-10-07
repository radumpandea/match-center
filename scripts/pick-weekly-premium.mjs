// Deterministic, no AI: picks which matches get the deep ("premium") pass in
// this run of build-match-data-weekly-premium.yml.
//
// The plan: every week, starting Wednesday, prepare the coming weekend
// (Friday..Monday) of the three leagues the commentator covers most —
// Ligue 1, Premier League and SuperLiga (Liga 1) — three packs per run, one
// per league in rotation, soonest kick-off first inside each league, until
// every weekend match is at the deep level. Each run is meant to fit inside
// one Claude Pro 5-hour window; the cron slots in the workflow are the lever
// for how fast the queue drains. Exits 0 with an empty list when nothing is
// left to do — the normal outcome from Saturday on.
//
// Favourited matches are skipped here: build-match-data-favourites.yml deep-
// builds those on its own, and two builds of the same slug would race.
//
// Requires Node 18+ (global fetch).

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

// Order = rotation order inside a run. `comp` is fixtures.json's `comp` text.
const LEAGUES = ['Ligue 1', 'Premier League', 'Superliga'];
const PER_RUN = Number(process.env.PER_RUN) || 3;
const MIN_LEAD_MS = 3 * 3600000;   // a deep build takes ~1 h; don't start one this close to kick-off

function output(name, value) {
  const line = `${name}=${value}\n`;
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, line);
  console.log(line.trim());
}

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);

// Friday..Monday of the weekend that is next (or current, on Fri–Mon).
function weekendWindow(today) {
  const dow = new Date(`${today}T12:00:00Z`).getUTCDay();          // 0 Sun … 6 Sat
  const toMonday = (8 - dow) % 7;                                    // Mon → 0, Tue → 6, Wed → 5 … Sun → 1
  const end = addDays(today, toMonday);
  const start = addDays(end, -3);
  return { from: start > today ? start : today, to: end };
}

async function favouriteSlugs() {
  try {
    const src = readFileSync('docs/app/config.js', 'utf8');
    const url = (src.match(/supabaseUrl:\s*'([^']*)'/) || [])[1];
    const key = (src.match(/supabaseAnonKey:\s*'([^']*)'/) || [])[1];
    if (!url || !key) return new Set();
    const res = await fetch(`${url}/rest/v1/rpc/mc_favourite_slugs`, {
      method: 'POST',
      headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (!res.ok) return new Set();
    return new Set(((await res.json()) || []).map((r) => r.match_slug).filter(Boolean));
  } catch { return new Set(); }
}

async function main() {
  const today = ymd(new Date());
  const { from, to } = weekendWindow(today);
  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
  const favs = await favouriteSlugs();
  const now = Date.now();

  const queues = Object.fromEntries(LEAGUES.map((l) => [l, []]));
  let weekendTotal = 0, alreadyDeep = 0;
  for (const f of fixtures) {
    if (!queues[f.comp] || !f.date || f.date < from || f.date > to) continue;
    weekendTotal++;
    const path = `docs/data/matches/${f.slug}.json`;
    if (!existsSync(path)) continue;                                  // no Level 1 pack yet — nothing to build on
    let doc;
    try { doc = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
    if (doc.researchDepth === 'deep') { alreadyDeep++; continue; }
    if (favs.has(f.slug)) continue;                                   // the favourites workflow owns these
    if (Date.parse(f.kickoff) - now < MIN_LEAD_MS) continue;          // too late / already played
    queues[f.comp].push(f);
  }
  for (const l of LEAGUES) queues[l].sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));

  // One per league in turn, then round again, until PER_RUN are picked. A league
  // with nothing left just drops out of the rotation.
  const picked = [];
  while (picked.length < PER_RUN && LEAGUES.some((l) => queues[l].length)) {
    for (const l of LEAGUES) {
      if (picked.length >= PER_RUN) break;
      const next = queues[l].shift();
      if (next) picked.push(next.slug);
    }
  }
  const left = LEAGUES.reduce((n, l) => n + queues[l].length, 0);
  console.log(`Weekend ${from}..${to}: ${weekendTotal} matches in ${LEAGUES.join(' / ')}, ${alreadyDeep} already deep, ${picked.length} picked now, ${left} still queued after this run.`);
  output('slugs', JSON.stringify(picked));
}

main().catch((e) => { console.error(e); output('slugs', '[]'); });
