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

// An event is identified by type + team + its ordinal among the same (type, team): the API first publishes many events
// without the player's name and corrects the name / the minute some minutes later, so those cannot be part of the identity.
function keyed(evs) {
  const n = {};
  return (evs || []).map((e) => { const g = e.type + '|' + (e.team && e.team.id); n[g] = (n[g] || 0) + 1; return [g + '|' + n[g], e]; });
}
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
    t = { id, name: fx.teams.home.name + ' - ' + fx.teams.away.name, league: fx.league.name, events: new Map(), gone: [], statuses: [], first: now, ticks: 0, seenEmpty: false };
    track.set(id, t);
  }
  t.ticks++;
  const st = fx.fixture.status.short;
  if (!t.statuses.length || t.statuses[t.statuses.length - 1].s !== st) t.statuses.push({ s: st, at: new Date(now).toISOString(), elapsed: fx.fixture.status.elapsed });
  t.goals = fx.goals; t.score = fx.score; t.lastStatus = st; t.elapsed = fx.fixture.status.elapsed;
  const hhmm = new Date(now).toISOString().slice(11, 19);
  const seen = new Set();
  for (const [k, e] of keyed(fx.events)) {
    seen.add(k);
    const minute = e.time.elapsed + (e.time.extra ? '+' + e.time.extra : '');
    const player = (e.player && e.player.name) || null, assist = (e.assist && e.assist.name) || null;
    const x = t.events.get(k);
    if (!x) {
      const at = happenedAt(fx, e);
      const n = {
        key: k, type: e.type, detail: e.detail, minute, team: e.team && e.team.name, player, assist, firstSeen: new Date(now).toISOString(),
        firstTick: t.ticks === 1, apiClockMinutes: fx.fixture.status.elapsed, lagSec: at ? Math.round((now - at) / 1000) : null,
        clockLag: fx.fixture.status.elapsed != null ? fx.fixture.status.elapsed - e.time.elapsed : null, present: true, changes: [], playerMissingAtFirst: !player
      };
      t.events.set(k, n);
      if (!n.firstTick) console.log(`[${hhmm}] NEW  ${t.name}  ${minute}'  ${e.type}/${e.detail}  ${player || '(no player yet)'}${assist ? ' (' + assist + ')' : ''}  lag≈${n.lagSec == null ? 'n/a' : n.lagSec + 's'}`);
      continue;
    }
    if (!x.present) { x.present = true; delete x.removedAt; }
    const upd = [];
    if (x.minute !== minute) upd.push(['minute', x.minute, minute]);
    if (x.detail !== e.detail) upd.push(['detail', x.detail, e.detail]);
    if (x.player !== player) upd.push(['player', x.player, player]);
    if (x.assist !== assist) upd.push(['assist', x.assist, assist]);
    for (const [what, from, to] of upd) {
      x.changes.push({ at: new Date(now).toISOString(), what, from, to, afterSec: Math.round((now - new Date(x.firstSeen).getTime()) / 1000) });
      x[what] = to;
      console.log(`[${hhmm}] EDIT ${t.name}  ${x.type}  ${what}: ${from || '-'} -> ${to || '-'}  (${Math.round((now - new Date(x.firstSeen).getTime()) / 1000)}s after first seen)`);
    }
  }
  for (const [k, x] of t.events) {
    if (x.present && !seen.has(k)) { x.present = false; x.removedAt = new Date(now).toISOString(); t.gone.push(x); console.log(`[${hhmm}] !! GONE ${t.name}  ${x.minute}'  ${x.type}/${x.detail}  ${x.player || ''}`); }
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
const lagBy = {}, fillDelays = [], clockLagBy = {};
let minuteEdits = 0, detailEdits = 0, playerMissingFirst = 0, playerFilled = 0, nEvents = 0, goneTotal = 0;
for (const t of track.values()) {
  const evs = [...t.events.values()];
  const live = evs.filter((e) => e.present);
  const goalEvs = live.filter((e) => e.type === 'Goal' && e.detail !== 'Missed Penalty');
  const gTotal = (t.goals && t.goals.home != null) ? t.goals.home + t.goals.away : null;
  const byType = {};
  for (const e of live) byType[e.type + '/' + e.detail] = (byType[e.type + '/' + e.detail] || 0) + 1;
  for (const e of evs) {
    nEvents++;
    if (e.playerMissingAtFirst) { playerMissingFirst++; const c = e.changes.find((x) => x.what === 'player' && x.to); if (c) { playerFilled++; fillDelays.push(c.afterSec); } }
    for (const c of e.changes) { if (c.what === 'minute') minuteEdits++; if (c.what === 'detail') detailEdits++; }
    if (!e.firstTick && e.present) {
      const k = e.type + (e.detail && /Card/.test(e.detail) ? ' ' + e.detail : '');
      if (e.lagSec != null) (lagBy[k] ||= []).push(e.lagSec);
      if (e.clockLag != null) (clockLagBy[k] ||= []).push(e.clockLag);
    }
  }
  goneTotal += t.gone.length;
  report.fixtures.push({
    name: t.name, league: t.league, statuses: t.statuses, score: t.goals, goalEvents: goalEvs.length, scoreMatchesGoalEvents: gTotal == null ? null : gTotal === goalEvs.length,
    eventsByType: byType, gone: t.gone.map((e) => `${e.minute}' ${e.type}/${e.detail} ${e.player || ''}`),
    noPlayerNow: live.filter((e) => !e.player).length, substWithoutPlayerIn: live.filter((e) => e.type === 'subst' && !e.assist).length, events: evs
  });
}
report.editing = { events: nEvents, playerMissingWhenFirstSeen: playerMissingFirst, playerLaterFilled: playerFilled, fillDelaySec: { median: pct(fillDelays, 0.5), p90: pct(fillDelays, 0.9), max: fillDelays.length ? Math.max(...fillDelays) : null }, minuteCorrections: minuteEdits, detailCorrections: detailEdits, disappeared: goneTotal };
report.apiClockLagMinutes = Object.fromEntries(Object.entries(clockLagBy).map(([k, a]) => [k, { n: a.length, median: pct(a, 0.5), max: Math.max(...a) }]));
for (const [k, a] of Object.entries(lagBy)) report.lagByType[k] = { n: a.length, medianSec: pct(a, 0.5), p90Sec: pct(a, 0.9), maxSec: Math.max(...a) };
mkdirSync('tests/out', { recursive: true });
writeFileSync('tests/out/live-probe.json', JSON.stringify(report, null, 1));
console.log('\n===== SUMMARY =====');
console.log(`requests: ${requests}, API response time median ${report.apiResponseMs.median} ms (p90 ${report.apiResponseMs.p90}), requests remaining today: ${remaining}`);
console.log('lag by event type (first seen after it happened):'); console.table(report.lagByType);
console.log('how events get edited after first being published:'); console.log(JSON.stringify(report.editing));
console.log('API clock minus event minute when first seen (events first seen after the first poll only):'); console.table(report.apiClockLagMinutes);
for (const f of report.fixtures) {
  console.log(`- ${f.name} [${f.league}] ${f.statuses.map((s) => s.s).join('>')}  score ${f.score && f.score.home}-${f.score && f.score.away}  goal events ${f.goalEvents}  consistent: ${f.scoreMatchesGoalEvents}  disappeared: ${f.gone.length}  no player now: ${f.noPlayerNow}  subst w/o "in" player: ${f.substWithoutPlayerIn}`);
  console.log('  ' + JSON.stringify(f.eventsByType));
  if (f.gone.length) console.log('  disappeared: ' + f.gone.join(' | '));
}
