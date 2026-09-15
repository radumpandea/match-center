// Temporary: inspect raw API-Football /players bio (name/firstname/lastname)
// for players whose display name stayed abbreviated ("I. Popescu") even
// though nat/photo DID populate for them -- to find out whether the name-
// reconstruction fallback in prefetch-preview.mjs's pushPlayer() is being
// blocked by missing firstname/lastname, or by the surname sanity check.
const HOST = 'https://v3.football.api-sports.io';
const API_KEY = process.env.APIFOOTBALL_KEY;
const HEADERS = { 'x-apisports-key': API_KEY };

const cases = [
  { id: 42506, label: 'I. Popescu (CSM Resita, has nat+photo, stayed abbreviated)' },
  { id: 148804, label: 'G. Ursu (CSM Resita, has nat+photo, stayed abbreviated)' },
  { id: 45342, label: 'D. Mijic (CSM Resita, has nat+photo, stayed abbreviated)' },
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
      if (resp.length) {
        const row = resp[0];
        console.log('player bio:', JSON.stringify(row.player));
      }
    }
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
