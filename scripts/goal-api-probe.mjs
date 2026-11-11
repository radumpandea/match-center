// One-off probe of GOAL API (https://api.goal-api.com/v1) to see what it returns for the leagues this project
// covers: is there a referee on the fixture, lineups / missing players, per-season player statistics.
// Prints status, quota headers and a truncated body; never prints the key. Extra GET paths (one per line) can
// be passed in PATHS. Needs GOAL_API (bearer key). Node 18+.
const KEY = process.env.GOAL_API;
if (!KEY) { console.error('Missing GOAL_API.'); process.exit(1); }
const BASE = 'https://api.goal-api.com/v1';
let calls = 0;
const MAX = Number(process.env.MAX_CALLS) || 40;

async function get(path, show = 1200) {
  if (calls >= MAX) { console.log(`(call cap ${MAX} reached, skipping ${path})`); return null; }
  calls++;
  const res = await fetch(BASE + path, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'application/json' } });
  const hdr = [...res.headers.entries()].filter(([k]) => /rate|limit|remaining|quota|retry/i.test(k)).map(([k, v]) => `${k}=${v}`).join(' ');
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch {}
  console.log(`\n### GET ${path} -> ${res.status} ${hdr ? '[' + hdr + ']' : ''}`);
  if (show) console.log((json ? JSON.stringify(json) : text).slice(0, show));
  return json;
}
const rows = (j) => (j && (Array.isArray(j) ? j : Array.isArray(j.data) ? j.data : Array.isArray(j.results) ? j.results : Array.isArray(j.items) ? j.items : [])) || [];

async function main() {
  // 1. leagues: find the ones we care about
  const want = /super ?liga|liga 1|liga 2|ligue 1|premier league|fa cup|league one|saudi|champions league|scottish|eredivisie/i;
  const found = [];
  for (let off = 0; off < 1500; off += 100) {
    const j = await get(`/leagues?limit=100&offset=${off}`, off === 0 ? 600 : 0);
    const r = rows(j);
    if (!r.length) break;
    r.forEach((l) => { const nm = [l.name, l.leagueName, l.title].find(Boolean) || ''; if (want.test(nm)) found.push(l); });
    if (r.length < 100) break;
  }
  console.log('\n=== matching leagues ===');
  found.forEach((l) => console.log(JSON.stringify(l).slice(0, 220)));

  // 2. fixtures per interesting league: look for referee / lineups fields
  const pick = (re, ctry) => found.filter((l) => re.test(l.name || '') && (!ctry || new RegExp(ctry, 'i').test(JSON.stringify(l))));
  const targets = [...pick(/super ?liga|liga 1/i, 'rom'), ...pick(/liga 2|liga ii/i, 'rom'), ...pick(/^ligue 1/i, 'fran'), ...pick(/^premier league/i, 'engl')].slice(0, 4);
  for (const l of targets) {
    const id = l.id ?? l.leagueId;
    console.log(`\n=== league ${id} ${l.name} ===`);
    const fx = await get(`/leagues/${id}/fixtures?limit=5`, 700);
    const f = rows(fx)[0];
    if (f) {
      const fid = f.id ?? f.fixtureId ?? f.matchId;
      await get(`/fixtures/${fid}`, 1500);
      await get(`/fixtures/${fid}/lineups`, 1500);
    }
    const rs = await get(`/leagues/${id}/results?limit=5`, 500);
    const rf = rows(rs)[0];
    if (rf) {
      const fid = rf.id ?? rf.fixtureId ?? rf.matchId;
      await get(`/fixtures/${fid}`, 1500);
      await get(`/fixtures/${fid}/lineups`, 1500);
    }
  }

  // 3. player statistics: is it per season / competition?
  const ps = await get('/players/search?q=Salah', 500);
  const p = rows(ps)[0];
  if (p) {
    const pid = p.id ?? p.playerId;
    await get(`/players/${pid}`, 1200);
    await get(`/players/${pid}/statistics`, 2500);
  }

  // 4. coach
  await get('/coaches/search?q=Pantaloni', 800);

  // 5. anything extra
  for (const line of String(process.env.PATHS || '').split('\n').map((s) => s.trim()).filter(Boolean)) await get(line, 3000);
  console.log(`\n${calls} call(s) used.`);
}
main().catch((e) => { console.error(e); process.exit(1); });
