// One-off: referee season statistics for a league without needing a pack (testing scripts/lib/referee-stats.mjs).
//   APIFOOTBALL_KEY=... LEAGUE=61 SEASON=2026 REFEREE="Geoffrey Kubler" node scripts/referee-stats-probe.mjs
import { refereeSeasonStats } from './lib/referee-stats.mjs';
const KEY = process.env.APIFOOTBALL_KEY;
async function af(path, params) {
  const res = await fetch(`https://v3.football.api-sports.io/${path}?${new URLSearchParams(params)}`, { headers: { 'x-apisports-key': KEY } });
  console.log(`GET ${path} ${JSON.stringify(params)} -> ${res.status} remaining=${res.headers.get('x-ratelimit-requests-remaining')}`);
  return res.ok ? res.json() : null;
}
const s = await refereeSeasonStats({
  af, doc: { referee: { name: process.env.REFEREE } },
  fixture: { leagueId: Number(process.env.LEAGUE), homeId: null, awayId: null, home: '', away: '' },
  season: Number(process.env.SEASON), budget: { left: Number(process.env.BUDGET) || 30 },
});
console.log(JSON.stringify(s, null, 1));
