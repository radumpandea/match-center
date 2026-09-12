// One-off: check what /players/profiles actually returns, to see if it's a
// more reliable name source than /players?team=&season= (which produced a
// truncated "Joshua Erowoli Orisunmihare Oluwaseun" for Josh Maja, dropping
// the surname entirely).
const API_KEY = process.env.APIFOOTBALL_KEY;
const HOST = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_KEY };

async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}${qs ? '?' + qs : ''}`;
  const r = await fetch(url, { headers: HEADERS });
  console.log(`${path}?${qs} -> HTTP ${r.status}`);
  return r.json();
}

const bySearch = await af('players/profiles', { search: 'Maja' });
console.log('by search=Maja:', JSON.stringify(bySearch, null, 2).slice(0, 3000));

// Le Havre's team id in our fixtures.json is 111.
const byTeam = await af('players', { team: 111, season: 2026, search: 'Maja' });
console.log('by team+search:', JSON.stringify(byTeam, null, 2).slice(0, 3000));
