// One-off diagnostic: does soccer-football-info.p.rapidapi.com have referee
// data for today's Match Center fixtures? Not part of the pipeline — run via
// .github/workflows/test-soccerfootballinfo.yml (workflow_dispatch only) to
// spend exactly ONE call against the free tier's tight 8/hr limit, then read
// the Action log. Delete both files once the question is answered.

import { readFileSync } from 'node:fs';

const KEY = process.env.SOCCERFOOTBALLINFO_KEY;
if (!KEY) { console.error('Missing SOCCERFOOTBALLINFO_KEY env var.'); process.exit(1); }

const HOST = 'soccer-football-info.p.rapidapi.com';
const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');

function todayCompact() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }).replace(/-/g, '');
}

async function main() {
  const d = todayCompact();
  const url = `https://${HOST}/matches/day/full/?d=${d}&l=en_US`;
  console.log(`GET ${url}`);
  const r = await fetch(url, { headers: { 'x-rapidapi-key': KEY, 'x-rapidapi-host': HOST } });
  console.log(`HTTP ${r.status}`);
  const j = await r.json();
  if (j.errors && j.errors.length) console.log('errors:', JSON.stringify(j.errors));
  const rows = (j && j.result) || [];
  console.log(`pagination: ${JSON.stringify(j.pagination)}`);
  console.log(`total rows on this page: ${rows.length}`);

  const withRef = rows.filter((m) => m.referee && m.referee.name);
  console.log(`rows WITH a referee name: ${withRef.length} / ${rows.length}`);

  // list the championships present on this page, so we can see whether our
  // leagues (Ligue 1, La Liga, Bundesliga/2.Bundesliga, Superliga) show up at all
  const champs = new Map();
  rows.forEach((m) => {
    const name = m.championship && m.championship.name;
    if (!name) return;
    champs.set(name, (champs.get(name) || 0) + (m.referee && m.referee.name ? '+ref' : ''));
  });
  console.log('championships on this page:', JSON.stringify([...champs.keys()]));

  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
  const today = fixtures.filter((f) => f.date === new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' }));
  console.log(`\nMatching against ${today.length} Match Center fixtures for today:`);
  for (const f of today) {
    const home = norm(f.home), away = norm(f.away);
    const hit = rows.find((m) => {
      const a = norm(m.teamA && m.teamA.name), b = norm(m.teamB && m.teamB.name);
      return (a.includes(home) || home.includes(a)) && (b.includes(away) || away.includes(b));
    });
    if (!hit) { console.log(`- ${f.slug}: NOT FOUND on this page`); continue; }
    console.log(`- ${f.slug}: FOUND (${hit.teamA.name} vs ${hit.teamB.name}) | referee: ${hit.referee ? hit.referee.name : 'null'} | championship: ${hit.championship ? hit.championship.name : '?'}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
