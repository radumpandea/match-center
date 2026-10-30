// Backup source for the official lineups, used when API-Football cannot answer (daily request limit used up,
// outage) or has not published yet. ESPN's public site API needs no key and, with the "all" league, covers every
// competition in one call, so no league table has to be kept here.
//
// Plain ES module with no dependencies: imported by the `api-lineups` Edge Function (Deno) and by
// scripts/fetch-confirmed-lineups.mjs (Node 18+).
//
//   const r = await espnLineups({ kickoff, home, away });
//   -> null (match not found / not published) or
//      { source: 'espn', eventId, teams: { home: {formation, approx, startXI[], substitutes[]}, away: {...} } }
//   players: { id: null, number, name, pos, grid: null }   (ESPN ids are not API-Football ids: callers match the
//   players to their own squad with matchSquadPlayer()).
//
// The starters come with ESPN's `formationPlace` (1..11, an Opta-style slot number). Its meaning depends on the
// formation, so the order the pitch needs (goalkeeper outwards, each line right to left) comes from the tables
// below for the formations they were checked against (official team sheets of 30 Oct 2026); any other formation
// gets a generic order and `approx: true`, so the caller can say the placement on the pitch is approximate.

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/all';
const DAY_MS = 86400000;
const STOP = new Set(['fc', 'cf', 'ac', 'afc', 'sc', 'sv', 'fk', 'cd', 'ud', 'the', 'de']);

const plain = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/['’`]/g, '').toLowerCase();
const tokens = (s) => plain(s).split(/[^a-z0-9]+/).filter((w) => w.length > 1 && !STOP.has(w));

function tokenHit(a, b) {
  if (a === b) return true;
  const n = Math.min(a.length, b.length);
  if (n < 4) return false;
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  return i >= 4;
}
// how well a team name of ours fits one of ESPN's names for a team: 0..1 (share of the shorter name found)
export function nameScore(ours, theirs) {
  const a = tokens(ours), b = tokens(theirs);
  if (!a.length || !b.length) return 0;
  const hits = a.filter((x) => b.some((y) => tokenHit(x, y))).length;
  return hits / Math.min(a.length, b.length);
}
function teamScore(ours, team) {
  if (!team) return 0;
  return Math.max(...[team.displayName, team.shortDisplayName, team.name, team.location].filter(Boolean).map((n) => nameScore(ours, n)), 0);
}

async function getJSON(fetchImpl, url) {
  const r = await fetchImpl(url, { headers: { Accept: 'application/json' } });
  if (!r.ok) throw new Error(`ESPN HTTP ${r.status}`);
  return r.json();
}

// ---- pitch order -------------------------------------------------------------------------------------------
// [formationPlace, position label], goalkeeper first, then each line right to left (the order the pack uses).
const TABLES = {
  '4-3-3': [[1, 'GK'], [2, 'RB'], [5, 'RCB'], [6, 'LCB'], [3, 'LB'], [7, 'RCM'], [4, 'DM'], [8, 'LCM'], [10, 'RW'], [9, 'ST'], [11, 'LW']],
  '3-4-2-1': [[1, 'GK'], [6, 'RCB'], [5, 'CB'], [4, 'LCB'], [2, 'RWB'], [7, 'RCM'], [8, 'LCM'], [3, 'LWB'], [10, 'RW'], [11, 'LW'], [9, 'ST']],
  '3-5-2': [[1, 'GK'], [6, 'RCB'], [5, 'CB'], [4, 'LCB'], [2, 'RWB'], [7, 'RCM'], [11, 'CM'], [8, 'LCM'], [3, 'LWB'], [10, 'RST'], [9, 'LST']],
};
const LINE_LETTER = ['D', 'M', 'M', 'M', 'F'];

function genericOrder(formation, places) {
  const rows = String(formation || '').split('-').map(Number).filter((n) => n > 0);
  const rest = places.filter((p) => p !== 1);
  if (rows.reduce((a, b) => a + b, 0) !== 10 || rest.length !== 10) return places.map((p) => [p, 'n/d']);
  const back = { 3: [6, 5, 4], 4: [2, 5, 6, 3], 5: [2, 6, 5, 4, 3] }[rows[0]];
  const out = [[1, 'GK']];
  let pool = rest.slice();
  if (back && back.every((p) => pool.includes(p))) {
    back.forEach((p) => out.push([p, 'D']));
    pool = pool.filter((p) => !back.includes(p));
  } else {
    pool.sort((a, b) => a - b).splice(0, rows[0]).forEach((p) => out.push([p, 'D']));
  }
  // the rest: middle lines first (low numbers outward-in), the highest numbers up front
  pool.sort((a, b) => a - b);
  rows.slice(1).forEach((n, i, arr) => {
    const letter = i === arr.length - 1 ? 'F' : 'M';
    pool.splice(0, n).forEach((p) => out.push([p, letter]));
  });
  return out;
}

export function orderStarters(formation, starters) {
  const byPlace = new Map();
  starters.forEach((s) => { if (s.place != null && !byPlace.has(s.place)) byPlace.set(s.place, s); });
  const complete = starters.length === 11 && byPlace.size === 11 && [...Array(11).keys()].every((i) => byPlace.has(i + 1));
  if (!complete) return { list: starters.map((s) => ({ ...s.player, pos: s.player.pos || 'n/d' })), approx: true };
  const table = TABLES[formation];
  const order = table || genericOrder(formation, [...byPlace.keys()]);
  return {
    list: order.map(([p, label]) => ({ ...byPlace.get(p).player, pos: label })),
    approx: !table,
  };
}

function side(rosterEntry) {
  const list = rosterEntry.roster || [];
  const mk = (e) => ({
    id: null,
    number: e.jersey != null && e.jersey !== '' && !isNaN(Number(e.jersey)) ? Number(e.jersey) : null,
    name: (e.athlete && (e.athlete.displayName || e.athlete.fullName)) || '',
    pos: null,
    grid: null,
  });
  const starters = list.filter((e) => e.starter).map((e) => ({ place: e.formationPlace != null ? Number(e.formationPlace) : null, player: mk(e) }));
  const subs = list.filter((e) => !e.starter && e.athlete).map(mk);
  const ord = orderStarters(rosterEntry.formation || null, starters);
  return { formation: rosterEntry.formation || null, approx: ord.approx, startXI: ord.list, substitutes: subs };
}

// ---- lookup ------------------------------------------------------------------------------------------------
export async function findEvent({ kickoff, home, away }, fetchImpl = fetch) {
  const ko = Date.parse(kickoff);
  if (!isFinite(ko)) return null;
  const days = [ko - DAY_MS, ko, ko + DAY_MS].map((t) => new Date(t).toISOString().slice(0, 10).replace(/-/g, ''));
  const boards = await Promise.all(days.map((d) => getJSON(fetchImpl, `${BASE}/scoreboard?dates=${d}&limit=400`).catch(() => null)));
  let best = null;
  const seen = new Set();
  for (const b of boards) {
    for (const ev of (b && b.events) || []) {
      if (seen.has(ev.id)) continue;
      seen.add(ev.id);
      if (Math.abs(Date.parse(ev.date) - ko) > 3 * 3600000) continue;
      const cs = (ev.competitions && ev.competitions[0] && ev.competitions[0].competitors) || [];
      const h = cs.find((c) => c.homeAway === 'home'), a = cs.find((c) => c.homeAway === 'away');
      if (!h || !a) continue;
      const sh = teamScore(home, h.team), sa = teamScore(away, a.team);
      if (sh < 0.5 || sa < 0.5) continue;
      if (!best || sh + sa > best.score) best = { score: sh + sa, id: ev.id };
    }
  }
  return best;
}

export async function espnLineups({ kickoff, home, away }, fetchImpl = fetch) {
  const ev = await findEvent({ kickoff, home, away }, fetchImpl);
  if (!ev) return null;
  const j = await getJSON(fetchImpl, `${BASE}/summary?event=${ev.id}`);
  const rosters = j.rosters || [];
  if (rosters.length !== 2) return null;
  // our home/away follows the team names; the home/away flag of ESPN is the fallback
  let h = rosters.find((r) => teamScore(home, r.team) >= 0.5 && teamScore(away, r.team) < teamScore(home, r.team));
  let a = rosters.find((r) => r !== h && teamScore(away, r.team) >= 0.5);
  if (!h || !a) { h = rosters.find((r) => r.homeAway === 'home'); a = rosters.find((r) => r.homeAway === 'away'); }
  if (!h || !a) return null;
  const teams = { home: side(h), away: side(a) };
  if (teams.home.startXI.length !== 11 || teams.away.startXI.length !== 11) return null;
  return { source: 'espn', eventId: ev.id, teams };
}

// ---- matching ESPN players to a squad ------------------------------------------------------------------------
// squad entries: { apiId, number, name }. Surname + shirt number first, then a unique surname, then a unique full
// name overlap. Returns the squad entry or null (never guesses between two candidates).
export function matchSquadPlayer(squad, player) {
  const pt = tokens(player.name);
  if (!pt.length) return null;
  const last = pt[pt.length - 1];
  const hasLast = (p) => tokens(p.name).some((t) => tokenHit(t, last));
  const sameNo = (p) => player.number != null && p.number === player.number;
  let c = squad.filter((p) => hasLast(p) && sameNo(p));
  if (c.length === 1) return c[0];
  c = squad.filter(hasLast);
  if (c.length === 1) return c[0];
  if (c.length > 1) {
    const both = c.filter((p) => pt.filter((t) => tokens(p.name).some((u) => tokenHit(t, u))).length >= 2);
    if (both.length === 1) return both[0];
    const byNo = c.filter(sameNo);
    if (byNo.length === 1) return byNo[0];
  }
  return null;
}
