#!/usr/bin/env node
// Experiment: build a Level-1 ("partial": true) match pack for one fixture from
// Sportmonks instead of API-Football, to compare what each provider gives.
// It does not touch fixtures.json or the real pipeline; it only writes the file
// it is told to.
//
//   SPORTMONKS_TOKEN=... node scripts/sportmonks-probe.mjs <fixtureId> <slug> <out.json> [roundLabel]
//
// Free plan = 2 leagues (Danish Superliga, Scottish Premiership) with full data
// except the paid add-ons (xG, expected lineups, predictions, pressure, trends).

import fs from 'node:fs';

const [fixtureId, slug, outPath, roundLabel] = process.argv.slice(2);
const TOKEN = process.env.SPORTMONKS_TOKEN;
if (!fixtureId || !slug || !outPath || !TOKEN) {
  console.error('usage: SPORTMONKS_TOKEN=... node scripts/sportmonks-probe.mjs <fixtureId> <slug> <out.json> [roundLabel]');
  process.exit(1);
}

let calls = 0;
async function get(path, params = {}) {
  const u = new URL('https://api.sportmonks.com/v3/football' + path);
  u.searchParams.set('api_token', TOKEN);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  calls++;
  const r = await (await fetch(u)).json();
  if (r.message) throw new Error(path + ': ' + r.message);
  return r.data;
}

const ROLE = { 24: 'GK', 25: 'DEF', 26: 'MID', 27: 'ATT' };
// Sportmonks detailed position name -> the schema's pos label
const POS = {
  'Goalkeeper': 'GK', 'Centre Back': 'CB', 'Left Back': 'LB', 'Right Back': 'RB',
  'Left Wing Back': 'LWB', 'Right Wing Back': 'RWB', 'Defensive Midfield': 'DM',
  'Central Midfield': 'CM', 'Attacking Midfield': 'CAM', 'Left Midfield': 'LM', 'Right Midfield': 'RM',
  'Left Wing': 'LW', 'Right Wing': 'RW', 'Centre Forward': 'ST', 'Second Striker': 'CAM',
  'Striker': 'ST', 'Left Winger': 'LW', 'Right Winger': 'RW'
};
const compName = (n) => (n === 'Premiership' ? 'Scottish Premiership' : n || null);
const day = (s) => String(s).slice(0, 10);
const ageOn = (dob, on) => {
  if (!dob) return null;
  const b = new Date(dob), o = new Date(on);
  let a = o.getUTCFullYear() - b.getUTCFullYear();
  if (o.getUTCMonth() < b.getUTCMonth() || (o.getUTCMonth() === b.getUTCMonth() && o.getUTCDate() < b.getUTCDate())) a--;
  return a;
};
const photo = (p) => (p && !/placeholder/.test(p) ? p : null);
const goalsOf = (f, teamId) => {
  const cur = (f.scores || []).filter((s) => s.description === 'CURRENT');
  const g = (id) => (cur.find((s) => s.participant_id === id)?.score.goals ?? null);
  return g(teamId);
};

// ---- 1. the fixture
const fx = await get('/fixtures/' + fixtureId, {
  include: 'participants;venue;referees.referee;sidelined.sideline.player;sidelined.sideline.type;coaches;metadata;season;league;round'
});
const home = fx.participants.find((p) => p.meta.location === 'home');
const away = fx.participants.find((p) => p.meta.location === 'away');
const kickUtc = new Date(fx.starting_at.replace(' ', 'T') + 'Z');
const bucharest = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Bucharest', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })
  .formatToParts(kickUtc).map((p) => [p.type, p.value]));
const asUtc = Date.UTC(+bucharest.year, +bucharest.month - 1, +bucharest.day, +bucharest.hour % 24, +bucharest.minute, +bucharest.second);
const offMin = Math.round((asUtc - kickUtc.getTime()) / 60000);
const pad = (n) => String(Math.abs(n)).padStart(2, '0');
const local = new Date(asUtc).toISOString().slice(0, 19);
const kickoff = `${local}${offMin >= 0 ? '+' : '-'}${pad(Math.trunc(offMin / 60))}:${pad(offMin % 60)}`;
const matchDay = day(fx.starting_at);

// ---- 2. standings
const stand = await get('/standings/seasons/' + fx.season_id, { include: 'participant;details.type;form' });
const D = (row, code) => row.details.find((d) => d.type.code === code)?.value ?? null;
const rows = stand.map((r) => ({
  rank: r.position, teamId: r.participant_id, team: r.participant.name,
  played: D(r, 'overall-matches-played'), win: D(r, 'overall-won'), draw: D(r, 'overall-draw'), loss: D(r, 'overall-lost'),
  gf: D(r, 'overall-goals-for'), ga: D(r, 'overall-goals-against'), gd: D(r, 'goal-difference'), points: r.points,
  form: (r.form || []).slice().sort((x, y) => x.sort_order - y.sort_order).map((f) => f.form).join('').slice(-5) || null
}));
const splitText = (teamId) => {
  const r = stand.find((x) => x.participant_id === teamId);
  if (!r) return null;
  return `Acasă ${D(r, 'home-won')}-${D(r, 'home-draw')}-${D(r, 'home-lost')}, deplasare ${D(r, 'away-won')}-${D(r, 'away-draw')}-${D(r, 'away-lost')}`;
};

// ---- 3. one team
// "row:col" grid + formation string -> XI listed line by line with the schema's pos labels
const LABELS = {
  def: { 2: ['LCB', 'RCB'], 3: ['LCB', 'CB', 'RCB'], 4: ['LB', 'LCB', 'RCB', 'RB'], 5: ['LWB', 'LCB', 'CB', 'RCB', 'RWB'] },
  mid: { 1: ['CM'], 2: ['LCM', 'RCM'], 3: ['LCM', 'CM', 'RCM'], 4: ['LM', 'LCM', 'RCM', 'RM'], 5: ['LM', 'LCM', 'CM', 'RCM', 'RM'] },
  adv: { 1: ['CAM'], 2: ['LCM', 'RCM'], 3: ['LW', 'CAM', 'RW'], 4: ['LM', 'LCM', 'RCM', 'RM'] },
  att: { 1: ['ST'], 2: ['LST', 'RST'], 3: ['LW', 'ST', 'RW'], 4: ['LW', 'LST', 'RST', 'RW'] }
};
function xiFromGrid(starters, formation, byPlayer) {
  const parts = String(formation).split('-').map(Number).filter(Boolean);
  const entry = (l, pos) => {
    const sp = byPlayer[l.player_id];
    return { apiId: l.player_id, number: sp?.number ?? l.jersey_number ?? null, name: sp?.name || l.player_name, pos };
  };
  const gk = starters.find((l) => l.position_id === 24 || (l.formation_field || '').startsWith('1:'));
  const grid = gk && starters.every((l) => l.formation_field) && parts.length && parts.reduce((a, b) => a + b, 1) === starters.length;
  if (!grid) {   // no grid: fall back to the squad's own position labels, GK first
    const order = { GK: 0, DEF: 1, MID: 2, ATT: 3 };
    return starters.map((l) => ({ ...entry(l, byPlayer[l.player_id]?.pos || 'CM'), _r: order[byPlayer[l.player_id]?.role] ?? 2 }))
      .sort((a, b) => a._r - b._r).map(({ _r, ...x }) => x);
  }
  const out = [entry(gk, 'GK')];
  parts.forEach((n, i) => {
    const line = starters.filter((l) => l.formation_field.startsWith((i + 2) + ':'))
      .sort((a, b) => +a.formation_field.split(':')[1] - +b.formation_field.split(':')[1]);
    const kind = i === 0 ? 'def' : i === parts.length - 1 ? 'att' : i === 1 ? 'mid' : 'adv';
    const labels = LABELS[kind][line.length] || line.map(() => 'CM');
    line.forEach((l, j) => out.push(entry(l, labels[j])));
  });
  return out;
}

async function buildTeam(part, coachRow, sideRows) {
  const sq = await get('/squads/teams/' + part.id, {
    include: 'player.nationality;player.country;detailedPosition;player.statistics.details.type',
    filters: 'playerStatisticSeasons:' + fx.season_id
  });
  const latest = (await get('/teams/' + part.id, {
    include: 'latest.scores;latest.participants;latest.league;latest.referees.referee;latest.formations;latest.lineups'
  })).latest.filter((f) => f.state_id === 5).sort((a, b) => b.starting_at_timestamp - a.starting_at_timestamp).slice(0, 6);

  const byPlayer = {};
  const stat = (p, code, key = 'total') => {
    const s = p.statistics?.find((x) => x.season_id === fx.season_id && x.team_id === part.id);
    const v = s?.details.find((d) => d.type.code === code)?.value;
    return v == null ? null : (typeof v === 'object' ? (v[key] ?? v.total ?? null) : v);
  };
  const sidelined = fx.sidelined.filter((s) => s.participant_id === part.id);
  const out = new Set(sidelined.map((s) => s.player_id));

  const squad = sq.map((row) => {
    const p = row.player, dp = row.detailedposition?.name;
    const pos = POS[dp] || null;
    const o = {
      apiId: p.id, number: row.jersey_number ?? null, name: (p.display_name || p.name).trim(), photo: photo(p.image_path),
      pos, positions: pos ? [pos] : [], role: ROLE[row.position_id] || 'MID',
      age: ageOn(p.date_of_birth, matchDay), birthDate: p.date_of_birth || null,
      height: p.height || null, weight: p.weight || null, foot: null,
      nat: p.nationality?.fifa_name || p.nationality?.iso3 || null, natTeam: null, birthCountry: p.country?.name || null,
      pronunciation: null, career: null, lastSeason: null, funfact: null, linkLine: null,
      status: out.has(p.id) ? 'out' : 'available', statusNote: null,
      stats: null
    };
    const apps = stat(p, 'appearances');
    const z = (v) => (v == null && apps ? 0 : v);   // the provider leaves out zero values
    o.stats = {
      goals: z(stat(p, 'goals', 'goals')), assists: z(stat(p, 'assists')), minutes: stat(p, 'minutes-played'), apps,
      yellow: z(stat(p, 'yellowcards')), red: z(stat(p, 'redcards')), rating: stat(p, 'rating', 'average'),
      conceded: p.position_id === 24 ? z(stat(p, 'goals-conceded')) : null, saves: p.position_id === 24 ? stat(p, 'saves') : null
    };
    byPlayer[p.id] = o;
    return o;
  }).sort((a, b) => (a.number ?? 999) - (b.number ?? 999));

  const absences = sidelined.map((s) => {
    const sl = s.sideline, pl = sl.player;
    if (byPlayer[sl.player_id]) byPlayer[sl.player_id].statusNote = sl.type?.name || null;
    return {
      name: pl.display_name || pl.name,
      reason: /susp/i.test(sl.category) || /susp/i.test(sl.type?.code || '') ? 'suspension' : /injur/i.test(sl.category) ? 'injury' : 'other',
      detail: sl.type?.name ? `${sl.type.name}${sl.games_missed != null ? ` (${sl.games_missed} meciuri ratate)` : ''}` : null,
      since: sl.start_date ? sl.start_date.slice(0, 7) : null
    };
  });

  // last match -> proxy for the likely XI (no expected-lineups on the free plan)
  const last = latest[0];
  const lastLineup = (last?.lineups || []).filter((l) => l.team_id === part.id && l.type_id === 11);
  const lastForm = last?.formations?.find((f) => f.participant_id === part.id)?.formation || 'n/d';
  const predictedXI = xiFromGrid(lastLineup, lastForm, byPlayer);

  // coach
  const c = coachRow ? await get('/coaches/' + coachRow.id, { include: 'teams.team;nationality' }) : null;
  const active = c?.teams.find((t) => t.team_id === part.id && t.active);
  const coach = c ? {
    apiId: c.id, name: c.display_name || c.name, photo: photo(c.image_path), country: c.nationality?.name || null,
    age: ageOn(c.date_of_birth, matchDay), birthDate: c.date_of_birth || null,
    tenureFrom: active?.start ? active.start.slice(0, 7) : null,
    career: c.teams.filter((t) => t.team).sort((a, b) => String(b.start).localeCompare(String(a.start))).map((t) => ({
      club: t.team.name, period: `${String(t.start).slice(0, 7)}–${t.active || !t.end ? 'prezent' : String(t.end).slice(0, 7)}`, note: t.temporary ? 'interimar' : null
    })),
    trophies: []
  } : { name: 'n/d', career: [] };

  // form
  const row = rows.find((r) => r.teamId === part.id);
  const recent = latest.map((f) => {
    const us = f.participants.find((p) => p.id === part.id), opp = f.participants.find((p) => p.id !== part.id);
    const gu = goalsOf(f, us.id), go = goalsOf(f, opp.id);
    const mainRef = f.referees?.find((r) => r.type_id === 6)?.referee;
    return {
      date: day(f.starting_at), opp: opp.name, homeAway: us.meta.location === 'home' ? 'H' : 'A', comp: compName(f.league?.name),
      score: `${gu}-${go}`, result: gu > go ? 'W' : gu < go ? 'L' : 'D', referee: mainRef ? (mainRef.display_name || mainRef.name) : null,
      formation: { us: f.formations?.find((x) => x.participant_id === us.id)?.formation || null, opp: f.formations?.find((x) => x.participant_id === opp.id)?.formation || null }
    };
  });
  const form = {
    last5: recent.slice(0, 5).map((r) => r.result), ppg: row?.played ? Math.round((row.points / row.played) * 100) / 100 : null,
    homeAway: splitText(part.id), position: row?.rank ?? null,
    note: row ? `Clasament ${fx.season.name}: locul ${row.rank}, ${row.points}p (${row.gf}-${row.ga})` : null,
    table: row ? { played: row.played, win: row.win, draw: row.draw, loss: row.loss, gf: row.gf, ga: row.ga, points: row.points } : null,
    recent
  };

  const ts = Object.fromEntries((await get('/teams/' + part.id, { include: 'statistics.details.type', filters: 'teamStatisticSeasons:' + fx.season_id }))
    .statistics.flatMap((b) => b.details).map((d) => [d.type.code, d.value]));
  const IV = { '0-15': '0-15', '15-30': '16-30', '30-45': '31-45', '45-60': '46-60', '60-75': '61-75', '75-90': '76-90' };
  const byInterval = (v) => (v ? Object.fromEntries(Object.entries(v).filter(([k]) => IV[k]).map(([k, x]) => [IV[k], x.count])) : null);
  form.stats = {
    goalsForByInterval: byInterval(ts['scoring-minutes']), goalsAgainstByInterval: byInterval(ts['conceded-scoring-minutes']),
    goalsForAvg: ts.goals?.all.average ?? null, goalsAgainstAvg: ts['goals-conceded']?.all.average ?? null,
    goalsForAvgHome: ts.goals?.home.average ?? null, goalsForAvgAway: ts.goals?.away.average ?? null,
    goalsAgainstAvgHome: ts['goals-conceded']?.home.average ?? null, goalsAgainstAvgAway: ts['goals-conceded']?.away.average ?? null,
    cleanSheets: ts.cleansheets?.all.count ?? null, cleanSheetsHome: ts.cleansheets?.home.count ?? null, cleanSheetsAway: ts.cleansheets?.away.count ?? null,
    failedToScore: ts['failed-toscore']?.all.count ?? null, failedToScoreHome: ts['failed-toscore']?.home.count ?? null, failedToScoreAway: ts['failed-toscore']?.away.count ?? null,
    winsHome: ts['team-wins']?.home.count ?? null, winsAway: ts['team-wins']?.away.count ?? null,
    drawsHome: ts['team-draws']?.home.count ?? null, drawsAway: ts['team-draws']?.away.count ?? null,
    losesHome: ts['team-lost']?.home.count ?? null, losesAway: ts['team-lost']?.away.count ?? null,
    formations: []
  };
  const nextRaw = (await get('/teams/' + part.id, { include: 'upcoming.participants;upcoming.league' })).upcoming || [];
  form.next = nextRaw.filter((x) => x.id !== Number(fixtureId)).sort((a, b) => a.starting_at_timestamp - b.starting_at_timestamp).slice(0, 3).map((x) => {
    const us = x.participants.find((p) => p.id === part.id), opp = x.participants.find((p) => p.id !== part.id);
    return { date: day(x.starting_at), opp: opp.name, homeAway: us.meta.location === 'home' ? 'H' : 'A', comp: compName(x.league?.name) };
  });

  return {
    name: part.name, shortName: part.short_code, nickname: null, logo: part.image_path, colors: null, coach,
    formation: lastForm, predictedXI, confirmedXI: null, substitutes: null, squad, form, absences,
    callUps: [], mercatoIn: [], mercatoOut: [], preseason: [], news: [], stories: [], clubFacts: null, pressQuotes: []
  };
}

const coachOf = (id) => fx.coaches.find((c) => c.meta.participant_id === id);
const teams = { home: await buildTeam(home, coachOf(home.id)), away: await buildTeam(away, coachOf(away.id)) };

// ---- 4. head to head
const h2hRaw = await get(`/fixtures/head-to-head/${home.id}/${away.id}`, { include: 'participants;scores;league;referees.referee' });
const h2hDone = h2hRaw.filter((f) => f.state_id === 5).sort((a, b) => b.starting_at_timestamp - a.starting_at_timestamp).slice(0, 10);
let wH = 0, wA = 0, dr = 0;
const h2h = {
  recent: h2hDone.map((f) => {
    const h = f.participants.find((p) => p.meta.location === 'home'), a = f.participants.find((p) => p.meta.location === 'away');
    const gh = goalsOf(f, h.id), ga = goalsOf(f, a.id);
    const winner = gh > ga ? h.id : gh < ga ? a.id : 0;
    if (winner === home.id) wH++; else if (winner === away.id) wA++; else dr++;
    const mainRef = f.referees?.find((r) => r.type_id === 6)?.referee;
    return { date: day(f.starting_at), comp: compName(f.league?.name), score: `${h.name} ${gh}-${ga} ${a.name}`, referee: mainRef ? (mainRef.display_name || mainRef.name) : null };
  })
};
h2h.summary = `Cap la cap (${h2hDone.length} meciuri): ${home.name} ${wH} - ${dr} - ${wA} ${away.name}.`;

// ---- 5. referee (often not assigned until a few days before)
const mainRef = fx.referees?.find((r) => r.type_id === 6)?.referee;
const referee = mainRef ? { name: mainRef.display_name || mainRef.name } : { name: 'n/d' };

const pack = {
  slug, generatedAt: new Date().toISOString(), partial: true,
  sources: [{ name: 'Sportmonks Football API (probe)', url: 'https://www.sportmonks.com/football-api/', accessed: new Date().toISOString().slice(0, 10) }],
  competition: { name: compName(fx.league.name), round: roundLabel || `Etapa ${fx.round?.name}`, country: 'GB', logo: fx.league.image_path },
  kickoff,
  venue: { name: fx.venue.name, capacity: fx.venue.capacity ?? null, city: fx.venue.city_name ?? null },
  referee, h2h, storyOfTheMatch: [],
  standings: { league: fx.league.name, season: Number(String(fx.season.name).slice(0, 4)), rows },
  teams
};
fs.writeFileSync(outPath, JSON.stringify(pack, null, 2) + '\n');
console.log(`wrote ${outPath}  (${calls} API calls)`);
console.log(`squad ${teams.home.squad.length}/${teams.away.squad.length}, predictedXI ${teams.home.predictedXI.length}/${teams.away.predictedXI.length}, absences ${teams.home.absences.length}/${teams.away.absences.length}, h2h ${h2h.recent.length}, standings ${rows.length}`);
