const API_KEY = process.env.APIFOOTBALL_KEY;
const HOST = 'https://v3.football.api-sports.io';
const HEADERS = { 'x-apisports-key': API_KEY };
async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
  const r = await fetch(`${HOST}/${path}${qs ? '?' + qs : ''}`, { headers: HEADERS });
  return r.json();
}
const j = await af('coachs', { team: 111 }); // Le Havre
console.log(JSON.stringify(j.response ? j.response.slice(0, 2) : j, null, 2));
