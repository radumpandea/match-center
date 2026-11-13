// Live data probe: how late and how complete are API-Football's live events (goals, cards, substitutions)?
// Polls the API every INTERVAL_S seconds and records, for every event, when it was first seen. Nothing is written to
// the site; the report is printed to the log and saved as tests/out/live-probe.json (uploaded as a workflow artifact).
//
// MODE=live   fixtures?live=all, optionally only LEAGUES=id,id (what is being played right now, any league)
// MODE=auto   the fixtures of docs/data/fixtures.json that start within the next/last few hours, one batched call
//             (fixtures?ids=a-b-c, up to 20 per call); calls are made only while a match is in play
//
// Env: APIFOOTBALL_KEY, MODE, INTERVAL_S (30), MAX_MINUTES (10), LEAGUES, MAX_FIXTURES (20)
//
// Lag of an event = wall-clock time we first saw it - the moment it happened according to the API's own period
// start timestamps (fixture.periods.first / second) + the event minute. Resolution is the polling interval plus the
// one-minute granularity of the event minute, so read it as "about N seconds late, give or take a minute".

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const KEY = process.env.APIFOOTBALL_KEY;
if (!KEY) { console.error('Missing APIFOOTBALL_KEY'); process.exit(1); }
const MODE = process.env.MODE || 'live';
const INTERVAL = Math.max(10, +process.env.INTERVAL_S || 30) * 1000;
const MAX_MS = (+process.env.MAX_MINUTES || 10) * 60000;
const LEAGUES = (process.env.LEAGUES || '').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_FIXTURES = Math.min(20, +process.env.MAX_FIXTURES || 20);
const HOST = 'https://v3.football.api-sports.io';
const DONE = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);
const PLAYING = new Set(['1H', 'HT', '2H', 'ET', 'BT', 'P', 'SUSP', 'INT', 'LIVE']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let requests = 0, remaining = null, perCall = [];
async function api(path) {
  const t0 = Date.now();
  const res = await fetch(HOST + path, { headers: { 'x-apisports-key': KEY } });
  requests++;
  const rem = res.headers.get('x-ratelimit-requests-remaining');
  if (rem != null) remaining = rem;
  const j = await res.json();
  perCall.push(Date.now() - t0);
  if (j.errors && Object.keys(j.errors).length && !Array.isArray(j.errors)) console.log('API errors:', JSON.stringify(j.errors));
  return j.response || [];
}

const fixturesFile = JSON.parse(readFileSync(new URL('../docs/data/fixtures.json', import.meta.url), 'utf8'));
const ours = new Map(fixturesFile.filter((f) => f.eventId).map((f) => [f.eventId, f]));
const track = new Map();   // fixture id -> { meta, events: Map(key -> info), gone: [], statuses: [], last }

const evKey = (e) => [e.time.elapsed + '+' + (e.time.extra || 0), e.team && e.team.id, e.type, e.detail, e.player && (e.player.id || e.player.name), e.assist && (e.assist.id || e.assist.name)].join('|');
function happenedAt(fx, e) {
  const p = fx.fixture.periods || {};
  const m = e.time.elapsed + (e.time.extra || 0);
  if (e.time.elapsed <= 45 && p.first) return (p.first + m * 60) * 1000;
  if (e.time.elapsed > 45 && e.time.elapsed <= 90 && p.second) return (p.second + (m - 45) * 60) * 1000;
  return null;
}

function ingest(fx, now) {
  const id = fx.fixture.id;
  let t = track.get(id);
  if (!t) {
    t = { id, name: fx.teams.home.name + ' - ' + fx.teams.away.name, league: fx.league.name, events: new Map(), gone: [], statuses: [], first: now, ticks: 0 };
    track.set(id, t);
  }
  t.ticks++;
  const st = fx.fixture.status.short;
  if (!t.statuses.length || t.statuses[t.statuses.length - 1].s !== st) t.statuses.push({ s: st, at: new Date(now).toISOString(), elapsed: fx.fixture.status.elapsed });
  t.goals = fx.goals; t.score = fx.score; t.lastStatus = st; t.elapsed = fx.fixture.status.elapsed;
  const evs = fx.events || [];
  const seen = new Set();
  for (const e of evs) {
    const k = evKey(e);
    seen.add(k);
    if (!t.events.has(k)) {
      const at = happenedAt(fx, e);
      t.events.set(k, {
        key: k, type: e.type, detail: e.detail, minute: e.time.elapsed + (e.time.extra ? '+' + e.time.extra : ''), team: e.team && e.team.name,
        player: e.player && e.player.name, assist: e.assist && e.assist.name, firstSeen: new Date(now).toISOString(),
        apiClockMinutes: fx.fixture.status.elapsed, lagSec: at ? Math.round((now - at) / 1000) : null, present: true
      });
      const x = t.events.get(k);
      console.log(`[${new Date(now).toISOString().slice(11, 19)}] ${t.name}  ${x.minute}'  ${x.type}/${x.detail}  ${x.player || '?'}${x.assist ? ' (' + x.assist + ')' : ''}  lag≈${x.lagSec == null ? 'n/a' : x.lagSec + 's'}`);
    }
  }
  for (const [k, x] of t.events) {
    if (x.present && !seen.has(k)) { x.present = false; x.removedAt = new Date(now).toISOString(); t.gone.push(x); console.log(`  !! RETRACTED  ${t.name}  ${x.minute}'  ${x.type}/${x.detail}  ${x.player || ''}`); }
    if (!x.present && seen.has(k)) { x.present = true; delete x.removedAt; }
  }
}

function pickAuto(now) {
  return [...ours.values()].filter((f) => {
    const ko = new Date(f.kickoff).getTime();
    return now > ko - 10 * 60000 && now < ko + 3.5 * 3600000;
  }).slice(0, MAX_FIXTURES);
}

const start = Date.now();
console.log(`live probe: mode=${MODE} interval=${INTERVAL / 1000}s max=${MAX_MS / 60000} min` + (LEAGUES.length ? ` leagues=${LEAGUES}` : ''));
while (Date.now() - start < MAX_MS) {
  const now = Date.now();
  let resp = [];
  if (MODE === 'live') {
    resp = await api('/fixtures?live=' + (LEAGUES.length ? LEAGUES.join('-') : 'all'));
  } else {
    const want = pickAuto(now).filter((f) => { const t = track.get(f.eventId); return !(t && DONE.has(t.lastStatus)); });
    if (want.length) resp = await api('/fixtures?ids=' + want.map((f) => f.eventId).join('-'));
    else if (now > Math.max(...[...ours.values()].map((f) => new Date(f.kickoff).getTime())) + 4 * 3600000) break;
  }
  for (const fx of resp) ingest(fx, now);
  const open = [...track.values()].some((t) => PLAYING.has(t.lastStatus));
  await sleep(MODE === 'auto' && !open && !pickAuto(Date.now()).length ? 60000 : INTERVAL);
}

// ---- report ----
const pct = (a, p) => a.length ? a.slice().sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(p * a.length))] : null;
const report = { mode: MODE, minutes: Math.round((Date.now() - start) / 60000), requests, remainingAtEnd: remaining, apiResponseMs: { median: pct(perCall, 0.5), p90: pct(perCall, 0.9) }, fixtures: [], lagByType: {} };
const lagBy = {};
for (const t of track.values()) {
  const evs = [...t.events.values()];
  const goalEvs = evs.filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const gTotal = (t.goals && t.goals.home != null) ? t.goals.home + t.goals.away : null;
  const pen = t.score && t.score.penalty && t.score.penalty.home != null ? t.score.penalty.home + t.score.penalty.away : 0;
  const byType = {};
  for (const e of evs) { const k = e.type + '/' + e.detail; byType[k] = (byType[k] || 0) + 1; if (e.lagSec != null && e.present) (lagBy[e.type + (e.detail && /Card/.test(e.detail) ? ' ' + e.detail : '')] ||= []).push(e.lagSec); }
  report.fixtures.push({
    name: t.name, league: t.league, statuses: t.statuses, score: t.goals, goalEvents: goalEvs.length, scoreMatchesGoalEvents: gTotal == null ? null : gTotal === goalEvs.length,
    eventsByType: byType, retracted: t.gone.map((e) => `${e.minute}' ${e.type}/${e.detail} ${e.player || ''}`),
    noPlayerName: evs.filter((e) => !e.player).length, substWithoutPlayerIn: evs.filter((e) => e.type === 'subst' && !e.assist).length, events: evs, penaltyShootoutGoals: pen
  });
}
for (const [k, a] of Object.entries(lagBy)) report.lagByType[k] = { n: a.length, medianSec: pct(a, 0.5), p90Sec: pct(a, 0.9), maxSec: Math.max(...a) };
mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/live-probe.json', JSON.stringify(report, null, 1));
console.log('\n===== SUMMARY =====');
console.log(`requests: ${requests}, API response time median ${report.apiResponseMs.median} ms (p90 ${report.apiResponseMs.p90}), requests remaining today: ${remaining}`);
console.log('lag by event type (first seen after it happened):'); console.table(report.lagByType);
for (const f of report.fixtures) {
  console.log(`- ${f.name} [${f.league}] ${f.statuses.map((s) => s.s).join('>')}  score ${f.score && f.score.home}-${f.score && f.score.away}  goal events ${f.goalEvents}  consistent: ${f.scoreMatchesGoalEvents}  retracted: ${f.retracted.length}  no player: ${f.noPlayerName}  subst w/o "in" player: ${f.substWithoutPlayerIn}`);
  console.log('  ' + JSON.stringify(f.eventsByType));
  if (f.retracted.length) console.log('  retracted: ' + f.retracted.join(' | '));
}
