// Temporary: inspect raw API-Football /players response shape for players
// currently missing `nat` in our data, to design the bio-fallback fix.
const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
const HEADERS = { 'x-apisports-key': API_KEY };

const cases = [
  { id: 46365, label: 'S. Ngezana (FCSB CB, missing nat, no team-season row)' },
  { id: 30948, label: 'L. Zima (Petrolul GK, missing nat)' },
  { id: 570791, label: 'R. Andrei (FCSB GK, has row but empty nat)' },
];

async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}?${qs}`;
  const r = await fetch(url, { headers: HEADERS });
  const j = await r.json();
  return j;
}

async function main() {
  for (const c of cases) {
    console.log('\n=== ' + c.label + ' ===');
    for (const season of [2026, 2025]) {
      const j = await af('players', { id: c.id, season });
      const resp = j.response || [];
      console.log(`season=${season}: results=${j.results}, errors=${JSON.stringify(j.errors)}`);
      if (resp.length) {
        const row = resp[0];
        console.log('player bio:', JSON.stringify(row.player));
        console.log('statistics[0].games:', JSON.stringify(row.statistics[0] && row.statistics[0].games));
        console.log('statistics[0].goals:', JSON.stringify(row.statistics[0] && row.statistics[0].goals));
        console.log('all statistics teams:', row.statistics.map((s) => s.team && s.team.name));
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
