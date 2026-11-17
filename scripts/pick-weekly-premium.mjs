// Deterministic, no AI: picks which matches get the deep ("premium") pass in
// this run of build-match-data-weekly-premium.yml.
//
// The plan: every week, starting Wednesday, prepare the coming weekend
// (Friday..Monday) of the six leagues the commentator covers — Ligue 1,
// Premier League, SuperLiga (Liga 1), Serie A, LaLiga and Bundesliga — three
// packs per run, soonest kick-off first inside each league, until every
// weekend match is at the deep level. Each run serves the leagues that are
// furthest behind (largest share of their weekend still queued), so the six
// leagues advance together instead of the last three waiting for the first
// three to finish. Each run is meant to fit inside
// one Claude Pro 5-hour window; the cron slots in the workflow are the lever
// for how fast the queue drains. Exits 0 with an empty list when nothing is
// left to do — the normal outcome from Saturday on.
//
// Favourited matches are skipped here: build-match-data-favourites.yml deep-
// builds those on its own, and two builds of the same slug would race.
//
// Requires Node 18+ (global fetch).

import { readFileSync, appendFileSync, existsSync } from 'node:fs';

// `comp` is fixtures.json's `comp` text. The order only breaks ties between leagues that are equally far behind.
export const LEAGUES = ['Ligue 1', 'Premier League', 'Superliga', 'Serie A', 'LaLiga', 'Bundesliga', 'UEFA Nations League'];
// National-team competitions are played in international windows (Thursday..Tuesday), not on the club weekend: their
// matches are prepared from the next INTERNATIONAL_DAYS days instead of Friday..Monday.
const NATIONAL = new Set(['UEFA Nations League']);
const INTERNATIONAL_DAYS = 5;
const PER_RUN = Number(process.env.PER_RUN) || 3;
const URGENT_MS = 30 * 3600000;    // a match this close to kick-off is built before any league balancing
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

// The days of `comp` that are prepared in this run.
export function windowFor(comp, today) {
  return NATIONAL.has(comp) ? { from: today, to: addDays(today, INTERNATIONAL_DAYS) } : weekendWindow(today);
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

// queues: league -> matches still to build (soonest first); totals: league -> matches of its window.
// 1) Urgent first: whatever kicks off within URGENT_MS goes before everything else, soonest first, whichever the
//    competition (a match tonight must not wait behind weekend matches because its league looks "less behind").
// 2) Then one per league in turn, the leagues ordered by the share of their window still queued (largest first),
//    round after round, until perRun are picked. A league with nothing left drops out of the rotation.
export function pick(queues, totals, perRun, leagues = LEAGUES, now = Date.now(), urgentMs = URGENT_MS) {
  const picked = [];
  const urgent = leagues.flatMap((l) => queues[l])
    .filter((m) => m.kickoff && Date.parse(m.kickoff) - now < urgentMs)
    .sort((a, b) => String(a.kickoff).localeCompare(String(b.kickoff)));
  for (const m of urgent) { if (picked.length >= perRun) break; picked.push(m.slug); }
  const taken = new Set(picked);
  const rest = Object.fromEntries(leagues.map((l) => [l, queues[l].filter((m) => !taken.has(m.slug))]));
  const share = (l) => (totals[l] ? rest[l].length / totals[l] : 0);
  const order = leagues.map((l, i) => ({ l, i })).sort((x, y) => share(y.l) - share(x.l) || x.i - y.i).map((x) => x.l);
  while (picked.length < perRun && order.some((l) => rest[l].length)) {
    for (const l of order) {
      if (picked.length >= perRun) break;
      const next = rest[l].shift();
      if (next) picked.push(next.slug);
    }
  }
  return picked;
}

async function main() {
  const today = process.env.TODAY || ymd(new Date());   // TODAY=YYYY-MM-DD: dry run for another day
  const { from, to } = weekendWindow(today);
  const windows = Object.fromEntries(LEAGUES.map((l) => [l, windowFor(l, today)]));
  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
  const favs = await favouriteSlugs();
  const now = Date.now();

  const queues = Object.fromEntries(LEAGUES.map((l) => [l, []]));
  const totals = Object.fromEntries(LEAGUES.map((l) => [l, 0]));
  let weekendTotal = 0, alreadyDeep = 0;
  for (const f of fixtures) {
    if (!queues[f.comp] || !f.date || f.date < windows[f.comp].from || f.date > windows[f.comp].to) continue;
    weekendTotal++; totals[f.comp]++;
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

  const picked = pick(queues, totals, PER_RUN);
  const left = LEAGUES.reduce((n, l) => n + queues[l].length, 0) - picked.length;
  console.log(`Club weekend ${from}..${to}, national teams ${windows["UEFA Nations League"].from}..${windows["UEFA Nations League"].to}: ${weekendTotal} matches in ${LEAGUES.join(" / ")}, ${alreadyDeep} already deep, ${picked.length} picked now, ${left} still queued after this run.`);
  output('slugs', JSON.stringify(picked));
}

// Only when run as a script, not when the test imports pick().
if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('pick-weekly-premium.mjs')) {
  main().catch((e) => { console.error(e); output('slugs', '[]'); });
}
