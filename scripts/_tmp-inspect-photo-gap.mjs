// Temporary: confirm whether FC Bacau players still missing `photo` (and
// `nat`) genuinely have no bio row at API-Football at all (both seasons),
// or whether there's a real bug leaving photo unset despite bio existing.
const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
const HEADERS = { 'x-apisports-key': API_KEY };

const cases = [
  { id: 644510, label: 'Edoardo Alloj (FC Bacau)' },
  { id: 556171, label: 'L. Anton (FC Bacau)' },
  { id: 556207, label: 'M. Gumenco (FC Bacau)' },
  { id: 435940, label: 'L. Agapi (FC Bacau)' },
];

async function af(path, params) {
  const qs = Object.entries(params || {}).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
  const url = `${HOST}/${path}?${qs}`;
  const r = await fetch(url, { headers: HEADERS });
  return r.json();
}

async function main() {
  for (const c of cases) {
    console.log('\n=== ' + c.label + ' ===');
    for (const season of [2026, 2025]) {
      const j = await af('players', { id: c.id, season });
      const resp = j.response || [];
      console.log(`season=${season}: results=${j.results}, errors=${JSON.stringify(j.errors)}`);
      if (resp.length) console.log('player bio:', JSON.stringify(resp[0].player));
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
