// Refreshes docs/data/fixtures.json from the RapidAPI football feed.
// Plain deterministic script — no AI involved, so no hallucination risk and
// no API-token cost. Run daily by .github/workflows/refresh-fixtures.yml.
//
// For each tracked competition, if every currently-listed match has already
// been played, this fetches the next upcoming round and replaces that
// competition's block. If the current round still has matches in the future,
// that competition is left untouched this run — we never overwrite a round
// while its match-data JSON might still be getting built.
//
// Ported from radumpandea/comentarii/scripts/refresh-fixtures.mjs; the only
// real change is the output target (a JSON array here, not a window.PM_PACHETE
// assignment) and the per-entry shape.
//
// Requires Node 18+ (global fetch) and env var RAPIDAPI_KEY.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

// Tracked competitions: RapidAPI leagueId -> label + file-slug prefix.
const COMPS = [
  { id: 47, comp: 'Premier League', abbr: 'pl', country: 'GB' },
  { id: 53, comp: 'Ligue 1', abbr: 'l1', country: 'FR' },
  { id: 87, comp: 'LaLiga', abbr: 'laliga', country: 'ES' },
  { id: 55, comp: 'Serie A', abbr: 'seriea', country: 'IT' },
  { id: 54, comp: 'Bundesliga', abbr: 'bundesliga', country: 'DE' },
  { id: 189, comp: 'Superliga', abbr: 'sl', country: 'RO' },
];
const DAYS_AHEAD = 21; // scan window when a competition's round has finished

const LEAGUE_ID_BY_COMP = COMPS.reduce((o, c) => (o[c.comp] = c.id, o), {});

const OUT_FILE = fileURLToPath(new URL('../docs/data/fixtures.json', import.meta.url));

function slugify(s) {
  return s
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '');
}

function roundLabel(stage) {
  if (stage == null || stage === '') return 'n/d';
  const raw = String(stage).trim();
  if (/^\d+$/.test(raw)) return 'Etapa ' + raw;
  const k = raw.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = {
    final: 'Finala', 'semi final': 'Semifinale', 'semi finals': 'Semifinale',
    'quarter final': 'Sferturi de finala', 'quarter finals': 'Sferturi de finala',
    'round of 16': 'Optimi de finala', 'round of 32': 'Saisprezecimi',
    'group stage': 'Faza grupelor', 'play off': 'Baraj', playoffs: 'Baraj',
    qualification: 'Preliminarii', qualifying: 'Preliminarii',
  };
  if (exact[k]) return exact[k];
  const m = k.match(/^(?:round|matchday|round no) (\d+)$/);
  if (m) return 'Etapa ' + m[1];
  return raw || 'n/d';
}

function roundNumber(et) {
  const m = /Etapa (\d+)/.exec(et || '');
  return m ? m[1] : slugify(et || 'runda');
}

function key(d) {
  const p = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate());
}

function localDate(utc) {
  return new Date(utc).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
}
function localTime(utc) {
  return new Date(utc).toLocaleTimeString('ro-RO', {
    hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Bucharest', hour12: false,
  });
}
// ISO 8601 with the Europe/Bucharest offset, e.g. 2026-09-04T20:00:00+03:00
function localIso(utc) {
  if (!utc) return 'n/d';
  const d = new Date(utc);
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Bucharest', hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(d).reduce((o, p) => (o[p.type] = p.value, o), {});
  // offset: difference between the wall-clock reading in Bucharest and UTC
  const asUTC = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  const offMin = Math.round((asUTC - d.getTime()) / 60000);
  const sign = offMin >= 0 ? '+' : '-';
  const oh = String(Math.floor(Math.abs(offMin) / 60)).padStart(2, '0');
  const om = String(Math.abs(offMin) % 60).padStart(2, '0');
  const hh = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hh}:${parts.minute}:${parts.second}${sign}${oh}:${om}`;
}

async function fetchDay(d) {
  const url = `${HOST}/football-get-matches-by-date?date=${key(d)}`;
  const r = await fetch(url, { headers: HEADERS });
  if (!r.ok) throw new Error(`API ${r.status} for ${key(d)}`);
  const j = await r.json();
  if (j.status !== 'success') throw new Error(j.message || 'API returned non-success');
  return j.response.matches || [];
}

function loadManifest(fileUrl) {
  try {
    return JSON.parse(readFileSync(fileUrl, 'utf8'));
  } catch {
    return [];
  }
}

function makeSlug(abbr, roundN, home, away) {
  return `${abbr}-e${roundN}-${slugify(home)}-${slugify(away)}`;
}

// Fills in `eventId` / `leagueId` / `homeId` / `awayId` (the football feed's
// per-match and per-team ids, used by match.html for client-side live lookups —
// lineups, referee, venue, and now full squads with per-player season stats) on
// entries that don't have them yet. Freshly-scanned entries get these inline, so
// this backfills the ones carried over as-is by re-fetching each distinct date
// and matching on team names.
async function backfillEventIds(entries) {
  const missing = entries.filter((e) =>
    (e.eventId == null || e.homeId == null || e.awayId == null || e.leagueId == null) &&
    e.date && e.date !== 'n/d');
  // leagueId needs no network call — derive it from the competition name.
  entries.forEach((e) => { if (e.leagueId == null && LEAGUE_ID_BY_COMP[e.comp] != null) e.leagueId = LEAGUE_ID_BY_COMP[e.comp]; });
  if (!missing.length) return;
  const byDate = new Map();
  missing.forEach((e) => {
    if (!byDate.has(e.date)) byDate.set(e.date, []);
    byDate.get(e.date).push(e);
  });
  for (const [dateStr, list] of byDate) {
    let matches;
    try {
      matches = await fetchDay(new Date(dateStr + 'T00:00:00'));
    } catch (e) {
      console.error(`Backfill ids skip ${dateStr}: ${e.message}`);
      continue;
    }
    list.forEach((e) => {
      const m = matches.find((x) => x.home && x.away && x.home.name === e.home && x.away.name === e.away);
      if (!m) return;
      if (e.eventId == null) e.eventId = m.id != null ? m.id : (m.eventId != null ? m.eventId : null);
      if (e.homeId == null) e.homeId = (m.home && m.home.id != null) ? m.home.id : null;
      if (e.awayId == null) e.awayId = (m.away && m.away.id != null) ? m.away.id : null;
      if (e.leagueId == null) e.leagueId = m.leagueId != null ? m.leagueId : (LEAGUE_ID_BY_COMP[e.comp] ?? null);
    });
  }
}

function mode(values) {
  const counts = {};
  let best = null, bestN = 0;
  values.forEach((v) => {
    if (v == null) return;
    counts[v] = (counts[v] || 0) + 1;
    if (counts[v] > bestN) { bestN = counts[v]; best = v; }
  });
  return best;
}

// A competition's "current round" is normally left untouched once it has any
// future match (see main()) so we never overwrite packs mid-build. But if the
// manifest was ever seeded or refreshed with only part of that round (as
// happened once: 3 of 9 Ligue 1 fixtures got tracked, the rest silently never
// appeared), it would otherwise stay incomplete forever. This re-scans the
// exact date span the current entries already cover and adds any same-round
// match for this competition that isn't listed yet — it never removes or
// reorders anything already there.
async function mergeRoundMatches(c, current, venueByTeam) {
  const dates = current.map((e) => e.date).filter((d) => d && d !== 'n/d').sort();
  if (!dates.length) return current;
  const dominantRound = mode(current.map((e) => e.round));
  const known = new Set(current.map((e) => e.home + '|' + e.away));
  const out = current.slice();
  const start = new Date(dates[0] + 'T00:00:00');
  const end = new Date(dates[dates.length - 1] + 'T00:00:00');
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
    let matches;
    try {
      matches = await fetchDay(d);
    } catch (e) {
      console.error(`Round-merge skip ${key(d)}: ${e.message}`);
      continue;
    }
    matches
      .filter((m) => m.leagueId === c.id)
      .forEach((m) => {
        const home = m.home.name, away = m.away.name;
        if (known.has(home + '|' + away)) return;
        const round = roundLabel(m.tournamentStage);
        if (dominantRound && round !== dominantRound) return; // a different round — not this one
        known.add(home + '|' + away);
        const date = m.status && m.status.utcTime ? localDate(m.status.utcTime) : 'n/d';
        const ko = m.status && m.status.utcTime ? localTime(m.status.utcTime) : 'n/d';
        const kickoff = m.status && m.status.utcTime ? localIso(m.status.utcTime) : 'n/d';
        console.log(`Round-merge: adding missing ${c.comp} fixture ${home} vs ${away} (${date})`);
        out.push({
          slug: makeSlug(c.abbr, roundNumber(round), home, away),
          comp: c.comp, country: c.country, round, date, ko, kickoff, home, away,
          venue: venueByTeam[home] || 'n/d',
          eventId: m.id != null ? m.id : (m.eventId != null ? m.eventId : null),
          leagueId: c.id,
          homeId: (m.home && m.home.id != null) ? m.home.id : null,
          awayId: (m.away && m.away.id != null) ? m.away.id : null,
          ready: false,
        });
      });
  }
  return out.sort((a, b) => (a.date + a.ko).localeCompare(b.date + b.ko));
}

async function main() {
  const manifest = loadManifest(OUT_FILE);
  const today = new Date();
  const todayDate = localDate(today.toISOString());

  // Venue lookup seeded from whatever the manifest already knows per team.
  const venueByTeam = {};
  manifest.forEach((e) => {
    if (e.venue && e.venue !== 'n/d') venueByTeam[e.home] = e.venue;
  });

  const out = [];
  for (const c of COMPS) {
    const current = manifest.filter((e) => e.comp === c.comp);
    const stillUpcoming = current.some((e) => e.date >= todayDate);
    if (current.length && stillUpcoming) {
      // Current round isn't finished yet — leave it alone otherwise, but still
      // backfill missing eventIds and pick up any same-round match that isn't
      // tracked yet (see mergeRoundMatches).
      await backfillEventIds(current);
      out.push(...(await mergeRoundMatches(c, current, venueByTeam)));
      continue;
    }

    // Scan forward for this competition's next round.
    let found = [];
    let windowStart = null;
    for (let i = 0; i < DAYS_AHEAD; i++) {
      const d = new Date(today.getFullYear(), today.getMonth(), today.getDate() + i);
      let matches;
      try {
        matches = await fetchDay(d);
      } catch (e) {
        console.error(`Skipping ${key(d)}: ${e.message}`);
        continue;
      }
      const mine = matches.filter((m) => m.leagueId === c.id && !(m.status && m.status.finished));
      if (mine.length) {
        if (windowStart === null) windowStart = i;
        if (i <= windowStart + 3) found.push(...mine);
        else break;
      } else if (windowStart !== null && i > windowStart + 3) {
        break;
      }
    }

    if (!found.length) {
      console.log(`No upcoming ${c.comp} fixtures found in the next ${DAYS_AHEAD} days — leaving as-is.`);
      await backfillEventIds(current);
      out.push(...current);
      continue;
    }

    const byMatch = new Map(current.map((e) => [e.home + '|' + e.away + '|' + e.date, e]));
    const et0 = roundLabel(found[0].tournamentStage);
    const n = roundNumber(et0);
    const entries = found.map((m) => {
      const date = m.status && m.status.utcTime ? localDate(m.status.utcTime) : 'n/d';
      const ko = m.status && m.status.utcTime ? localTime(m.status.utcTime) : 'n/d';
      const kickoff = m.status && m.status.utcTime ? localIso(m.status.utcTime) : 'n/d';
      const home = m.home.name, away = m.away.name;
      const round = roundLabel(m.tournamentStage);
      const existing = byMatch.get(home + '|' + away + '|' + date);
      return {
        slug: existing ? existing.slug : makeSlug(c.abbr, n, home, away),
        comp: c.comp,
        country: c.country,
        round,
        date,
        ko,
        kickoff,
        home,
        away,
        venue: venueByTeam[home] || (existing ? existing.venue : 'n/d'),
        eventId: m.id ?? m.eventId ?? (existing && existing.eventId) ?? null,
        leagueId: c.id,
        homeId: (m.home && m.home.id != null) ? m.home.id : ((existing && existing.homeId) ?? null),
        awayId: (m.away && m.away.id != null) ? m.away.id : ((existing && existing.awayId) ?? null),
        ready: existing ? !!existing.ready : false,
      };
    });

    // A match already marked ready has a published pack (and a live screen
    // linked from it) — never let a fresh round scan silently drop it just
    // because the feed no longer lists it as upcoming (it's finished by now).
    const haveMatch = new Set(entries.map((e) => e.home + '|' + e.away));
    const keepPublished = current.filter((e) => e.ready && !haveMatch.has(e.home + '|' + e.away));
    const merged = entries.concat(keepPublished).sort((a, b) => (a.date + a.ko).localeCompare(b.date + b.ko));

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
