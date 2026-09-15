// Temporary: look up the exact API-Football league id for Coppa Italia.
const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
const HEADERS = { 'x-apisports-key': API_KEY };

async function main() {
  const r = await fetch(`${HOST}/leagues?search=Coppa Italia`, { headers: HEADERS });
  const j = await r.json();
  console.log(JSON.stringify(j.response.map((x) => ({
    id: x.league.id, name: x.league.name, type: x.league.type, country: x.country.name,
    seasons: x.seasons.filter((s) => s.current).map((s) => s.year),
  })), null, 2));
}
main().catch((e) => { console.error(e); process.exit(1); });
