// Refreshes docs/data/fixtures.json from API-Football (api-sports.io v3).
// Plain deterministic script — no AI involved, so no hallucination risk and
// no AI-token cost. Run daily by .github/workflows/refresh-fixtures.yml.
//
// One call per tracked competition: GET /fixtures?league=&season=&from=&to=
// over a rolling window. Entries carry the API-Football fixture id (`eventId`),
// league id (`leagueId`) and team ids (`homeId` / `awayId`) — the same ids the
// prefetch step and the match-data skill use.
//
// A fixture stays in the list for the whole of its own calendar day
// (Europe/Bucharest) no matter its status -- live, finished, whatever --
// and only drops out starting the following day, when its docs/data/
// matches/<slug>.json (+ .i18n.json sidecar) is also deleted in the cleanup
// pass at the end of main(). Per the user (2026-09-20, refined same day
// after an initial status-based cut dropped matches still being played):
// "remove only from the day before backwards, never on the match's own
// day" -- this tool only serves a pre-match live-commentary screen, so a
// match from a previous day has no further use here, but today's match
// must stay visible/usable all day regardless of kickoff having passed.
//
// Requires Node 18+ (global fetch) and env var APIFOOTBALL_KEY.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from 'node:fs';
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
  { id: 137, comp: 'Coppa Italia', abbr: 'coppa', country: 'IT' },
  { id: 78,  comp: 'Bundesliga', abbr: 'bundesliga', country: 'DE' },
  { id: 79,  comp: '2. Bundesliga', abbr: 'bl2', country: 'DE' },
  { id: 283, comp: 'Superliga', abbr: 'sl', country: 'RO' },
  { id: 284, comp: 'Liga 2', abbr: 'ro2', country: 'RO' },
];
const DAYS_AHEAD = 21; // rolling scan window
const DEAD_STATUS = new Set(['CANC', 'ABD', 'AWD', 'WO']); // no match day worth showing at all

const OUT_FILE = fileURLToPath(new URL('../docs/data/fixtures.json', import.meta.url));
const MATCHES_DIR = fileURLToPath(new URL('../docs/data/matches', import.meta.url));
const PREVIEWS_FILE = fileURLToPath(new URL('../docs/data/previews.json', import.meta.url));

// API-Football "season" is the calendar year the season starts in. For a
// European season that runs Aug->May, that is the current year from July on,
// and the previous year for the Jan->June stretch.
function currentSeason(d = new Date()) {
  const y = d.getFullYear();
  return d.getMonth() >= 6 ? y : y - 1;
}

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
  // Check named cup rounds BEFORE the generic trailing-number fallback --
  // "Round of 32"/"Round of 16" end in a digit too, so the fallback used to
  // fire first and mislabel a Coppa Italia round of 32 as "Etapa 32" (looks
  // like league matchday 32, not a cup round). Named stages take priority;
  // only a genuine "Regular Season - N" style round falls through to that.
  const k = raw.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = {
    final: 'Finala', 'semi finals': 'Semifinale', 'semi final': 'Semifinale',
    'quarter finals': 'Sferturi de finala', 'quarter final': 'Sferturi de finala',
    'round of 16': 'Optimi de finala', 'round of 32': 'Saisprezecimi',
    'round of 36': 'Turul 3', 'round of 64': 'Turul 2', 'round of 128': 'Turul 1',
    'group stage': 'Faza grupelor', 'play offs': 'Baraj', 'play off': 'Baraj',
    'relegation round': 'Play-out', 'championship round': 'Play-off',
  };
  if (exact[k]) return exact[k];
  const tail = raw.match(/(\d+)\s*$/);
  if (tail) return 'Etapa ' + tail[1];
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
// venue / ready / researchDepth from an existing entry for the same pairing
// when present.
function toEntry(c, f, byMatch) {
  const iso = f.fixture.date;                 // already Europe/Bucharest offset
  const date = iso.slice(0, 10);
  const ko = iso.slice(11, 16);
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const round = roundLabel(f.league.round);
  const n = roundNumber(round);
  const existing = byMatch.get(home + '|' + away);
  const entry = {
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
    // Already present on this same fixture response (f.teams.*.logo,
    // f.league.logo) -- zero extra API calls. index.html reads these
    // straight from here for the fixture list crests.
    homeLogo: f.teams.home.logo || (existing && existing.homeLogo) || null,
    awayLogo: f.teams.away.logo || (existing && existing.awayLogo) || null,
    compLogo: (f.league && f.league.logo) || (existing && existing.compLogo) || null,
    ready: existing ? !!existing.ready : false,
  };
  // researchDepth is set by the build-match-data workflows once a pack is
  // built (docs.index.html reads it from here, not from the match file, to
  // show the "PACHET PREMIUM" tag without an extra fetch) -- it was being
  // silently dropped on every daily refresh because this function rebuilds
  // each entry from the live API response and never carried it over, so a
  // deep pack's premium tag vanished the next time fixtures.json refreshed
  // (reported 2026-09-14, right after a batch of manual deep builds).
  if (existing && existing.researchDepth) entry.researchDepth = existing.researchDepth;
  return entry;
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

    // Status doesn't matter here -- a fixture stays in `upcoming` for the
    // whole of its own calendar day regardless of being live or finished,
    // and only ages out starting the next day, when the `from` window below
    // no longer includes it (see the header comment). Status is still worth
    // filtering on the truly dead ones (cancelled/abandoned/walkover), which
    // have no match day worth showing at all.
    const upcoming = fixtures
      .filter((f) => f.fixture.date.slice(0, 10) >= from && !DEAD_STATUS.has(f.fixture.status && f.fixture.status.short))
      .map((f) => toEntry(c, f, byMatch))
      .sort((a, b) => (a.date + a.ko).localeCompare(b.date + b.ko));

    if (!upcoming.length) {
      console.log(`${c.comp}: no fixtures in the next ${DAYS_AHEAD} days — keeping ${current.length} existing.`);
      out.push(...current);
      continue;
    }
    console.log(`${c.comp}: ${upcoming.length} upcoming`);
    out.push(...upcoming);
  }

  cleanupPlayedMatches(out);

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

// Deletes docs/data/matches/<slug>.json (+ .i18n.json sidecar) for any slug
// that no longer has a fixtures.json entry -- a played match, or one whose
// fixture disappeared from the API entirely. Also prunes previews.json (the
// "DATE PARȚIALE" banner list) of the same stale slugs, since it's a plain
// array of slugs with no other validation. Run unconditionally, even if
// fixtures.json itself didn't change, so this stays self-healing.
function cleanupPlayedMatches(fixtures) {
  const liveSlugs = new Set(fixtures.map((f) => f.slug));
  let files;
  try { files = readdirSync(MATCHES_DIR); } catch { return; }
  let removed = 0;
  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const slug = file.replace(/\.i18n\.json$|\.json$/, '');
    if (liveSlugs.has(slug)) continue;
    unlinkSync(`${MATCHES_DIR}/${file}`);
    removed++;
  }
  if (removed) console.log(`Cleanup: removed ${removed} match file(s) for played/gone fixtures.`);

  if (existsSync(PREVIEWS_FILE)) {
    let previews;
    try { previews = JSON.parse(readFileSync(PREVIEWS_FILE, 'utf8')); } catch { previews = null; }
    if (Array.isArray(previews)) {
      const kept = previews.filter((slug) => liveSlugs.has(slug));
      if (kept.length !== previews.length) {
        writeFileSync(PREVIEWS_FILE, JSON.stringify(kept, null, 2) + '\n');
        console.log(`Cleanup: pruned ${previews.length - kept.length} stale slug(s) from previews.json.`);
      }
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
