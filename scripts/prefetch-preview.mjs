// Deterministic pre-fill of docs/data/matches/<slug>.json for upcoming fixtures
// that don't have a full research pack yet. NO AI — no hallucination risk, no
// AI-token cost. Everything comes from API-Football (api-sports.io v3):
//
//   - full squad for both teams (shirt no., age, nationality, height, weight,
//     role and current-season stats: goals, assists, minutes, appearances,
//     cards, rating)
//   - head coach: name, age, nationality, managerial career, tenure start
//   - injuries / suspensions -> teams.<side>.absences[]
//   - referee name, venue (name / city / capacity)
//   - the confirmed lineup + formation, once API-Football publishes it (usually
//     ~1h before kickoff)
//   - league standings row + home/away split -> teams.<side>.form
//   - a form guide (last ~6 results, this team's perspective) -> form.recent
//   - Opta-style team aggregates (goal-timing split, clean sheets, penalty
//     share, formations used, biggest streak) -> form.stats
//   - head-to-head (last meetings + W-D-L summary) -> h2h
//   - a short club-history career string per player -> squad[].career
//   - the coach's trophy record (competition, season, place) -> coach.trophies[]
//   - API-Football's own algorithmic pre-match model (win/draw/away percent,
//     an advice string, attack/defence/form/poisson comparison) -> predictions
//   - raw dated RSS headlines -> teams.<side>.newsCandidates[] (no key)
//   - kickoff-hour weather forecast at the venue -> venue.weather (Open-Meteo,
//     free, no key — geocoded from venue.city)
//
// predictions and coach.trophies are numbers/facts computed or recorded by
// the provider itself, not written by a model — same "no invented facts"
// guarantee as everything else here.
//
// The file is written schema-valid with "partial": true. The match-data-json
// skill later upgrades the SAME file with the editorial layer and removes the
// flag. Nothing here ever sets fixtures.json `ready`.
//
// Even once a pack is "ready" (editorial pass done), this script keeps
// running against it every day within 72h of kickoff to refresh whatever
// only becomes accurate/available that close in: referee, confirmed XI, kit
// colours, weather, and fresher news headlines (added alongside, not instead
// of, any curated news[] the editorial pass already wrote).
//
// Per-team squads are cached at docs/data/teams/<teamId>.json (TTL 3 days).
// Standings, team stats, H2H, player careers and coach trophies are cached in
// docs/data/teams/_afcache.json (2 / 2 / 14 / 30 / 60 days). predictions and
// weather are refetched each run in that window (both change hourly/daily);
// geocoded venue coordinates are cached forever.
//
// Requires Node 18+ (global fetch) and env APIFOOTBALL_KEY.
// Run daily by .github/workflows/prefetch-preview.yml, after refresh-fixtures.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
if (!API_KEY) {
  console.error('Missing APIFOOTBALL_KEY env var.');
  process.exit(1);
}
const HEADERS = { 'x-apisports-key': API_KEY };

const DAYS_AHEAD = 6;
const SQUAD_TTL_DAYS = 3;
const STANDINGS_TTL = 2;
const TEAMSTATS_TTL = 2;
const H2H_TTL = 14;
const CAREER_TTL = 30;
const AF_CALL_BUDGET = 5500;   // ceiling on the 7500/day Pro tier (refresh-fixtures uses ~8, build-match-data 0)
const AF_THROTTLE_MS = 250;    // ~240 req/min, under the 300/min Pro limit
const CAREER_MAX_PLAYERS = 30; // per team, per match — cache careers for the full normal squad, not only the likely XI

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = ROOT + 'docs/data/fixtures.json';
const MATCHES_DIR = ROOT + 'docs/data/matches';
const TEAMS_DIR = ROOT + 'docs/data/teams';
const PREVIEWS = ROOT + 'docs/data/previews.json';
const CACHE_FILE = `${TEAMS_DIR}/_afcache.json`;

const SOURCE = {
  name: 'API-Football (api-sports.io)',
  url: 'https://www.api-football.com/',
};

const AF_LEAGUE_ID = {
  'Premier League': 39, 'Ligue 1': 61, 'LaLiga': 140, 'Serie A': 135,
  'Bundesliga': 78, '2. Bundesliga': 79, 'Superliga': 283, 'Liga 2': 284,
};

/* ---------- small helpers ---------- */
function todayISO() { return new Date().toISOString(); }
function todayDate() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }); }
function daysBetween(a, b) { return Math.round((new Date(a) - new Date(b)) / 86400000); }
function num(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }
function fnum(v) { const n = parseFloat(v); return Number.isNaN(n) ? null : n; }
function has(v) { return v != null && v !== '' && v !== 'n/d'; }
const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

function currentSeason(d = new Date()) {
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? y : y - 1;
}

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

/* ---------- API-Football client ---------- */
let _calls = 0;
let _last = 0;
async function af(path, params) {
  if (_calls >= AF_CALL_BUDGET) { console.error(`  af: call budget reached, skipping ${path}`); return null; }
  const qs = Object.entries(params || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  for (let attempt = 0; attempt < 3; attempt++) {
    const gap = Date.now() - _last;
    if (gap < AF_THROTTLE_MS) await sleep(AF_THROTTLE_MS - gap);
    _calls++;
    _last = Date.now();
    let r;
    try {
      r = await fetch(url, { headers: HEADERS });
    } catch (e) {
      console.error(`  af ${path}: ${e.message}`);
      return null;
    }
    if ((r.status === 429 || r.status >= 500) && attempt < 2) { await sleep(1500); continue; }
    if (!r.ok) { console.error(`  af ${path}: HTTP ${r.status}`); return null; }
    let j;
    try { j = await r.json(); } catch { return null; }
    const errs = j && j.errors;
    const errCount = Array.isArray(errs) ? errs.length : (errs ? Object.keys(errs).length : 0);
    if (errCount) {
      console.error(`  af ${path}: ${JSON.stringify(errs)}`);
      return null;
    }
    return j;   // { response, paging, results, ... }
  }
  return null;
}

/* ---------- country name -> FIFA 3-letter code ----------
   API-Football returns full country names ("Netherlands"); the schema wants a
   3-letter code. This covers the football nations that actually turn up in our
   eight leagues; anything unmapped falls back to the first three letters. */
const CC3 = {
  'england': 'ENG', 'scotland': 'SCO', 'wales': 'WAL', 'northern ireland': 'NIR',
  'ireland': 'IRL', 'republic of ireland': 'IRL', 'france': 'FRA', 'spain': 'ESP',
  'italy': 'ITA', 'germany': 'GER', 'portugal': 'POR', 'netherlands': 'NED',
  'belgium': 'BEL', 'switzerland': 'SUI', 'austria': 'AUT', 'denmark': 'DEN',
  'sweden': 'SWE', 'norway': 'NOR', 'finland': 'FIN', 'iceland': 'ISL',
  'poland': 'POL', 'czech-republic': 'CZE', 'czechia': 'CZE', 'slovakia': 'SVK',
  'hungary': 'HUN', 'romania': 'ROU', 'bulgaria': 'BUL', 'serbia': 'SRB',
  'croatia': 'CRO', 'slovenia': 'SVN', 'bosnia and herzegovina': 'BIH',
  'north macedonia': 'MKD', 'macedonia': 'MKD', 'montenegro': 'MNE',
  'albania': 'ALB', 'kosovo': 'KVX', 'greece': 'GRE', 'turkey': 'TUR',
  'türkiye': 'TUR', 'ukraine': 'UKR', 'russia': 'RUS', 'belarus': 'BLR',
  'georgia': 'GEO', 'armenia': 'ARM', 'azerbaijan': 'AZE', 'cyprus': 'CYP',
  'israel': 'ISR', 'luxembourg': 'LUX', 'malta': 'MLT', 'moldova': 'MDA',
  'brazil': 'BRA', 'argentina': 'ARG', 'uruguay': 'URU', 'colombia': 'COL',
  'chile': 'CHI', 'paraguay': 'PAR', 'peru': 'PER', 'ecuador': 'ECU',
  'bolivia': 'BOL', 'venezuela': 'VEN', 'mexico': 'MEX', 'usa': 'USA',
  'united-states': 'USA', 'united states': 'USA', 'canada': 'CAN',
  'costa rica': 'CRC', 'jamaica': 'JAM', 'honduras': 'HON', 'panama': 'PAN',
  'nigeria': 'NGA', 'ghana': 'GHA', 'senegal': 'SEN', 'ivory coast': 'CIV',
  "cote d'ivoire": 'CIV', 'cameroon': 'CMR', 'mali': 'MLI', 'morocco': 'MAR',
  'algeria': 'ALG', 'tunisia': 'TUN', 'egypt': 'EGY', 'south africa': 'RSA',
  'dr congo': 'COD', 'congo dr': 'COD', 'congo': 'CGO', 'guinea': 'GUI',
  'burkina faso': 'BFA', 'gabon': 'GAB', 'zambia': 'ZAM', 'zimbabwe': 'ZIM',
  'angola': 'ANG', 'cape verde': 'CPV', 'cape verde islands': 'CPV',
  'gambia': 'GAM', 'togo': 'TOG', 'benin': 'BEN', 'kenya': 'KEN',
  'japan': 'JPN', 'south korea': 'KOR', 'korea republic': 'KOR', 'china': 'CHN',
  'china pr': 'CHN', 'australia': 'AUS', 'iran': 'IRN', 'iraq': 'IRQ',
  'saudi arabia': 'KSA', 'qatar': 'QAT', 'united arab emirates': 'UAE',
  'uzbekistan': 'UZB', 'india': 'IND', 'new zealand': 'NZL', 'jordan': 'JOR',
  'syria': 'SYR', 'lebanon': 'LBN',
};
function cc3(name) {
  if (!name) return null;
  const k = String(name).toLowerCase().trim();
  return CC3[k] || (k.length >= 3 ? k.slice(0, 3).toUpperCase() : null);
}
const COUNTRY_NAMES = new Set(Object.keys(CC3));
function looksNational(teamName) {
  const k = String(teamName || '').toLowerCase().trim();
  if (/\bu-?\d{2}\b/.test(k) || /\bolympic|olympics\b/.test(k)) return true;
  return COUNTRY_NAMES.has(k);
}

/* ---------- role mapping ---------- */
const ROLE_BY_POS = { goalkeeper: 'GK', defender: 'DEF', midfielder: 'MID', attacker: 'ATT' };
function roleFrom(position) {
  const k = String(position || '').toLowerCase();
  return ROLE_BY_POS[k] || 'MID';
}

/* ---------- squad (players/squads + players) ---------- */
function statRowFor(statistics, leagueId) {
  const arr = Array.isArray(statistics) ? statistics : [];
  if (!arr.length) return null;
  return arr.find((s) => s.league && s.league.id === leagueId)
    || arr.slice().sort((a, b) => (b.games && b.games.minutes || 0) - (a.games && a.games.minutes || 0))[0]
    || arr[0];
}
function statsFrom(row) {
  if (!row) return null;
  const g = row.games || {}, go = row.goals || {}, c = row.cards || {};
  const red = (num(c.red) || 0) + (num(c.yellowred) || 0);
  const s = {
    goals: num(go.total), assists: num(go.assists),
    minutes: num(g.minutes), apps: num(g.appearences),
    yellow: num(c.yellow), red: red || null,
    rating: num(g.appearences) ? fnum(g.rating) : null,   // a 0-app "rating" of 0 is noise
  };
  return Object.values(s).some((v) => v != null) ? s : null;
}

// API-Football's registered squad role is the best primary-position signal. A
// player can also have a different games.position in another competition; keep
// the distinct values so the UI can surface that versatility without AI calls.
function positionCode(position) {
  const raw = String(position || '').trim();
  const k = raw.toLowerCase();
  if (!raw) return null;
  if (k === 'goalkeeper') return 'GK';
  if (k === 'defender') return 'DEF';
  if (k === 'midfielder') return 'MID';
  if (k === 'attacker') return 'ATT';
  return raw;
}
function positionsFrom(position, row) {
  const raw = [position].concat(((row && row.statistics) || []).map((s) => s && s.games && s.games.position));
  return [...new Set(raw.map(positionCode).filter(Boolean))];
}

async function getSquad(teamId, teamName, leagueId, season) {
  const cachePath = `${TEAMS_DIR}/${teamId}.json`;
  const cached = readJSON(cachePath);
  if (cached && cached.fetchedAt && daysBetween(todayISO(), cached.fetchedAt) < SQUAD_TTL_DAYS) {
    return cached;
  }

  const rosterJ = await af('players/squads', { team: teamId });
  const roster = (rosterJ && rosterJ.response && rosterJ.response[0] && rosterJ.response[0].players) || [];

  // per-player bio + season stats, paginated
  const byId = new Map();
  const first = await af('players', { team: teamId, season, page: 1 });
  const pages = (first && first.paging && first.paging.total) || 1;
  const collect = (j) => {
    for (const row of (j && j.response) || []) {
      if (row.player && row.player.id != null) byId.set(row.player.id, row);
    }
  };
  collect(first);
  for (let p = 2; p <= Math.min(pages, 6); p++) {
    collect(await af('players', { team: teamId, season, page: p }));
  }

  const seen = new Set();
  const squad = [];
  const pushPlayer = (id, name, age, number, position) => {
    if (id != null && seen.has(id)) return;
    if (id != null) seen.add(id);
    const row = id != null ? byId.get(id) : null;
    const pl = row && row.player;
    const st = statsFrom(statRowFor(row && row.statistics, leagueId));
    const positions = positionsFrom(position || (st && st.position), row);
    const injured = !!(pl && pl.injured);
    // API-Football's own `name` field is inconsistent: for well-known players
    // it's already abbreviated ("B. Samba"), for fringe/academy players it's
    // already a normal full name ("António Silva", "Ayoube Akabou") — that
    // second case needs no fixing. Only reconstruct from firstname+lastname
    // (present on the detailed /players object) when the given name actually
    // looks like the abbreviated "X. Surname" form, so the UI's own
    // shortName() has something to abbreviate for pitch labels. Reconstructing
    // unconditionally risks an incomplete legal name for multi-part surnames
    // (firstname/lastname splits are themselves inconsistent on API-Football).
    const baseName = name || (pl && pl.name) || null;
    const looksAbbreviated = baseName != null && /^\S+\.\s/.test(baseName);
    const fullName = looksAbbreviated && pl && has(pl.firstname) && has(pl.lastname)
      ? `${pl.firstname} ${pl.lastname}`.trim() : null;
    squad.push({
      _id: id,
      number: num(number),
      name: fullName || baseName,
      pos: positions[0] || null,
      positions,
      role: roleFrom(position || (st && st.position)),
      age: num(age != null ? age : (pl && pl.age)),
      height: pl ? num(String(pl.height || '').replace(/[^0-9]/g, '')) : null,
      weight: pl ? num(String(pl.weight || '').replace(/[^0-9]/g, '')) : null,
      foot: null,
      nat: pl ? cc3(pl.nationality) : null,
      natTeam: null,
      birthCountry: (pl && pl.birth && pl.birth.country) || null,
      pronunciation: null,
      career: null,
      lastSeason: null,
      funfact: null,
      linkLine: null,
      status: injured ? 'out' : 'available',
      statusNote: injured ? 'Accidentat' : null,
      stats: st,
    });
  };

  for (const m of roster) pushPlayer(m.id, m.name, m.age, m.number, m.position);
  // players with season minutes who aren't in the published roster list (loaned
  // back, late list changes) — include them too so stats aren't lost
  for (const [id, row] of byId) {
    if (seen.has(id)) continue;
    const g = row.statistics && statRowFor(row.statistics, leagueId);
    if (!g || !(g.games && g.games.minutes)) continue;
    pushPlayer(id, row.player.name, row.player.age, g.games.number, g.games.position);
  }

  if (!squad.length) {
    if (cached) { console.log(`  team ${teamId}: API empty, keeping cache from ${cached.fetchedAt}`); return cached; }
    console.log(`  team ${teamId}: no squad`);
    return null;
  }

  const coach = await getCoach(teamId);
  const rec = {
    teamId, name: teamName || (cached && cached.name) || null,
    fetchedAt: todayISO(), source: SOURCE.url,
    coach, squad,
  };
  writeJSON(cachePath, rec);
  console.log(`  team ${teamId} (${rec.name}): cached ${squad.length} players`);
  return rec;
}

/* ---------- coach (coachs) ---------- */
async function getCoach(teamId) {
  const j = await af('coachs', { team: teamId });
  const list = (j && j.response) || [];
  // the current coach: a career row for this team with no end date
  let cur = null;
  for (const c of list) {
    const row = (c.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
    if (row) { cur = c; break; }
  }
  if (!cur) return { name: 'n/d' };
  const career = (cur.career || [])
    .filter((e) => e.team && e.team.name)
    .map((e) => ({
      club: e.team.name,
      period: `${(e.start || '').slice(0, 4) || '?'}–${e.end ? (e.end || '').slice(0, 4) : 'prezent'}`,
      note: null,
    }))
    .slice(0, 12);
  const tenure = (cur.career || []).find((e) => e.team && e.team.id === teamId && !e.end);
  return {
    _id: cur.id,   // stripped before the match file is written; used to fetch trophies?coach=
    name: cur.name || 'n/d',
    country: cur.nationality || null,
    age: num(cur.age),
    tenureFrom: tenure && tenure.start ? tenure.start.slice(0, 7) : null,
    career: career.length ? career : undefined,
  };
}

/* ---------- coach trophies (trophies?coach=, cached long-term — history barely changes) ---------- */
const TROPHY_TTL = 60;
async function getTrophies(kind, id, cache) {
  cache.trophies = cache.trophies || {};
  const key = `${kind}${id}`;
  const hit = cache.trophies[key];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < TROPHY_TTL) return hit.list;
  const j = await af('trophies', { [kind]: id });
  const rows = (j && j.response) || [];
  const list = rows
    .filter((r) => r.league && r.place)
    .map((r) => ({
      competition: r.league,
      country: r.country || null,
      season: r.season != null ? String(r.season) : null,
      place: r.place,
    }))
    .slice(0, 20);
  cache.trophies[key] = { fetchedAt: todayISO(), list };
  return list;
}
async function applyCoachTrophies(doc, cache) {
  for (const side of ['home', 'away']) {
    const coach = doc.teams[side].coach;
    if (!coach) continue;
    const id = coach._id;
    delete coach._id;
    if (id == null || (coach.trophies && coach.trophies.length)) continue;
    const list = await getTrophies('coach', id, cache);
    if (list.length) coach.trophies = list;
  }
}

/* ---------- injuries ---------- */
function classifyReason(reason) {
  const k = String(reason || '').toLowerCase();
  if (/suspend|red card|ban\b|banned/.test(k)) return 'suspension';
  if (/doubt|knock|assess|questionable|fitness test|late test/.test(k)) return 'doubt';
  return 'injury';
}
async function getAbsences(teamId, season) {
  const j = await af('injuries', { team: teamId, season });
  const rows = (j && j.response) || [];
  if (!rows.length) return [];
  // keep only the most recent fixture's entries (the current bulletin)
  let latest = '';
  for (const r of rows) {
    const d = (r.fixture && r.fixture.date) || '';
    if (d > latest) latest = d;
  }
  const cutoff = latest ? latest.slice(0, 10) : null;
  const byName = new Map();
  for (const r of rows) {
    const d = (r.fixture && r.fixture.date || '').slice(0, 10);
    if (cutoff && d !== cutoff) continue;
    const name = r.player && r.player.name;
    if (!name || byName.has(name)) continue;
    const reason = (r.player && r.player.reason) || null;
    byName.set(name, {
      name,
      reason: classifyReason(reason),
      detail: reason,
      since: d || null,
    });
  }
  return [...byName.values()];
}

/* ---------- referee + venue (fixtures?id= , venues) ---------- */
async function getFixtureMeta(eventId, cache) {
  const j = await af('fixtures', { id: eventId });
  const f = j && j.response && j.response[0];
  if (!f) return { referee: null, venue: null, lineups: null };
  const refRaw = f.fixture && f.fixture.referee;
  let referee = null;
  if (refRaw) {
    const [nm, country] = String(refRaw).split(',').map((s) => s.trim());
    referee = { name: nm, country: country || null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null };
  }
  let venue = null;
  const v = f.fixture && f.fixture.venue;
  if (v && v.name) {
    venue = { name: v.name, capacity: null, city: v.city || null, notes: null };
    if (v.id) {
      cache.venues = cache.venues || {};
      let vc = cache.venues[v.id];
      if (!vc) {
        const vj = await af('venues', { id: v.id });
        const vr = vj && vj.response && vj.response[0];
        vc = vr ? { capacity: num(vr.capacity), city: vr.city || null } : { capacity: null, city: null };
        cache.venues[v.id] = vc;
      }
      if (vc.capacity != null) venue.capacity = vc.capacity;
      if (!venue.city && vc.city) venue.city = vc.city;
    }
  }
  // lineups (present only ~1h before kickoff); colors come with them
  const luJ = await af('fixtures/lineups', { fixture: eventId });
  const lu = luJ && luJ.response;
  let lineups = null;
  const colors = {};
  if (lu && lu.length === 2) {
    lineups = {};
    for (const side of lu) {
      const xi = (side.startXI || []).map((e) => e.player)
        .filter((p) => p && p.name)
        .map((p) => ({ number: num(p.number), name: p.name, pos: p.pos || 'n/d' }));
      lineups[side.team.id] = { xi, formation: side.formation || 'n/d' };
      const pc = side.team && side.team.colors && side.team.colors.player;
      if (pc && pc.primary) {
        colors[side.team.id] = { primary: '#' + pc.primary, secondary: pc.border ? '#' + pc.border : null };
      }
    }
  }
  return { referee, venue, lineups, colors };
}

// the home team's registered stadium — a reliable fallback when the fixture
// object has no venue (common in the lower leagues). Cached forever.
async function getTeamVenue(teamId, cache) {
  cache.teamVenues = cache.teamVenues || {};
  if (String(teamId) in cache.teamVenues) return cache.teamVenues[teamId];
  const j = await af('teams', { id: teamId });
  const v = j && j.response && j.response[0] && j.response[0].venue;
  const rec = (v && v.name)
    ? { name: v.name, capacity: num(v.capacity), city: v.city || null, notes: null }
    : null;
  cache.teamVenues[teamId] = rec;
  return rec;
}

/* ---------- weather forecast at the venue (Open-Meteo, free, no key) ---------- */
const WMO_CONDITION = {
  0: 'cer clar', 1: 'cer clar', 2: 'parțial noros', 3: 'cer noros',
  45: 'ceață', 48: 'ceață',
  51: 'ploaie ușoară', 53: 'ploaie', 55: 'ploaie intensă',
  61: 'ploaie ușoară', 63: 'ploaie', 65: 'ploaie intensă',
  71: 'ninsoare ușoară', 73: 'ninsoare', 75: 'ninsoare intensă',
  80: 'aversă', 81: 'aversă', 82: 'aversă intensă',
  95: 'furtună', 96: 'furtună cu grindină', 99: 'furtună cu grindină',
};
async function geocodeCity(city, cache) {
  cache.geo = cache.geo || {};
  const key = norm(city);
  if (key in cache.geo) return cache.geo[key];
  let coords = null;
  try {
    const r = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(city)}&count=1`);
    if (r.ok) {
      const j = await r.json();
      const hit = j && j.results && j.results[0];
      if (hit) coords = { lat: hit.latitude, lon: hit.longitude };
    }
  } catch (e) { /* best-effort, no key/budget involved */ }
  cache.geo[key] = coords;
  return coords;
}
// Forecast accuracy is only meaningful in the last few days before kickoff,
// which is exactly the window this is called in (see needWeather below).
async function getWeather(venue, kickoffISO, cache) {
  if (!venue || !has(venue.city) || !has(kickoffISO)) return null;
  const coords = await geocodeCity(venue.city, cache);
  if (!coords) return null;
  const kickoff = new Date(kickoffISO);
  if (Number.isNaN(kickoff.getTime())) return null;
  let j;
  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}` +
      `&hourly=temperature_2m,precipitation,wind_speed_10m,weathercode&timezone=UTC&forecast_days=7`;
    const r = await fetch(url);
    if (!r.ok) return null;
    j = await r.json();
  } catch (e) { return null; }
  const times = j && j.hourly && j.hourly.time;
  if (!times || !times.length) return null;
  const target = kickoff.toISOString().slice(0, 13) + ':00';
  let idx = times.indexOf(target);
  if (idx === -1) {
    let best = -1, bestDiff = Infinity;
    for (let i = 0; i < times.length; i++) {
      const diff = Math.abs(new Date(times[i] + 'Z').getTime() - kickoff.getTime());
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    idx = best;
  }
  if (idx === -1) return null;
  return {
    tempC: num(j.hourly.temperature_2m[idx]),
    condition: WMO_CONDITION[j.hourly.weathercode[idx]] || null,
    windKph: num(j.hourly.wind_speed_10m[idx]),
    precipitationMm: num(j.hourly.precipitation[idx]),
    forecastAt: todayISO(),
  };
}

/* ---------- standings + form + team stats + h2h (cached) ---------- */
async function getStandings(leagueId, season, cache) {
  cache.standings = cache.standings || {};
  const hit = cache.standings[leagueId];
  // v:2 added the full `rows` table — ignore older cache entries that lack it
  if (hit && hit.v === 2 && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < STANDINGS_TTL) return hit;
  const j = await af('standings', { league: leagueId, season });
  const table = j && j.response && j.response[0] && j.response[0].league
    && j.response[0].league.standings && j.response[0].league.standings[0];
  if (!Array.isArray(table) || !table.length) return hit || null;
  const byId = {}, byName = {}, rows = [];
  for (const row of table) {
    const t = row.team || {};
    const rec = {
      id: t.id, name: t.name,
      position: num(row.rank), points: num(row.points),
      played: row.all && num(row.all.played),
      win: row.all && num(row.all.win), draw: row.all && num(row.all.draw),
      loss: row.all && num(row.all.lose),
      gf: row.all && row.all.goals && num(row.all.goals.for),
      ga: row.all && row.all.goals && num(row.all.goals.against),
      form: row.form || null,
      home: row.home || null, away: row.away || null,
    };
    if (t.id != null) byId[t.id] = rec;
    if (t.name) byName[norm(t.name)] = rec;
    rows.push({
      rank: rec.position, teamId: t.id != null ? t.id : null, team: t.name || null,
      played: rec.played, win: rec.win, draw: rec.draw, loss: rec.loss,
      gf: rec.gf, ga: rec.ga, gd: num(row.goalsDiff), points: rec.points, form: rec.form,
    });
  }
  const rec = { fetchedAt: todayISO(), v: 2, season, byId, byName, rows };
  cache.standings[leagueId] = rec;
  return rec;
}

function splitText(home, away) {
  const s = (r) => r ? `${r.win || 0}-${r.draw || 0}-${r.lose || 0}` : null;
  const h = s(home), a = s(away);
  if (!h && !a) return null;
  return `Acasă ${h || 'n/d'}, deplasare ${a || 'n/d'}`;
}

async function getTeamStats(teamId, leagueId, season, cache) {
  cache.teamStats = cache.teamStats || {};
  const key = `${leagueId}:${teamId}`;
  const hit = cache.teamStats[key];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < TEAMSTATS_TTL) return hit.data;
  const j = await af('teams/statistics', { team: teamId, league: leagueId, season });
  const r = j && j.response;
  if (!r || !r.goals) { return hit ? hit.data : null; }
  const interval = (obj) => {
    const out = {};
    for (const [k, v] of Object.entries(obj || {})) if (v && v.total != null) out[k] = v.total;
    return Object.keys(out).length ? out : null;
  };
  const data = {
    goalsForByInterval: interval(r.goals.for && r.goals.for.minute),
    goalsAgainstByInterval: interval(r.goals.against && r.goals.against.minute),
    cardsYellowByInterval: interval(r.cards && r.cards.yellow),
    goalsForAvg: fnum(r.goals.for && r.goals.for.average && r.goals.for.average.total),
    goalsAgainstAvg: fnum(r.goals.against && r.goals.against.average && r.goals.against.average.total),
    cleanSheets: r.clean_sheet && num(r.clean_sheet.total),
    failedToScore: r.failed_to_score && num(r.failed_to_score.total),
    penaltyScored: r.penalty && r.penalty.scored && num(r.penalty.scored.total),
    penaltyScoredPct: r.penalty && r.penalty.scored && fnum(String(r.penalty.scored.percentage || '').replace('%', '')),
    formations: (r.lineups || []).filter((l) => l.formation).map((l) => ({ formation: l.formation, played: num(l.played) })),
    biggestStreak: r.biggest && r.biggest.streak
      ? { wins: num(r.biggest.streak.wins), draws: num(r.biggest.streak.draws), loses: num(r.biggest.streak.loses) }
      : null,
  };
  cache.teamStats[key] = { fetchedAt: todayISO(), data };
  return data;
}

// last ~6 results, this team's perspective (form guide)
async function getFormGuide(teamId, season) {
  const j = await af('fixtures', { team: teamId, season, last: 6 });
  const rows = (j && j.response) || [];
  return rows
    .filter((f) => f.goals && f.goals.home != null && f.goals.away != null)
    .map((f) => {
      const home = f.teams.home.id === teamId;
      const us = home ? f.goals.home : f.goals.away;
      const them = home ? f.goals.away : f.goals.home;
      return {
        date: (f.fixture.date || '').slice(0, 10),
        opp: home ? f.teams.away.name : f.teams.home.name,
        homeAway: home ? 'H' : 'A',
        comp: f.league && f.league.name || null,
        score: `${us}-${them}`,
        result: us > them ? 'W' : us < them ? 'L' : 'D',
      };
    });
}

// the team's next 3 scheduled fixtures (not yet played)
async function getNextFixtures(teamId, season) {
  const j = await af('fixtures', { team: teamId, season, next: 3 });
  const rows = (j && j.response) || [];
  return rows.map((f) => {
    const home = f.teams.home.id === teamId;
    return {
      date: (f.fixture.date || '').slice(0, 10),
      opp: home ? f.teams.away.name : f.teams.home.name,
      homeAway: home ? 'H' : 'A',
      comp: f.league && f.league.name || null,
    };
  });
}

async function getH2H(homeId, awayId, homeName, awayName, cache) {
  cache.h2h = cache.h2h || {};
  const key = [homeId, awayId].sort((a, b) => a - b).join('-');
  const hit = cache.h2h[key];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < H2H_TTL) return hit;
  const j = await af('fixtures/headtohead', { h2h: `${homeId}-${awayId}`, last: 10 });
  const rows = ((j && j.response) || []).filter((f) => f.goals && f.goals.home != null);
  if (!rows.length) return hit || null;
  let hw = 0, aw = 0, d = 0;
  for (const f of rows) {
    const hg = f.teams.home.id === homeId ? f.goals.home : f.goals.away;
    const ag = f.teams.home.id === homeId ? f.goals.away : f.goals.home;
    if (hg > ag) hw++; else if (hg < ag) aw++; else d++;
  }
  const recent = rows.slice(0, 5).map((f) => ({
    date: (f.fixture.date || '').slice(0, 10),
    comp: f.league && f.league.name || null,
    score: `${f.teams.home.name} ${f.goals.home}-${f.goals.away} ${f.teams.away.name}`,
  }));
  const rec = {
    fetchedAt: todayISO(),
    recent,
    summary: `Cap la cap (${rows.length} meciuri): ${homeName} ${hw} - ${d} - ${aw} ${awayName}.`,
  };
  cache.h2h[key] = rec;
  return rec;
}

/* ---------- player careers (players/teams, cached 30d) ---------- */
async function getCareer(playerId, cache) {
  cache.careers = cache.careers || {};
  const hit = cache.careers[playerId];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < CAREER_TTL) return hit.career;
  const j = await af('players/teams', { player: playerId });
  const rows = (j && j.response) || [];
  const clubs = rows
    .filter((r) => r.team && r.team.name && !looksNational(r.team.name) && Array.isArray(r.seasons) && r.seasons.length)
    .map((r) => ({ name: r.team.name, min: Math.min(...r.seasons), max: Math.max(...r.seasons) }))
    .sort((a, b) => a.min - b.min || a.max - b.max);
  const thisYear = currentSeason();
  const parts = clubs.map((c) => {
    const end = c.max >= thisYear ? 'prezent' : String(c.max);
    return c.min === c.max && end !== 'prezent'
      ? `${c.name} (${c.min})`
      : `${c.name} (${c.min}–${end})`;
  });
  const career = parts.length ? parts.slice(0, 10).join(' · ') : null;
  cache.careers[playerId] = { fetchedAt: todayISO(), career };
  return career;
}

async function applyCareers(doc, cache) {
  for (const side of ['home', 'away']) {
    const idRows = doc.teams[side]._squadIds || [];   // same order/length as squad
    const squad = doc.teams[side].squad || [];
    const targets = squad
      .map((p, i) => ({ p, id: idRows[i] && idRows[i]._id }))
      .filter((x) => x.id != null && !has(x.p.career))
      .sort((a, b) => ((b.p.stats && b.p.stats.minutes) || 0) - ((a.p.stats && a.p.stats.minutes) || 0))
      .slice(0, CAREER_MAX_PLAYERS);
    let filled = 0;
    for (const { p, id } of targets) {
      const c = await getCareer(id, cache);
      if (c) { p.career = c; filled++; }
    }
    if (filled) console.log(`  careers ${side}: ${filled}`);
  }
}

/* ---------- RSS news candidates (Google News) — unchanged, no key ---------- */
const RSS_DAYS = 4;
const NEWS_PER_TEAM = 8;
function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, dd) => String.fromCodePoint(parseInt(dd, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '').trim();
}
function isoDay(d) {
  const dt = new Date(d);
  return Number.isNaN(dt.getTime()) ? null : dt.toISOString().slice(0, 10);
}
async function fetchRss(query) {
  const url = `https://news.google.com/rss/search?q=${encodeURIComponent(query)}&hl=en-US&gl=US&ceid=US:en`;
  let xml;
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (match-center prefetch)' } });
    if (!r.ok) { console.error(`  rss "${query}": HTTP ${r.status}`); return []; }
    xml = await r.text();
  } catch (e) {
    console.error(`  rss "${query}": ${e.message}`);
    return [];
  }
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    const link = (block.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || '';
    const pub = (block.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || '';
    const src = (block.match(/<source[^>]*>([\s\S]*?)<\/source>/) || [])[1] || '';
    let title = decodeEntities(rawTitle);
    const source = decodeEntities(src) || null;
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title) continue;
    items.push({ title, url: link.trim() || null, source, published: isoDay(pub) });
  }
  return items;
}
async function teamNews(teamName, oppName) {
  const cutoff = new Date(Date.now() - RSS_DAYS * 86400000).toISOString().slice(0, 10);
  const queries = [`"${teamName}" when:${RSS_DAYS}d`, `"${teamName}" "${oppName}" when:7d`];
  const seen = new Set();
  const out = [];
  for (const q of queries) {
    for (const it of await fetchRss(q)) {
      const k = norm(it.title);
      if (!k || seen.has(k)) continue;
      if (it.published && it.published < cutoff) continue;
      seen.add(k);
      out.push(it);
    }
  }
  out.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  return out.slice(0, NEWS_PER_TEAM);
}

/* ---------- predictions (predictions?fixture=) — API-Football's own
   algorithmic model, not AI-written. Not cached: the provider recomputes it
   roughly hourly as team news/form changes, and it's one call per fixture. */
function pct(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace('%', '').replace(',', '.'));
  return Number.isNaN(n) ? null : n;
}
async function getPredictions(eventId) {
  const j = await af('predictions', { fixture: eventId });
  const row = j && j.response && j.response[0];
  if (!row) return null;
  const pr = row.predictions || {};
  const comp = row.comparison || {};
  const side = (o) => (o && (o.home != null || o.away != null) ? { home: pct(o.home), away: pct(o.away) } : null);
  const out = {
    winnerName: (pr.winner && pr.winner.name) || null,
    winOrDraw: typeof pr.win_or_draw === 'boolean' ? pr.win_or_draw : null,
    advice: pr.advice || null,
    percent: pr.percent ? { home: pct(pr.percent.home), draw: pct(pr.percent.draw), away: pct(pr.percent.away) } : null,
    comparison: {
      form: side(comp.form), attack: side(comp.att), defense: side(comp.def),
      poisson: side(comp.poisson_distribution), h2h: side(comp.h2h), goals: side(comp.goals),
    },
  };
  if (!Object.values(out.comparison).some(Boolean)) out.comparison = null;
  const empty = !out.winnerName && !out.advice && !out.percent && !out.comparison;
  return empty ? null : out;
}

/* ---------- build one match file ---------- */
function emptyTeamBlock(name) {
  return {
    name, shortName: null, colors: null,
    coach: { name: 'n/d' },
    formation: 'n/d', predictedXI: [], confirmedXI: null, squad: [],
    form: null, absences: [], mercatoIn: [], mercatoOut: [], preseason: [],
    news: [], newsCandidates: [], stories: [],
  };
}

async function buildMatch(fx, season, cache) {
  const leagueId = AF_LEAGUE_ID[fx.comp] || fx.leagueId || null;
  const eventId = fx.eventId;

  const [homeSquad, awaySquad, meta, homeNews, awayNews, predictions] = await Promise.all([
    fx.homeId != null ? getSquad(fx.homeId, fx.home, leagueId, season) : Promise.resolve(null),
    fx.awayId != null ? getSquad(fx.awayId, fx.away, leagueId, season) : Promise.resolve(null),
    eventId != null ? getFixtureMeta(eventId, cache) : Promise.resolve({ referee: null, venue: null, lineups: null }),
    teamNews(fx.home, fx.away),
    teamNews(fx.away, fx.home),
    eventId != null ? getPredictions(eventId) : Promise.resolve(null),
  ]);

  const out = {
    slug: fx.slug,
    generatedAt: todayISO(),
    partial: true,
    sources: [{ ...SOURCE, accessed: todayDate() }],
    competition: { name: fx.comp, round: fx.round, country: fx.country || 'n/d' },
    kickoff: fx.kickoff || 'n/d',
    venue: (meta && meta.venue) || { name: has(fx.venue) ? fx.venue : 'n/d', capacity: null, city: null, notes: null },
    referee: (meta && meta.referee) || { name: 'n/d', country: null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null },
    h2h: { recent: [], summary: null },
    storyOfTheMatch: [],
    predictions: predictions || null,
    teams: { home: emptyTeamBlock(fx.home), away: emptyTeamBlock(fx.away) },
  };

  if (!has(out.venue.name) && fx.homeId != null) {
    const tv = await getTeamVenue(fx.homeId, cache);
    if (tv) out.venue = tv;
  }
  if (has(out.venue.city) && has(out.kickoff)) {
    const w = await getWeather(out.venue, out.kickoff, cache);
    if (w) out.venue.weather = w;
  }

  const bySide = {
    home: { id: fx.homeId, cache: homeSquad, news: homeNews },
    away: { id: fx.awayId, cache: awaySquad, news: awayNews },
  };
  for (const side of ['home', 'away']) {
    const t = out.teams[side];
    const { id, cache: sq, news } = bySide[side];
    if (sq && sq.squad && sq.squad.length) {
      t.squad = sq.squad.map(stripInternal);
      t._squadIds = sq.squad;   // keep _id-bearing copies for the career pass
      if (sq.coach && sq.coach.name) t.coach = sq.coach;
      t.absences = await getAbsences(id, season);
    }
    if (news && news.length) t.newsCandidates = news;
    const lu = meta && meta.lineups && id != null ? meta.lineups[id] : null;
    if (lu && lu.xi.length === 11) {
      t.confirmedXI = lu.xi;
      t.predictedXI = lu.xi;
      if (has(lu.formation)) t.formation = lu.formation;
    }
    const col = meta && meta.colors && id != null ? meta.colors[id] : null;
    if (col && col.primary) t.colors = col;
  }
  return out;
}

async function applyStandingsAndForm(doc, fx, season, cache) {
  const leagueId = AF_LEAGUE_ID[fx.comp] || fx.leagueId || null;
  if (!leagueId) return;
  const st = await getStandings(leagueId, season, cache);

  if (st && Array.isArray(st.rows) && st.rows.length && !doc.standings) {
    doc.standings = { league: fx.comp, season, rows: st.rows };
  }

  for (const side of ['home', 'away']) {
    const t = doc.teams[side];
    const id = fx[side + 'Id'];
    const row = st && (st.byId[id] || st.byName[norm(t.name)]);
    const f = t.form || { last5: [], ppg: null, homeAway: null, position: null, note: null };

    if (row) {
      if (f.position == null && row.position != null) f.position = row.position;
      if (f.table == null && row.played != null) {
        f.table = {
          played: row.played, win: row.win, draw: row.draw, loss: row.loss,
          gf: row.gf, ga: row.ga, points: row.points,
        };
      }
      if (!f.last5 || !f.last5.length) {
        f.last5 = String(row.form || '').toUpperCase().split('').filter((x) => 'WDL'.includes(x)).slice(-5);
      }
      if (row.played) f.ppg = Math.round((row.points / row.played) * 100) / 100;
      if (!has(f.homeAway)) f.homeAway = splitText(row.home, row.away);
      if (!has(f.note) && row.points != null && row.played) {
        f.note = `Clasament ${season}/${(season + 1) % 100}: locul ${row.position}, ${row.points}p` +
          (row.gf != null ? ` (${row.gf}-${row.ga})` : '');
      }
    }

    if ((!f.recent || !f.recent.length) && id != null) {
      const guide = await getFormGuide(id, season);
      if (guide.length) f.recent = guide;
    }
    if (id != null) {
      const nx = await getNextFixtures(id, season);
      if (nx.length) f.next = nx;
    }
    if (id != null && leagueId) {
      const ts = await getTeamStats(id, leagueId, season, cache);
      if (ts) f.stats = ts;
    }
    t.form = f;
  }

  if ((!doc.h2h.recent || !doc.h2h.recent.length) && fx.homeId != null && fx.awayId != null) {
    const h = await getH2H(fx.homeId, fx.awayId, fx.home, fx.away, cache);
    if (h && (h.recent.length || h.summary)) doc.h2h = { recent: h.recent, summary: h.summary };
  }
}

/* ---------- story seeds ---------- */
function computeStorySeeds(doc) {
  const out = [];
  for (const side of ['home', 'away']) {
    const t = doc.teams[side], nm = t.name;
    const f = t.form || {}, tb = f.table || {}, ts = f.stats || {};
    if (tb.points != null && tb.played) {
      out.push(`${nm} — locul ${f.position != null ? f.position : '?'} după ${tb.played} etape, ${tb.points} puncte, golaveraj ${tb.gf}-${tb.ga}.`);
    }
    const rec = (f.recent || []).map((r) => r.result).filter(Boolean);
    if (rec.length >= 3) {
      let run = 1;
      while (run < rec.length && rec[run] === rec[0]) run++;
      if (run >= 3) {
        const w = { W: 'victorii', D: 'egaluri', L: 'înfrângeri' }[rec[0]] || 'rezultate identice';
        out.push(`${nm} vine după ${run} ${w} la rând.`);
      } else {
        let unbeaten = 0;
        while (unbeaten < rec.length && rec[unbeaten] !== 'L') unbeaten++;
        if (unbeaten >= 3) out.push(`${nm} — ${unbeaten} meciuri fără înfrângere.`);
      }
    }
    if (ts.cleanSheets != null && tb.played && ts.cleanSheets >= Math.ceil(tb.played / 2)) {
      out.push(`${nm} a păstrat poarta intactă în ${ts.cleanSheets} din ${tb.played} etape.`);
    }
    const gfi = ts.goalsForByInterval || {};
    const late = (gfi['76-90'] || 0) + (gfi['91-105'] || 0);
    const totalFor = Object.values(gfi).reduce((a, b) => a + b, 0);
    if (totalFor >= 5 && late / totalFor >= 0.4) {
      out.push(`${nm} — ${late} din ${totalFor} goluri marcate după minutul 75.`);
    }
    const top = (t.squad || []).filter((p) => p.stats && p.stats.goals)
      .sort((a, b) => b.stats.goals - a.stats.goals)[0];
    if (top && top.stats.goals >= 2) {
      out.push(`${top.name} e cel mai bun marcator al echipei ${nm} în acest start de sezon (${top.stats.goals} goluri).`);
    }
  }
  if (doc.h2h && doc.h2h.summary) out.push(doc.h2h.summary);
  if (out.length) doc.storyOfTheMatch = out.slice(0, 8);
}

function stripInternal(p) {
  const { _id, ...rest } = p;
  return rest;
}
function stripSquadIds(doc) {
  for (const side of ['home', 'away']) {
    delete doc.teams[side]._squadIds;
    // safety net: applyCoachTrophies() strips this too, but only on the
    // success path — guarantee it's gone even if an earlier enrichment
    // step throws, since additionalProperties:false would reject it.
    if (doc.teams[side].coach) delete doc.teams[side].coach._id;
  }
}

/* ---------- main ---------- */
async function main() {
  const fixtures = readJSON(FIXTURES) || [];
  const season = currentSeason();
  const from = todayDate();
  const to = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });

  const inWindow = (f) => f.date && f.date !== 'n/d' && f.date >= from && f.date <= to && has(f.kickoff);
  // soonest-first, so if the per-run call budget runs out the nearest (most
  // useful) fixtures are the ones that got built
  const byKickoff = (a, b) => String(a.kickoff).localeCompare(String(b.kickoff));
  const due = fixtures.filter((f) => !f.ready && inWindow(f)).sort(byKickoff);
  const readyUpcoming = fixtures.filter((f) => f.ready && inWindow(f)).sort(byKickoff);

  if (!due.length && !readyUpcoming.length) {
    console.log('No upcoming fixtures in range. Nothing to do.');
    return;
  }
  console.log(`${due.length} partial + ${readyUpcoming.length} ready fixture(s) in the next ${DAYS_AHEAD} days:`);

  const cache = readJSON(CACHE_FILE) || {};
  const liveSlugs = new Set(fixtures.map((f) => f.slug));
  const partialSlugs = new Set(existingPartialSlugs().filter((s) => liveSlugs.has(s)));

  // full packs for upcoming fixtures: top up squad[].career, the league table
  // and each side's next-3 fixtures where they're still missing
  for (const f of readyUpcoming) {
    const path = `${MATCHES_DIR}/${f.slug}.json`;
    const doc = readJSON(path);
    if (!doc || doc.partial) continue;
    const leagueId = AF_LEAGUE_ID[f.comp] || f.leagueId || null;
    const needCareer = ['home', 'away'].some((s) => (doc.teams[s].squad || []).some((p) => !has(p.career)));
    const needStandings = !doc.standings || !(doc.standings.rows || []).length;
    const needNext = ['home', 'away'].some((s) => {
      const fm = doc.teams[s].form;
      return !fm || !fm.next || !fm.next.length;
    });
    const needVenue = !doc.venue || !has(doc.venue.name);
    const needPredictions = !doc.predictions;
    const needTrophies = ['home', 'away'].some((s) => {
      const c = doc.teams[s].coach;
      return c && has(c.name) && (!c.trophies || !c.trophies.length);
    });
    // referee + confirmed XI + kit colours are usually only published by the
    // provider in the final day(s) before kickoff — buildMatch() only runs
    // once, well before that, for a pack that's already "ready", so without
    // this check they'd never be filled in.
    const needMatchDay = !has(doc.referee && doc.referee.name) ||
      ['home', 'away'].some((s) => !doc.teams[s].confirmedXI || !doc.teams[s].confirmedXI.length);
    // news and weather go stale, unlike the fields above — re-pull them every
    // run in the last 3 days before kickoff instead of only once when missing.
    const kickoffMs = has(doc.kickoff) ? new Date(doc.kickoff).getTime() : NaN;
    const hoursToKickoff = Number.isNaN(kickoffMs) ? Infinity : (kickoffMs - Date.now()) / 3600000;
    const inDayBeforeWindow = hoursToKickoff <= 72 && hoursToKickoff > -6;
    const needNews = inDayBeforeWindow;
    const needWeather = inDayBeforeWindow && has(doc.venue && doc.venue.city);
    if (!needCareer && !needStandings && !needNext && !needVenue && !needPredictions && !needTrophies &&
        !needMatchDay && !needNews && !needWeather) continue;
    let touched = false;

    if (needNews) {
      const [hn, an] = await Promise.all([teamNews(f.home, f.away), teamNews(f.away, f.home)]);
      if (hn.length) { doc.teams.home.newsCandidates = hn; touched = true; }
      if (an.length) { doc.teams.away.newsCandidates = an; touched = true; }
    }
    if (needWeather) {
      const w = await getWeather(doc.venue, doc.kickoff, cache);
      if (w) { doc.venue.weather = w; touched = true; }
    }
    if (needMatchDay && f.eventId != null) {
      const meta = await getFixtureMeta(f.eventId, cache);
      if (meta.referee && !has(doc.referee && doc.referee.name)) { doc.referee = meta.referee; touched = true; }
      for (const side of ['home', 'away']) {
        const id = f[side + 'Id'];
        const lu = meta.lineups && id != null ? meta.lineups[id] : null;
        if (lu && lu.xi.length === 11 && (!doc.teams[side].confirmedXI || !doc.teams[side].confirmedXI.length)) {
          doc.teams[side].confirmedXI = lu.xi;
          if (has(lu.formation)) doc.teams[side].formation = lu.formation;
          touched = true;
        }
        const col = meta.colors && id != null ? meta.colors[id] : null;
        if (col && col.primary && !doc.teams[side].colors) { doc.teams[side].colors = col; touched = true; }
      }
    }

    if (needVenue && f.homeId != null) {
      const tv = await getTeamVenue(f.homeId, cache);
      if (tv) { doc.venue = tv; touched = true; }
    }
    if (needPredictions && f.eventId != null) {
      const pr = await getPredictions(f.eventId);
      if (pr) { doc.predictions = pr; touched = true; }
    }
    if (needStandings && leagueId) {
      const st = await getStandings(leagueId, season, cache);
      if (st && (st.rows || []).length) { doc.standings = { league: f.comp, season, rows: st.rows }; touched = true; }
    }
    for (const side of ['home', 'away']) {
      const id = f[side + 'Id'];
      if (id == null) continue;
      if (needCareer) {
        const sq = await getSquad(id, f[side === 'home' ? 'home' : 'away'], leagueId, season);
        const ids = sq && sq.squad || [];
        for (const p of doc.teams[side].squad || []) {
          if (has(p.career)) continue;
          const match = ids.find((x) => norm(x.name) === norm(p.name) || (p.number != null && x.number === p.number));
          if (!match || match._id == null) continue;
          const c = await getCareer(match._id, cache);
          if (c) { p.career = c; touched = true; }
        }
      }
      const fm = doc.teams[side].form;
      if (fm && (!fm.next || !fm.next.length)) {
        const nx = await getNextFixtures(id, season);
        if (nx.length) { fm.next = nx; touched = true; }
      }
      const coach = doc.teams[side].coach;
      if (needTrophies && coach && has(coach.name) && (!coach.trophies || !coach.trophies.length)) {
        const cinfo = await getCoach(id);
        if (cinfo && cinfo._id != null) {
          const list = await getTrophies('coach', cinfo._id, cache);
          if (list.length) { coach.trophies = list; touched = true; }
        }
      }
    }
    if (touched) { writeJSON(path, doc); console.log(`- ${f.slug}: topped up`); }
  }

  for (const f of due) {
    const existing = readJSON(`${MATCHES_DIR}/${f.slug}.json`);
    if (existing && !existing.partial) {
      console.log(`- ${f.slug}: full pack already present, skipping`);
      partialSlugs.delete(f.slug);
      continue;
    }
    console.log(`- ${f.slug}:`);

    let doc;
    try {
      doc = await buildMatch(f, season, cache);
    } catch (e) {
      console.error(`  build failed: ${e.message}`);
      continue;
    }
    const gotSquad = doc.teams.home.squad.length || doc.teams.away.squad.length;
    if (!gotSquad && !existing) {
      console.log('  nothing usable from the API and no file yet — skipping');
      continue;
    }
    try {
      await applyStandingsAndForm(doc, f, season, cache);
      await applyCareers(doc, cache);
      await applyCoachTrophies(doc, cache);
    } catch (e) {
      console.error(`  enrich failed: ${e.message}`);
    }
    computeStorySeeds(doc);
    stripSquadIds(doc);
    writeJSON(`${MATCHES_DIR}/${f.slug}.json`, doc);
    partialSlugs.add(f.slug);
    console.log(`  wrote docs/data/matches/${f.slug}.json (partial${doc.h2h.recent.length ? ', +h2h' : ''})`);
  }

  writeJSON(CACHE_FILE, cache);
  writeJSON(PREVIEWS, [...partialSlugs].sort());
  console.log(`previews.json: ${partialSlugs.size} partial pack(s); API-Football calls: ${_calls}`);
}

function existingPartialSlugs() {
  let names = [];
  try { names = readdirSync(MATCHES_DIR).filter((n) => n.endsWith('.json')); } catch { return []; }
  return names
    .map((n) => ({ slug: n.replace(/\.json$/, ''), j: readJSON(`${MATCHES_DIR}/${n}`) }))
    .filter((x) => x.j && x.j.partial === true)
    .map((x) => x.slug);
}

main().catch((e) => { console.error(e); process.exit(1); });
