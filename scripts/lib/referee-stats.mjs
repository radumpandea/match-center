// Season statistics for the referee of a match, computed from API-Football:
//   fixtures?league=&season=   (one call per league and run: every fixture of the season with its referee string)
//   fixtures/events?fixture=   (one call per finished match this referee took, ONCE: the result is kept in
//                               docs/data/referees/<key>.json and never fetched again)
// The pack's referee gets ycPerMatch / rcPerMatch and referee.season = { comp, matches, yellow, red, penalties,
// withTeams[] } for THIS league's current season only; career numbers are not available from this source, so
// referee.apps (career appearances) is left alone.
//
// Counting: a booking is every "Yellow Card" and every "Second Yellow card" event; a dismissal is every "Red Card"
// and every "Second Yellow card". Penalties are "Penalty" (scored) plus "Missed Penalty" events, i.e. penalties
// awarded and taken; a penalty cancelled by VAR before it is taken is not in the feed.
// Referee identity: API-Football sends a bare name string ("G. Kubler", sometimes with ", France"), so two
// strings are the same person when the last word and the first initial agree (same convention as
// sync-referee-entities.mjs).

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { refereeKey } from './enrich-pack.mjs';

const FINISHED = new Set(['FT', 'AET', 'PEN']);
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function tokens(name) {
  return strip(String(name || '').split(',')[0]).replace(/[^a-z\s.-]/g, ' ').replace(/\./g, ' ').split(/\s+/).filter(Boolean);
}
export function sameReferee(a, b) {
  const x = tokens(a), y = tokens(b);
  if (!x.length || !y.length) return false;
  return x[x.length - 1] === y[y.length - 1] && x[0][0] === y[0][0];
}

function countEvents(rows) {
  let yellow = 0, red = 0, pens = 0;
  for (const e of rows || []) {
    const d = String(e.detail || '');
    if (e.type === 'Card') {
      if (d === 'Yellow Card') yellow++;
      else if (d === 'Red Card') red++;
      else if (/second yellow/i.test(d)) { yellow++; red++; }
    } else if (e.type === 'Goal' && d === 'Penalty') pens++;
    else if (d === 'Missed Penalty') pens++;
  }
  return { yellow, red, pens };
}

const seasonCache = new Map();   // "league:season" -> fixture rows, one call per run

// af(path, params) -> parsed JSON or null (the caller's API wrapper, which tracks the daily allowance).
// budget: { left } shared counter of event calls this run may still make. Returns the summary or null.
export async function refereeSeasonStats({ af, doc, fixture, season, dataDir = 'docs/data', budget = { left: 40 } }) {
  const name = doc.referee && doc.referee.name;
  if (!name || name === 'n/d' || !fixture.leagueId) return null;
  const ck = `${fixture.leagueId}:${season}`;
  let rows = seasonCache.get(ck);
  if (!rows) {
    const j = await af('fixtures', { league: fixture.leagueId, season });
    rows = (j && j.response) || [];
    if (rows.length) seasonCache.set(ck, rows);
  }
  const mine = rows.filter((r) => r.fixture && FINISHED.has(r.fixture.status && r.fixture.status.short) && sameReferee(r.fixture.referee, name));
  if (!mine.length) return null;

  const path = `${dataDir}/referees/${refereeKey(name)}.json`;
  const file = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { key: refereeKey(name), name, funfacts: [], sources: [] };
  file.seasonStats = file.seasonStats || {};
  const rec = file.seasonStats[ck] || (file.seasonStats[ck] = { matches: [] });
  const have = new Map(rec.matches.map((m) => [m.id, m]));
  let fetched = 0;
  for (const r of mine) {
    const id = r.fixture.id;
    if (have.has(id)) continue;
    if (budget.left <= 0) break;
    budget.left--;
    const ev = await af('fixtures/events', { fixture: id });
    if (!ev || !Array.isArray(ev.response)) continue;   // call failed: try again next run, do not record zeros
    const c = countEvents(ev.response);
    const m = {
      id, date: String(r.fixture.date || '').slice(0, 10),
      homeId: r.teams.home.id, awayId: r.teams.away.id, home: r.teams.home.name, away: r.teams.away.name,
      hg: r.goals.home, ag: r.goals.away, yellow: c.yellow, red: c.red, pens: c.pens,
    };
    rec.matches.push(m); have.set(id, m); fetched++;
  }
  if (fetched) { rec.updatedAt = new Date().toISOString().slice(0, 10); writeFileSync(path, JSON.stringify(file, null, 2) + '\n', 'utf8'); }

  const ms = mine.map((r) => have.get(r.fixture.id)).filter(Boolean);
  if (!ms.length) return null;
  const sum = (k) => ms.reduce((a, m) => a + (m[k] || 0), 0);
  const withTeams = [];
  for (const side of ['home', 'away']) {
    const id = side === 'home' ? fixture.homeId : fixture.awayId;
    const tm = ms.filter((m) => m.homeId === id || m.awayId === id);
    if (!tm.length) continue;
    let w = 0, d = 0, l = 0;
    for (const m of tm) {
      const gf = m.homeId === id ? m.hg : m.ag, ga = m.homeId === id ? m.ag : m.hg;
      if (gf > ga) w++; else if (gf === ga) d++; else l++;
    }
    withTeams.push({ team: side === 'home' ? fixture.home : fixture.away, matches: tm.length, w, d, l });
  }
  return { matches: ms.length, yellow: sum('yellow'), red: sum('red'), penalties: sum('pens'), withTeams, fetched };
}

// writes the summary onto the pack; true when something changed
export function applyRefereeSeason(doc, comp, s) {
  if (!s) return false;
  const next = { comp, matches: s.matches, yellow: s.yellow, red: s.red, penalties: s.penalties, withTeams: s.withTeams };
  const yc = +(s.yellow / s.matches).toFixed(2), rc = +(s.red / s.matches).toFixed(2);
  const r = doc.referee;
  let changed = false;
  if (JSON.stringify(r.season) !== JSON.stringify(next)) { r.season = next; changed = true; }
  // an average already in the pack (editorial, maybe a career figure) is kept; ours only fills a gap
  if (r.ycPerMatch == null) { r.ycPerMatch = yc; changed = true; }
  if (r.rcPerMatch == null) { r.rcPerMatch = rc; changed = true; }
  return changed;
}
