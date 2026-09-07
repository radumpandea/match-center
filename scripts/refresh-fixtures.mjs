// Refreshes docs/data/fixtures.json from API-Football (api-sports.io v3).
// Plain deterministic script — no AI involved, so no hallucination risk and
// no AI-token cost. Run daily by .github/workflows/refresh-fixtures.yml.
//
// One call per tracked competition: GET /fixtures?league=&season=&from=&to=
// over a rolling window. Entries carry the API-Football fixture id (`eventId`),
// league id (`leagueId`) and team ids (`homeId` / `awayId`) — the same ids the
// prefetch step and the match-data skill use. A fixture already marked `ready`
// (its pack is published) is never dropped just because it has been played.
//
// Requires Node 18+ (global fetch) and env var APIFOOTBALL_KEY.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
if (!API_KEY) {
  console.error('Missing APIFOOTBALL_KEY env var.');
  process.exit(1);
}
const HEADERS = { 'x-apisports-key': API_KEY };

// Tracked competitions: API-Football league id -> label + file-slug prefix.
// These ids are stable season to season (unlike the previous feed, which used
// per-season ids for the Romanian leagues).
const COMPS = [
  { id: 39,  comp: 'Premier League', abbr: 'pl', country: 'GB' },
  { id: 61,  comp: 'Ligue 1', abbr: 'l1', country: 'FR' },
  { id: 140, comp: 'LaLiga', abbr: 'laliga', country: 'ES' },
  { id: 135, comp: 'Serie A', abbr: 'seriea', country: 'IT' },
  { id: 78,  comp: 'Bundesliga', abbr: 'bundesliga', country: 'DE' },
  { id: 79,  comp: '2. Bundesliga', abbr: 'bl2', country: 'DE' },
  { id: 283, comp: 'Superliga', abbr: 'sl', country: 'RO' },
  { id: 284, comp: 'Liga 2', abbr: 'ro2', country: 'RO' },
];
const DAYS_AHEAD = 21; // rolling scan window

const OUT_FILE = fileURLToPath(new URL('../docs/data/fixtures.json', import.meta.url));

// API-Football "season" is the calendar year the season starts in. For a
// European season that runs Aug->May, that is the current year from July on,
// and the previous year for the Jan->June stretch.
function currentSeason(d = new Date()) {
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? y : y - 1;
}

// Statuses that mean "this fixture has not produced a final result yet".
const OPEN_STATUS = new Set(['TBD', 'NS', 'PST', 'SUSP', 'INT', 'LIVE', '1H', '2H', 'HT', 'ET', 'BT', 'P']);

function slugify(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

// API-Football `league.round` is free text: "Regular Season - 4",
// "Group Stage - 2", "Quarter-finals", "1st Round", ...
function roundLabel(round) {
  if (round == null || round === '') return 'n/d';
  const raw = String(round).trim();
  const tail = raw.match(/(\d+)\s*$/);
  if (tail) return 'Etapa ' + tail[1];
  const k = raw.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = {
    final: 'Finala', 'semi finals': 'Semifinale', 'semi final': 'Semifinale',
    'quarter finals': 'Sferturi de finala', 'quarter final': 'Sferturi de finala',
    'round of 16': 'Optimi de finala', 'round of 32': 'Saisprezecimi',
    'group stage': 'Faza grupelor', 'play offs': 'Baraj', 'play off': 'Baraj',
    'relegation round': 'Play-out', 'championship round': 'Play-off',
  };
  if (exact[k]) return exact[k];
  return raw;
}

function roundNumber(et) {
  const m = /Etapa (\d+)/.exec(et || '');
  return m ? m[1] : slugify(et || 'runda');
}

function makeSlug(abbr, roundN, home, away) {
  return `${abbr}-e${roundN}-${slugify(home)}-${slugify(away)}`;
}

function loadManifest(fileUrl) {
  try {
    return JSON.parse(readFileSync(fileUrl, 'utf8'));
  } catch {
    return [];
  }
}

async function apiFixtures(leagueId, season, from, to) {
  const url = `${HOST}/fixtures?league=${leagueId}&season=${season}` +
    `&from=${from}&to=${to}&timezone=Europe%2FBucharest`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`API ${r.status} for league ${leagueId}`);
  const j = await r.json();
  if (Array.isArray(j.errors) ? j.errors.length : Object.keys(j.errors || {}).length) {
    throw new Error(`API errors for league ${leagueId}: ${JSON.stringify(j.errors)}`);
  }
  return j.response || [];
}

// One API-Football fixture object -> our manifest entry, preserving slug /
// venue / ready from an existing entry for the same pairing when present.
function toEntry(c, f, byMatch) {
  const iso = f.fixture.date;                 // already Europe/Bucharest offset
  const date = iso.slice(0, 10);
  const ko = iso.slice(11, 16);
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const round = roundLabel(f.league.round);
  const n = roundNumber(round);
  const existing = byMatch.get(home + '|' + away);
  return {
    slug: existing ? existing.slug : makeSlug(c.abbr, n, home, away),
    comp: c.comp,
    country: c.country,
    round,
    date,
    ko,
    kickoff: iso,
    home,
    away,
    venue: (f.fixture.venue && f.fixture.venue.name) || (existing && existing.venue) || 'n/d',
    eventId: f.fixture.id,
    leagueId: c.id,
    homeId: f.teams.home.id ?? (existing && existing.homeId) ?? null,
    awayId: f.teams.away.id ?? (existing && existing.awayId) ?? null,
    ready: existing ? !!existing.ready : false,
  };
}

async function main() {
  const manifest = loadManifest(OUT_FILE);
  const season = currentSeason();
  const now = new Date();
  const from = now.toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const to = new Date(now.getTime() + DAYS_AHEAD * 86400000)
    .toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });

  const out = [];
  for (const c of COMPS) {
    const current = manifest.filter((e) => e.comp === c.comp);
    const byMatch = new Map(current.map((e) => [e.home + '|' + e.away, e]));

    let fixtures;
    try {
      fixtures = await apiFixtures(c.id, season, from, to);
    } catch (e) {
      console.error(`${c.comp}: ${e.message} — keeping existing entries.`);
      out.push(...current);
      continue;
    }

    const upcoming = fixtures
      .filter((f) => OPEN_STATUS.has(f.fixture.status && f.fixture.status.short))
      .map((f) => toEntry(c, f, byMatch));

    // Never silently drop a published pack whose match has now been played and
    // so no longer appears in the upcoming window.
    const havePair = new Set(upcoming.map((e) => e.home + '|' + e.away));
    const keepPublished = current.filter((e) => e.ready && !havePair.has(e.home + '|' + e.away));

    const merged = upcoming.concat(keepPublished)
      .sort((a, b) => (a.date + a.ko).localeCompare(b.date + b.ko));

    if (!merged.length) {
      console.log(`${c.comp}: no fixtures in the next ${DAYS_AHEAD} days — keeping ${current.length} existing.`);
      out.push(...current);
      continue;
    }
    console.log(`${c.comp}: ${upcoming.length} upcoming` +
      (keepPublished.length ? ` (+${keepPublished.length} published kept)` : ''));
    out.push(...merged);
  }

  const rendered = JSON.stringify(out, null, 2) + '\n';
  let before = '';
  try { before = readFileSync(OUT_FILE, 'utf8'); } catch {}
  if (rendered.trim() === before.trim()) {
    console.log('No changes.');
    return;
  }
  mkdirSync(dirname(OUT_FILE), { recursive: true });
  writeFileSync(OUT_FILE, rendered);
  console.log(`Wrote ${out.length} fixtures to docs/data/fixtures.json`);
}

main().catch((e) => { console.error(e); process.exit(1); });
