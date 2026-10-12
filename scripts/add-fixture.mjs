// Adds ONE fixture to docs/data/fixtures.json by hand, from API-Football, for a
// competition that is not in refresh-fixtures.mjs's COMPS (a one-off, e.g. an AFC
// Champions League tie). The entry is flagged `manual: true`, which
// refresh-fixtures.mjs preserves until the match day is over, so the daily refresh
// does not drop it the way it drops everything outside COMPS. After it is added,
// the normal pipeline takes over: prefetch builds the partial pack (it only needs
// eventId / homeId / awayId / leagueId from this entry) and a deep build makes it
// premium.
//
//   DATE=2026-10-13 HOME_TEAM="ittihad" AWAY_TEAM="ahli" [LEAGUE=17] node scripts/add-fixture.mjs
//
// HOME_TEAM / AWAY_TEAM are case- and accent-insensitive substrings of the team
// names. Requires Node 18+ and APIFOOTBALL_KEY.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const API_KEY = process.env.APIFOOTBALL_KEY;
const DATE = (process.env.DATE || '').trim();
const HOME = (process.env.HOME_TEAM || '').trim();
const AWAY = (process.env.AWAY_TEAM || '').trim();
const LEAGUE = (process.env.LEAGUE || '').trim();
const OUT_FILE = fileURLToPath(new URL('../docs/data/fixtures.json', import.meta.url));

if (!API_KEY) { console.error('Missing APIFOOTBALL_KEY.'); process.exit(1); }
if (!/^\d{4}-\d{2}-\d{2}$/.test(DATE) || !HOME || !AWAY) {
  console.error('Need DATE=YYYY-MM-DD, HOME_TEAM and AWAY_TEAM (substrings of the team names).');
  process.exit(1);
}

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = (s) => strip(s).replace(/[^a-z0-9]+/g, '');
const slugify = (s) => strip(s).replace(/[^a-z0-9]+/g, '-').replace(/(^-+|-+$)/g, '');

function roundLabel(round) {
  if (round == null || round === '') return 'n/d';
  const raw = String(round).trim();
  const k = raw.toLowerCase().replace(/[-_/]+/g, ' ').replace(/\s+/g, ' ').trim();
  const exact = {
    final: 'Finala', 'semi finals': 'Semifinale', 'quarter finals': 'Sferturi de finala',
    'round of 16': 'Optimi de finala', 'round of 32': 'Saisprezecimi', 'group stage': 'Faza grupelor',
    'play offs': 'Baraj', 'play off': 'Baraj',
  };
  if (exact[k]) return exact[k];
  const tail = raw.match(/(\d+)\s*$/);
  return tail ? 'Etapa ' + tail[1] : raw;
}

async function main() {
  const qs = new URLSearchParams({ date: DATE, timezone: 'Europe/Bucharest' });
  if (LEAGUE) qs.set('league', LEAGUE);
  const res = await fetch(`https://v3.football.api-sports.io/fixtures?${qs}`, { headers: { 'x-apisports-key': API_KEY } });
  if (!res.ok) throw new Error(`API HTTP ${res.status}`);
  const j = await res.json();
  const errs = j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) throw new Error(`API errors: ${JSON.stringify(errs)}`);
  const rows = j.response || [];
  console.log(`${rows.length} fixtures on ${DATE}${LEAGUE ? ` in league ${LEAGUE}` : ''}.`);

  const h = norm(HOME), a = norm(AWAY);
  const match = rows.filter((f) => norm(f.teams.home.name).includes(h) && norm(f.teams.away.name).includes(a));
  const swapped = rows.filter((f) => norm(f.teams.home.name).includes(a) && norm(f.teams.away.name).includes(h));
  const hits = match.length ? match : swapped;
  if (hits.length !== 1) {
    console.error(hits.length ? 'More than one fixture matches:' : 'No fixture matches. Fixtures with either name:');
    const show = hits.length ? hits : rows.filter((f) => [f.teams.home.name, f.teams.away.name].some((n) => norm(n).includes(h) || norm(n).includes(a)));
    show.forEach((f) => console.error(`  ${f.fixture.id}  ${f.league.name}  ${f.teams.home.name} - ${f.teams.away.name}  ${f.fixture.date}`));
    process.exit(1);
  }
  const f = hits[0];
  const iso = f.fixture.date;
  const home = f.teams.home.name;
  const away = f.teams.away.name;
  const entry = {
    slug: `x-${DATE.replace(/-/g, '')}-${slugify(home)}-${slugify(away)}`,
    comp: f.league.name,
    country: 'WORLD',
    round: roundLabel(f.league.round),
    date: iso.slice(0, 10),
    ko: iso.slice(11, 16),
    kickoff: iso,
    home,
    away,
    venue: (f.fixture.venue && f.fixture.venue.name) || 'n/d',
    eventId: f.fixture.id,
    leagueId: f.league.id,
    homeId: f.teams.home.id ?? null,
    awayId: f.teams.away.id ?? null,
    homeLogo: f.teams.home.logo || null,
    awayLogo: f.teams.away.logo || null,
    compLogo: (f.league && f.league.logo) || null,
    ready: false,
    manual: true,
  };

  const manifest = JSON.parse(readFileSync(OUT_FILE, 'utf8'));
  const i = manifest.findIndex((e) => e.eventId === entry.eventId || e.slug === entry.slug);
  if (i >= 0) manifest[i] = { ...manifest[i], ...entry, ready: manifest[i].ready, researchDepth: manifest[i].researchDepth };
  else manifest.push(entry);
  writeFileSync(OUT_FILE, JSON.stringify(manifest, null, 2) + '\n');
  console.log(`${i >= 0 ? 'Updated' : 'Added'} ${entry.slug}: ${entry.comp} (league ${entry.leagueId}), ${home} - ${away}, ${entry.date} ${entry.ko}.`);
}

main().catch((e) => { console.error(e); process.exit(1); });
