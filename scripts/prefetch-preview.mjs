// Deterministic pre-fill of docs/data/matches/<slug>.json for upcoming fixtures
// that don't have a full research pack yet. NO AI — so no hallucination risk and
// no API-token cost. Pulls the factual skeleton straight from
// free-api-live-football-data (RapidAPI):
//
//   - full squad for both teams, each player with shirt number, age, country
//     (3-letter code), height, detailed position and current-season aggregates
//     (goals, assists, yellow/red cards, rating)
//   - head coach name
//   - injury list -> teams.<side>.absences[]
//   - referee name, venue (name / capacity / city)
//   - the confirmed lineup + formation, once the feed publishes it (usually only
//     ~1h before kickoff, so most prefetch runs leave predictedXI empty and the
//     client-side call in match.html fills it in later)
//
// The file is written schema-valid with "partial": true. The match-data-json
// skill later upgrades the SAME file with the editorial layer (form, head to
// head, probable XI, story bars, funfacts, coach careers, mercato, news) and
// removes the partial flag. Nothing here ever sets fixtures.json `ready` or
// touches a file that already holds a full (non-partial) pack.
//
// Squads are cached per team at docs/data/teams/<teamId>.json and reused across
// every fixture that team plays, refetched only when older than SQUAD_TTL_DAYS.
//
// Requires Node 18+ (global fetch) and env RAPIDAPI_KEY.
// Run daily by .github/workflows/prefetch-preview.yml, after refresh-fixtures.

import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HOST = 'https://free-api-live-football-data.p.rapidapi.com';
const API_KEY = process.env.RAPIDAPI_KEY;
if (!API_KEY) {
  console.error('Missing RAPIDAPI_KEY env var.');
  process.exit(1);
}
const HEADERS = {
  'x-rapidapi-host': 'free-api-live-football-data.p.rapidapi.com',
  'x-rapidapi-key': API_KEY,
};

const DAYS_AHEAD = 6;      // only prefetch fixtures kicking off within this window
const SQUAD_TTL_DAYS = 3;  // refetch a cached team squad once it is older than this

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = ROOT + 'docs/data/fixtures.json';
const MATCHES_DIR = ROOT + 'docs/data/matches';
const TEAMS_DIR = ROOT + 'docs/data/teams';
const PREVIEWS = ROOT + 'docs/data/previews.json';

const SOURCE = {
  name: 'free-api-live-football-data (RapidAPI)',
  url: 'https://rapidapi.com/Creativesdev/api/free-api-live-football-data',
};

// Second RapidAPI source: soccer-football-info (free tier ~200 calls/day, so
// SERVER-SIDE ONLY — never the public docs/app/config.js key). Same RapidAPI
// account key as RAPIDAPI_KEY; the account must be subscribed to this API.
// Used for head-to-head and league-table context that the primary feed lacks.
const SFI_HOST = 'https://soccer-football-info.p.rapidapi.com';
const SFI_HEADERS = { 'x-rapidapi-host': 'soccer-football-info.p.rapidapi.com', 'x-rapidapi-key': API_KEY };
const SFI_FILE = `${TEAMS_DIR}/_sfi.json`;   // shared cache: championship ids, standings, h2h
const SFI_STANDINGS_TTL = 2;
const SFI_H2H_TTL = 14;
const SFI_CALL_BUDGET = 150;                 // hard stop well under the 200/day tier
const SFI_SOURCE = { name: 'soccer-football-info (RapidAPI)', url: 'https://rapidapi.com/soccerfootball/api/soccer-football-info' };
const SFI_LEAGUE = {
  'Premier League': { cc: 'GB', re: /premier league/i },
  'Ligue 1':        { cc: 'FR', re: /\bligue 1\b/i },
  'LaLiga':         { cc: 'ES', re: /primera liga/i },
  'Serie A':        { cc: 'IT', re: /\bserie a\b/i },
  'Bundesliga':     { cc: 'DE', re: /\bbundesliga\b/i },
  'Superliga':      { cc: 'RO', re: /liga i\b/i },
};
const SFI_EXCLUDE = /women|femin|u1[6-9]|u2[0-3]|youth|reserve|primavera|play-?off|segunda|serie b|serie d|ligue 2|2\.\s*bundesliga|\bii\b/i;

/* ---------- small helpers ---------- */
function todayISO() { return new Date().toISOString(); }
function todayDate() { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }); }
function daysBetween(a, b) { return Math.round((new Date(a) - new Date(b)) / 86400000); }
function num(v) { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; }
function fnum(v) { const n = parseFloat(v); return Number.isNaN(n) ? null : n; }
function has(v) { return v != null && v !== '' && v !== 'n/d'; }

function readJSON(path) {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
}
function writeJSON(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n');
}

async function api(path, params) {
  const qs = Object.entries(params || {})
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  let r;
  try {
    r = await fetch(url, { headers: HEADERS });
  } catch (e) {
    console.error(`  api ${path}: ${e.message}`);
    return null;
  }
  if (!r.ok) { console.error(`  api ${path}: HTTP ${r.status}`); return null; }
  let j;
  try { j = await r.json(); } catch { return null; }
  if (j && j.status && j.status !== 'success') return null;
  return j;
}

function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD')
    .replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}

/* ---------- squad mapping (mirrors docs/app/match.js mapSquadMember) ---------- */
const ROLE_WORDS = {
  goalkeeper: 'GK', keeper: 'GK', defender: 'DEF', defence: 'DEF',
  midfield: 'MID', midfielder: 'MID', attacker: 'ATT', forward: 'ATT', striker: 'ATT',
};
function roleFrom(groupTitle, member) {
  const k = ((member && member.role && (member.role.key || member.role.fallback)) || groupTitle || '').toLowerCase();
  const hit = Object.keys(ROLE_WORDS).find((w) => k.indexOf(w) >= 0);
  return hit ? ROLE_WORDS[hit] : null;
}
function isCoachEntry(groupTitle, member) {
  const k = ((member && member.role && (member.role.key || member.role.fallback)) || groupTitle || '').toLowerCase();
  return k.indexOf('coach') >= 0 || k.indexOf('manager') >= 0 || k.indexOf('staff') >= 0;
}
function mapSquadMember(m, groupTitle) {
  const name = m.name || m.cname || (m.player && m.player.name) || null;
  if (!name) return null;
  const posDesc = (m.positionIdsDesc || m.positionDesc || m.position || '').toString();
  const pos = posDesc ? posDesc.split(',')[0].trim() : null;
  const injured = m.injured === true || (m.injury != null && m.injury !== false);
  const ret = (m.injury && (m.injury.expectedReturn || m.injury.returnDate)) || null;
  const stats = {
    goals: num(m.goals),
    assists: num(m.assists),
    minutes: num(m.minutesPlayed != null ? m.minutesPlayed : m.minutes),
    apps: num(m.appearances != null ? m.appearances : m.matches),
    yellow: num(m.ycards != null ? m.ycards : m.yellowCards),
    red: num(m.rcards != null ? m.rcards : m.redCards),
    rating: fnum(m.rating),
  };
  const hasStat = Object.values(stats).some((v) => v != null);
  return {
    number: num(m.shirtNumber != null ? m.shirtNumber : m.jerseyNumber),
    name,
    pos: pos || null,
    role: roleFrom(groupTitle, m) || 'MID',
    age: num(m.age),
    height: num(m.height),
    weight: null,
    foot: null,
    nat: m.ccode || m.countryCode || null,
    natTeam: null,
    birthCountry: m.cname || m.country || null,
    pronunciation: null,
    career: null,
    lastSeason: null,
    funfact: null,
    linkLine: null,
    status: injured ? 'out' : 'available',
    statusNote: injured ? ('Accidentat' + (ret ? ' — revenire estimată ' + ret : '')) : null,
    stats: hasStat ? stats : null,
    _injury: injured ? { detail: (m.injury && (m.injury.type || m.injury.title)) || null, since: null } : null,
  };
}
function parseSquadGroups(json) {
  const r = json && (json.response || json);
  const groups = (r && r.list && Array.isArray(r.list.squad)) ? r.list.squad
    : (r && Array.isArray(r.squad)) ? r.squad
    : (Array.isArray(r) ? r : null);
  if (!groups) return null;
  const players = [];
  let coachName = null;
  for (const g of groups) {
    const title = (g && (g.title || g.name)) || '';
    const members = (g && (g.members || g.players)) || (Array.isArray(g) ? g : []);
    for (const m of members) {
      if (isCoachEntry(title, m)) { if (!coachName) coachName = m.name || null; continue; }
      const p = mapSquadMember(m, title);
      if (p) players.push(p);
    }
  }
  if (!players.length) return null;
  return { players, coachName };
}

/* ---------- lineup mapping (mirrors match.js applyLiveLineup) ---------- */
function digPlayerList(j) {
  const cands = [j, j && j.response, j && j.response && j.response.lineup,
    j && j.response && j.response.starters, j && j.lineup, j && j.players];
  for (const c of cands) {
    if (Array.isArray(c) && c.length && (c[0].name || c[0].playerName)) return c;
    if (c && Array.isArray(c.starters)) return c.starters;
    if (c && Array.isArray(c.players)) return c.players;
  }
  return null;
}
function lineupFrom(json) {
  const list = digPlayerList(json);
  if (!list || !list.length) return null;
  const xi = list.slice(0, 11).map((p) => {
    const name = p.name || p.playerName || (p.player && p.player.name) || null;
    if (!name) return null;
    const posRaw = (p.position || p.pos || '').toString().toUpperCase();
    return { number: num(p.shirtNumber != null ? p.shirtNumber : p.number), name, pos: posRaw || 'n/d' };
  }).filter(Boolean);
  if (xi.length < 11) return null;
  const r = json && (json.response || json);
  const formation = (r && (r.formation || r.lineupFormation)) || null;
  return { xi, formation: formation ? String(formation) : 'n/d' };
}

/* ---------- referee / venue (mirrors match.js) ---------- */
function refereeFrom(json) {
  const r = json && (json.response || json);
  const name = r && (r.name || r.refereeName || (r.referee && r.referee.name));
  if (!name) return null;
  return {
    name,
    country: (r.country || r.nationality || null),
    age: num(r.age),
    apps: null, ycPerMatch: null, rcPerMatch: null, history: null,
  };
}
function venueFrom(json) {
  const r = json && (json.response || json);
  const name = r && (r.name || r.venueName || (r.venue && r.venue.name) || (r.stadium && r.stadium.name));
  if (!name) return null;
  return { name, capacity: num(r.capacity), city: (r.city || null), notes: null };
}

/* ---------- RSS news candidates (Google News) ----------
   Raw, dated headlines only — the match-data-json skill triages them into news[]
   and paraphrases into Romanian. No key, no library; Google News RSS is simple
   well-formed XML so a regex extract is enough. Best-effort: a failed feed just
   contributes nothing. */
const RSS_DAYS = 4;         // drop anything older than this
const NEWS_PER_TEAM = 8;

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
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
    // Google News appends " - <source>" to titles
    if (source && title.endsWith(' - ' + source)) title = title.slice(0, -(source.length + 3)).trim();
    if (!title) continue;
    items.push({ title, url: link.trim() || null, source, published: isoDay(pub) });
  }
  return items;
}
async function teamNews(teamName, oppName) {
  const cutoff = new Date(Date.now() - RSS_DAYS * 86400000).toISOString().slice(0, 10);
  const queries = [
    `"${teamName}" when:${RSS_DAYS}d`,
    `"${teamName}" "${oppName}" when:7d`,
  ];
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

/* ---------- soccer-football-info: h2h + league-table context ----------
   All results are cached in docs/data/teams/_sfi.json so repeat runs cost
   almost nothing. A per-run call budget guards the 200/day free tier. */
let _sfiCalls = 0;
async function sfi(path, params) {
  if (_sfiCalls >= SFI_CALL_BUDGET) { console.error('  sfi: call budget reached, skipping ' + path); return null; }
  const qs = Object.entries({ f: 'json', l: 'en_US', ...params })
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  _sfiCalls++;
  let r;
  try {
    r = await fetch(`${SFI_HOST}/${path}?${qs}`, { headers: SFI_HEADERS });
  } catch (e) { console.error(`  sfi ${path}: ${e.message}`); return null; }
  if (!r.ok) { console.error(`  sfi ${path}: HTTP ${r.status}`); return null; }
  let j;
  try { j = await r.json(); } catch { return null; }
  return (j && Array.isArray(j.result)) ? j.result : null;
}

async function sfiChampionshipId(comp, cc, cache) {
  cache.championships = cache.championships || {};
  if (comp in cache.championships) return cache.championships[comp];   // may be null (known miss)
  const spec = SFI_LEAGUE[comp];
  let found = null;
  if (spec) {
    for (let p = 1; p <= 5 && !found; p++) {
      const rows = await sfi('championships/list/', { c: cc, p });
      if (!rows || !rows.length) break;
      const hits = rows.filter((x) => x.name && spec.re.test(x.name) && !SFI_EXCLUDE.test(x.name));
      found = (hits.find((x) => x.important) || hits[0]) || null;
      if (rows.length < 25) break;
    }
  }
  cache.championships[comp] = found ? found.id : null;
  if (found) console.log(`  sfi league ${comp} -> ${found.name} [${found.id}]`);
  return cache.championships[comp];
}

async function sfiStandings(champId, cache) {
  cache.standings = cache.standings || {};
  const hit = cache.standings[champId];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < SFI_STANDINGS_TTL) return hit;
  const res = await sfi('championships/view/', { i: champId });
  const seasons = (res && res[0] && Array.isArray(res[0].seasons)) ? res[0].seasons.slice() : [];
  // newest first (they come oldest-first; sort by `to` to be safe), then take the
  // most recent season that actually has a populated table
  seasons.sort((x, y) => String(y.to || y.from || '').localeCompare(String(x.to || x.from || '')));
  let season = null, table = null;
  for (const s of seasons) {
    const tb = s && s.groups && s.groups[0] && s.groups[0].table;
    if (tb && tb.length && tb.some((r) => num(r.points) != null)) { season = s; table = tb; break; }
  }
  if (!table) return hit || null;
  const byName = {};
  for (const row of table) {
    const t = row.team || {};
    if (!t.name) continue;
    const played = (num(row.win) || 0) + (num(row.draw) || 0) + (num(row.loss) || 0);
    byName[norm(t.name)] = {
      id: t.id || null, name: t.name,
      position: num(row.position), points: num(row.points), played,
      win: num(row.win), draw: num(row.draw), loss: num(row.loss),
      gf: num(row.goals_scored), ga: num(row.goals_conceded),
    };
  }
  const rec = { fetchedAt: todayISO(), season: season.name || null, byName };
  cache.standings[champId] = rec;
  return rec;
}

function sfiFindTeam(standings, teamName) {
  if (!standings || !standings.byName) return null;
  const want = norm(teamName);
  if (!want) return null;
  if (standings.byName[want]) return standings.byName[want];
  // substring both ways, but pick the closest by length so "milan" prefers
  // "acmilan" over "intermilan"
  const cands = Object.keys(standings.byName)
    .filter((n) => n && (n.indexOf(want) >= 0 || want.indexOf(n) >= 0))
    .sort((a, b) => Math.abs(a.length - want.length) - Math.abs(b.length - want.length));
  return cands.length ? standings.byName[cands[0]] : null;
}

async function sfiH2H(a, b, nameA, nameB, cache) {
  cache.h2h = cache.h2h || {};
  const key = [a, b].sort().join('_');
  const hit = cache.h2h[key];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < SFI_H2H_TTL) return hit;
  const res = await sfi('teams/versus/', { x: a, y: b, w: 'all' });
  const v = res && res[0];
  if (!v || !Array.isArray(v.matches)) return hit || null;
  const xId = v.teamX && v.teamX.id;
  const skipComp = /friendl|amical|\btest\b|club friendlies|trophy|soccer aid/i;
  const recent = v.matches
    .filter((m) => {
      const cn = (m.championship && m.championship.name) || '';
      if (skipComp.test(cn)) return false;
      const sa = m.teamA && m.teamA.score, sb = m.teamB && m.teamB.score;
      return sa != null && sb != null;   // drop fixtures with no recorded score
    })
    .slice(0, 5)
    .map((m) => {
      const ta = m.teamA || {}, tb = m.teamB || {};
      return {
        date: (m.date || '').slice(0, 10),
        comp: (m.championship && m.championship.name) || null,
        score: `${ta.name} ${m.teamA.score}-${m.teamB.score} ${tb.name}`,
      };
    });
  const r = v.results || {};
  const xWins = xId === a ? r.teamX : r.teamY;
  const yWins = xId === a ? r.teamY : r.teamX;
  const summary = (r.teamX != null)
    ? `Cap la cap (toate competițiile): ${nameA} ${xWins ?? '?'} - ${r.draw ?? '?'} - ${yWins ?? '?'} ${nameB}.`
    : null;
  const rec = { fetchedAt: todayISO(), recent, summary };
  cache.h2h[key] = rec;
  return rec;
}

// A team's last matches, most recent first, from that team's perspective —
// this is the OneFootball-style "form guide" (competitive + friendlies).
const SFI_HISTORY_TTL = 2;
async function sfiHistory(teamId, teamName, cache) {
  cache.history = cache.history || {};
  const hit = cache.history[teamId];
  if (hit && hit.fetchedAt && daysBetween(todayISO(), hit.fetchedAt) < SFI_HISTORY_TTL) return hit;
  const res = await sfi('teams/history/', { i: teamId, w: '6m' });
  const matches = res && res[0] && Array.isArray(res[0].matches) ? res[0].matches : null;
  if (!matches) return hit || null;
  const want = norm(teamName);
  const recent = matches.slice(0, 6).map((m) => {
    const ta = m.teamA || {}, tb = m.teamB || {};
    const sa = num(ta.score), sb = num(tb.score);
    if (sa == null || sb == null) return null;
    const weAreA = norm(ta.name).indexOf(want) >= 0 || want.indexOf(norm(ta.name)) >= 0;
    const us = weAreA ? sa : sb, them = weAreA ? sb : sa;
    return {
      date: (m.date || '').slice(0, 10),
      opp: weAreA ? (tb.name || null) : (ta.name || null),
      homeAway: weAreA ? 'H' : 'A',
      comp: (m.championship && m.championship.name) || null,
      score: `${us}-${them}`,
      result: us > them ? 'W' : us < them ? 'L' : 'D',
    };
  }).filter(Boolean);
  const rec = { fetchedAt: todayISO(), recent };
  cache.history[teamId] = rec;
  return rec;
}

// Fill h2h + form (position/note/table/recent) on a partial pack from
// soccer-football-info. Only touches fields the primary feed left empty.
async function applySfi(doc, fx, cache) {
  const champId = await sfiChampionshipId(fx.comp, fx.country, cache);
  if (!champId) return;
  const standings = await sfiStandings(champId, cache);
  if (!standings) return;

  const sides = [['home', fx.home], ['away', fx.away]];
  const ids = {};
  for (const [side, name] of sides) {
    const row = sfiFindTeam(standings, name);
    if (!row) continue;
    ids[side] = row.id;
    const t = doc.teams[side];
    const f = t.form || { last5: [], ppg: null, homeAway: null, position: null, note: null };
    if (f.position == null && row.position != null) f.position = row.position;
    if (f.table == null && row.played != null) {
      f.table = {
        played: row.played, win: row.win, draw: row.draw, loss: row.loss,
        gf: row.gf, ga: row.ga, points: row.points,
      };
    }
    if (!has(f.note) && row.points != null && row.played) {
      f.note = `Clasament ${standings.season || 'sezon precedent'}: locul ${row.position}, ${row.points}p` +
        (row.gf != null ? ` (${row.gf}-${row.ga})` : '');
    }
    const hist = await sfiHistory(row.id, name, cache);
    if (hist && hist.recent.length && (!f.recent || !f.recent.length)) f.recent = hist.recent;
    t.form = f;
  }

  const noH2H = !doc.h2h || !doc.h2h.recent || !doc.h2h.recent.length;
  if (noH2H && ids.home && ids.away) {
    const h = await sfiH2H(ids.home, ids.away, fx.home, fx.away, cache);
    if (h && (h.recent.length || h.summary)) {
      doc.h2h = { recent: h.recent, summary: h.summary };
      if (!doc.sources.some((s) => s.url === SFI_SOURCE.url)) {
        doc.sources.push({ ...SFI_SOURCE, accessed: todayDate() });
      }
    }
  } else if ((doc.teams.home.form && doc.teams.home.form.position != null) ||
             (doc.teams.away.form && doc.teams.away.form.position != null)) {
    if (!doc.sources.some((s) => s.url === SFI_SOURCE.url)) {
      doc.sources.push({ ...SFI_SOURCE, accessed: todayDate() });
    }
  }
}

/* ---------- per-team squad cache ---------- */
async function getSquad(teamId, teamName) {
  const cachePath = `${TEAMS_DIR}/${teamId}.json`;
  const cached = readJSON(cachePath);
  if (cached && cached.fetchedAt && daysBetween(todayISO(), cached.fetchedAt) < SQUAD_TTL_DAYS) {
    return cached;
  }
  const json = await api('football-get-list-player', { teamid: teamId });
  const parsed = parseSquadGroups(json);
  if (!parsed) {
    if (cached) { console.log(`  team ${teamId}: feed empty, keeping cache from ${cached.fetchedAt}`); return cached; }
    console.log(`  team ${teamId}: no squad from feed`);
    return null;
  }
  const rec = {
    teamId,
    name: teamName || (cached && cached.name) || null,
    fetchedAt: todayISO(),
    source: SOURCE.url,
    coach: parsed.coachName ? { name: parsed.coachName } : null,
    squad: parsed.players,
  };
  writeJSON(cachePath, rec);
  console.log(`  team ${teamId} (${rec.name}): cached ${parsed.players.length} players`);
  return rec;
}

/* ---------- name -> team id fallback ---------- */
let _leagueTeams = new Map();
async function teamIdByName(leagueId, teamName) {
  if (leagueId == null) return null;
  if (!_leagueTeams.has(leagueId)) {
    const json = await api('football-get-list-all-team', { leagueid: leagueId });
    const r = json && (json.response || json);
    const list = (r && Array.isArray(r.list)) ? r.list : (Array.isArray(r) ? r : (Array.isArray(r && r.teams) ? r.teams : []));
    _leagueTeams.set(leagueId, list || []);
  }
  const want = norm(teamName);
  const hit = (_leagueTeams.get(leagueId) || []).find((t) => {
    const n = norm(t.name || t.teamName || t.shortName || '');
    return n && (n === want || n.indexOf(want) >= 0 || want.indexOf(n) >= 0);
  });
  return hit ? (hit.id != null ? hit.id : (hit.teamId != null ? hit.teamId : null)) : null;
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

async function buildMatch(fx) {
  const eventId = fx.eventId;
  const [homeSquad, awaySquad, refJson, venJson, homeLine, awayLine, homeNews, awayNews] = await Promise.all([
    fx._homeId != null ? getSquad(fx._homeId, fx.home) : Promise.resolve(null),
    fx._awayId != null ? getSquad(fx._awayId, fx.away) : Promise.resolve(null),
    eventId != null ? api('football-get-match-referee', { eventid: eventId }) : Promise.resolve(null),
    eventId != null ? api('football-get-match-location', { eventid: eventId }) : Promise.resolve(null),
    eventId != null ? api('football-get-hometeam-lineup', { eventid: eventId }) : Promise.resolve(null),
    eventId != null ? api('football-get-awayteam-lineup', { eventid: eventId }) : Promise.resolve(null),
    teamNews(fx.home, fx.away),
    teamNews(fx.away, fx.home),
  ]);

  const out = {
    slug: fx.slug,
    generatedAt: todayISO(),
    partial: true,
    sources: [{ ...SOURCE, accessed: todayDate() }],
    competition: { name: fx.comp, round: fx.round, country: fx.country || 'n/d' },
    kickoff: fx.kickoff || 'n/d',
    venue: venueFrom(venJson) || { name: has(fx.venue) ? fx.venue : 'n/d', capacity: null, city: null, notes: null },
    referee: refereeFrom(refJson) || { name: 'n/d', country: null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null },
    h2h: { recent: [], summary: null },
    storyOfTheMatch: [],
    teams: { home: emptyTeamBlock(fx.home), away: emptyTeamBlock(fx.away) },
  };

  const bySide = {
    home: { cache: homeSquad, line: homeLine, news: homeNews },
    away: { cache: awaySquad, line: awayLine, news: awayNews },
  };
  for (const side of ['home', 'away']) {
    const t = out.teams[side];
    const { cache, line, news } = bySide[side];
    if (cache && cache.squad && cache.squad.length) {
      t.squad = cache.squad.map(stripInternal);
      if (cache.coach && cache.coach.name) t.coach = { name: cache.coach.name };
      t.absences = cache.squad
        .filter((p) => p._injury)
        .map((p) => ({ name: p.name, reason: 'injury', detail: p._injury.detail || null, since: null }));
    }
    if (news && news.length) t.newsCandidates = news;
    const parsedLine = lineupFrom(line);
    if (parsedLine) {
      t.confirmedXI = parsedLine.xi;
      t.predictedXI = parsedLine.xi;
      if (has(parsedLine.formation)) t.formation = parsedLine.formation;
    }
  }
  return out;
}

// drop the _injury helper key before it goes into the schema-checked file
function stripInternal(p) {
  const { _injury, ...rest } = p;
  return rest;
}

/* ---------- main ---------- */
async function main() {
  const fixtures = readJSON(FIXTURES) || [];
  const from = todayDate();
  const to = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });

  const due = fixtures.filter((f) =>
    !f.ready && f.date && f.date !== 'n/d' && f.date >= from && f.date <= to && has(f.kickoff));

  if (!due.length) {
    console.log('No upcoming fixtures need a prefetch. Nothing to do.');
    return;
  }
  console.log(`${due.length} fixture(s) in the next ${DAYS_AHEAD} days:`);

  const partialSlugs = new Set(existingPartialSlugs());
  const sfiCache = readJSON(SFI_FILE) || {};

  for (const f of due) {
    const existing = readJSON(`${MATCHES_DIR}/${f.slug}.json`);
    if (existing && !existing.partial) {
      console.log(`- ${f.slug}: full pack already present, skipping`);
      partialSlugs.delete(f.slug);
      continue;
    }
    console.log(`- ${f.slug}:`);

    f._homeId = f.homeId != null ? f.homeId : await teamIdByName(f.leagueId, f.home);
    f._awayId = f.awayId != null ? f.awayId : await teamIdByName(f.leagueId, f.away);

    let doc;
    try {
      doc = await buildMatch(f);
    } catch (e) {
      console.error(`  build failed: ${e.message}`);
      continue;
    }
    const gotSquad = doc.teams.home.squad.length || doc.teams.away.squad.length;
    if (!gotSquad && !existing) {
      console.log('  nothing usable from the feed and no file yet — skipping');
      continue;
    }
    try {
      await applySfi(doc, f, sfiCache);
    } catch (e) {
      console.error(`  sfi enrich failed: ${e.message}`);
    }
    writeJSON(`${MATCHES_DIR}/${f.slug}.json`, doc);
    partialSlugs.add(f.slug);
    console.log(`  wrote docs/data/matches/${f.slug}.json (partial${doc.h2h.recent.length ? ', +h2h' : ''})`);
  }

  writeJSON(SFI_FILE, sfiCache);
  writeJSON(PREVIEWS, [...partialSlugs].sort());
  console.log(`previews.json: ${partialSlugs.size} partial pack(s); soccer-football-info calls: ${_sfiCalls}`);
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
