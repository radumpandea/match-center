#!/usr/bin/env node
// Referee delegations for the Romanian leagues, from the FRF Central Referees Committee (frf-cca.ro/delegari, which
// redirects to hailafotbal.ro/arbitri/delegari). API-Football almost never has the referee of Romanian matches; the
// CCA publishes the delegation (referee, assistants, reserve, VAR, observer) a few days before each round.
//
// How it reads the site, and why that way: the page is an Angular app that fills itself from FRF's own API with a
// token it fetches by itself. This script does NOT call that API or reuse its token; it opens the public page in a
// headless browser (Playwright), exactly as a visitor would, and reads the rendered text. Politeness: frf-cca.ro's
// robots.txt asks for a 10 s crawl delay and leaves /delegari open, so there are at least 10 s between page loads,
// at most MAX_PAGES pages per run, only for rounds that have a match in the next few days, and pages whose
// delegations are already known are not asked for again until 2 days before the kick-off (a replacement referee is
// possible). Cadence: every 6 hours (.github/workflows/fetch-delegations.yml).
//
//   node scripts/fetch-delegations.mjs --plan   -> which rounds would be fetched (also sets needed=true|false in
//                                                   $GITHUB_OUTPUT so the workflow can skip installing a browser)
//   node scripts/fetch-delegations.mjs          -> fetch them, write docs/data/delegari.json, fill the packs
//   node scripts/fetch-delegations.mjs --parse FILE   -> parse a saved page text (testing)
//
// Writes docs/data/delegari.json and, on packs of the matched fixtures that have no referee, referee.name (given
// name first, title case: the list is surname first) and referee.crew. A referee already in a pack is never
// replaced by a different name from here; a difference is only printed.

import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';

const SOURCES = JSON.parse(readFileSync(new URL('./data/delegari-sources.json', import.meta.url), 'utf8'));
const OUT = 'docs/data/delegari.json';
const FIXTURES = 'docs/data/fixtures.json';
const MAX_PAGES = Number(process.env.MAX_PAGES) || 8;
const DELAY_MS = 10500;
const DAYS_AHEAD = 6;

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const has = (v) => v != null && v !== '' && v !== 'n/d';

/* ---------- parsing the rendered page text ---------- */
const LABELS = {
  'referee': 'referee', 'arbitru': 'referee',
  'assistant referee 1': 'assistant1', 'asistent 1': 'assistant1',
  'assistant referee 2': 'assistant2', 'asistent 2': 'assistant2',
  'arbitru rezerva': 'reserve', 'arbitru rezervă': 'reserve', 'fourth official': 'reserve',
  'referee observer': 'observer', 'observator': 'observer',
  'arbitru var': 'var', 'arbitru avar': 'avar', 'match delegate': 'delegate', 'delegat': 'delegate',
};

export function parseDelegations(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const vs = [];
  lines.forEach((l, i) => { if (l.toLowerCase() === 'vs') vs.push(i); });
  const out = [];
  vs.forEach((idx, n) => {
    const home = lines[idx - 1], away = lines[idx + 1];
    const end = n + 1 < vs.length ? vs[n + 1] - 1 : lines.length;
    const card = lines.slice(idx + 2, end);
    const dt = card.find((l) => /^\d{2}\/\d{2}\/\d{4},\s*\d{1,2}:\d{2}\s*[AP]M$/i.test(l));
    if (!dt) return;
    const m = dt.match(/^(\d{2})\/(\d{2})\/(\d{4}),\s*(\d{1,2}):(\d{2})\s*([AP])M$/i);
    let h = Number(m[4]) % 12; if (m[6].toUpperCase() === 'P') h += 12;
    const m1 = {
      home, away,
      date: `${m[3]}-${m[1]}-${m[2]}`,
      ko: `${String(h).padStart(2, '0')}:${m[5]}`,
      available: !card.some((l) => /currently unavailable|indisponibil/i.test(l)),
    };
    const si = card.findIndex((l) => l.toLowerCase() === 'stadium');
    if (si >= 0 && card[si + 1]) m1.venue = card[si + 1];
    for (let i = 0; i < card.length; i++) {
      const key = LABELS[card[i].toLowerCase()];
      if (!key || !card[i + 1]) continue;
      m1[key] = card[i + 1];
      if (key === 'referee' && /^\(.+\)$/.test(card[i + 2] || '')) m1.refereeCounty = card[i + 2].slice(1, -1);
      i++;
    }
    out.push(m1);
  });
  return out;
}

// "Gaman George Catalin" (surname first, sometimes ALL CAPS) -> "George Catalin Gaman"
export function givenFirst(official) {
  const tk = String(official || '').trim().split(/\s+/).filter(Boolean);
  if (tk.length < 2) return official || '';
  const cap = (w) => w.split('-').map((p) => (p ? p[0].toUpperCase() + p.slice(1).toLowerCase() : p)).join('-');
  const t = tk.map((w) => (w === w.toUpperCase() || w === w.toLowerCase() ? cap(w) : w));
  return [...t.slice(1), t[0]].join(' ');
}

/* ---------- matching a delegation to a fixture ---------- */
const GENERIC = new Set(['fc', 'afc', 'sc', 'as', 'acs', 'fk', 'csm', 'cs', 'suporter', 'club', 'fcv', 'sa', 'municipal', 'universitatea', 'u', 'univ']);
const toks = (s) => strip(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w && !GENERIC.has(w) && !/^\d{4}$/.test(w) && !/^\d+$/.test(w));
const sharesTeam = (a, b) => { const x = new Set(toks(a)); return toks(b).some((w) => x.has(w)); };
const sameTeam = sharesTeam;
export function matchFixture(fixtures, d) {
  const cands = fixtures.filter((f) => f.date === d.date && f.ko === d.ko && sameTeam(f.home, d.home) && sameTeam(f.away, d.away));
  return cands.length === 1 ? cands[0] : null;
}

/* ---------- what to fetch ---------- */
function roundOf(f) { const m = String(f.round || '').match(/(\d+)\s*$/); return m ? Number(m[1]) : null; }
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const plusDays = (n) => new Date(Date.now() + n * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });

function plan(fixtures, known) {
  const from = today(), to = plusDays(DAYS_AHEAD);
  const rounds = new Map();   // "Comp|N" -> { comp, round, soonest }
  for (const f of fixtures) {
    if (!SOURCES.competitions[f.comp] || f.date < from || f.date > to) continue;
    const r = roundOf(f);
    if (r == null || r > SOURCES.competitions[f.comp].maxRound) continue;
    // already known, and not about to be played: leave it
    const have = known.matches.find((m) => m.date === f.date && m.ko === f.ko && m.available && sameTeam(f.home, m.home) && sameTeam(f.away, m.away));
    const near = f.date <= plusDays(2);
    if (have && !near) continue;
    const k = `${f.comp}|${r}`;
    if (!rounds.has(k)) rounds.set(k, { comp: f.comp, round: r, soonest: f.kickoff || f.date });
  }
  return [...rounds.values()].sort((a, b) => String(a.soonest).localeCompare(String(b.soonest)));
}

function setOutput(k, v) { if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${k}=${v}\n`); }

/* ---------- main ---------- */
async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--parse') { console.log(JSON.stringify(parseDelegations(readFileSync(args[1], 'utf8')), null, 1)); return; }
  const fixtures = JSON.parse(readFileSync(FIXTURES, 'utf8'));
  const known = existsSync(OUT) ? JSON.parse(readFileSync(OUT, 'utf8')) : { fetchedAt: null, matches: [] };
  // FORCE_ROUNDS="Superliga:15,Liga 2:13" fetches exactly those rounds (testing a round that has been played)
  const forced = String(process.env.FORCE_ROUNDS || '').split(',').map((x) => x.trim()).filter(Boolean).map((x) => { const [comp, r] = x.split(':'); return { comp: comp.trim(), round: Number(r) }; }).filter((x) => SOURCES.competitions[x.comp] && x.round > 0);
  const todo = (forced.length ? forced : plan(fixtures, known)).slice(0, MAX_PAGES);
  if (args[0] === '--plan') {
    console.log(todo.length ? `Would fetch: ${todo.map((x) => `${x.comp} round ${x.round}`).join(', ')}` : 'Nothing to fetch.');
    setOutput('needed', todo.length ? 'true' : 'false');
    return;
  }
  if (!todo.length) { console.log('Nothing to fetch.'); return; }

  const { chromium } = await import('playwright');
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ locale: 'en-US', userAgent: 'MatchCenter/1.0 (personal football commentary tool; reads public referee delegations)' });
  const fetched = [];
  try {
    for (let i = 0; i < todo.length; i++) {
      const { comp, round } = todo[i];
      const url = `${SOURCES.base}/${SOURCES.competitions[comp].path.replace('{round}', round)}`;
      if (i > 0) await new Promise((r) => setTimeout(r, DELAY_MS));
      const page = await ctx.newPage();
      try {
        await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
        await page.waitForSelector('main', { timeout: 15000 });
        await page.waitForTimeout(2500);   // the cards are drawn after the data arrives
        const text = (await page.locator('main').allInnerTexts()).join('\n');
        const rows = parseDelegations(text);
        console.log(`${comp} round ${round}: ${rows.length} match(es), ${rows.filter((r) => r.available).length} with a delegation`);
        rows.forEach((r) => fetched.push({ ...r, comp, round, url }));
      } catch (e) {
        console.log(`${comp} round ${round}: failed (${e.message.split('\n')[0]})`);
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  if (!fetched.length) return;

  // merge: a fetched match replaces the same match (date + kick-off + home) from before
  const keyOf = (m) => `${m.date}|${m.ko}|${strip(m.home)}`;
  const merged = new Map(known.matches.map((m) => [keyOf(m), m]));
  const at = new Date().toISOString();
  for (const m of fetched) merged.set(keyOf(m), { ...m, fetchedAt: at });
  const cutoff = forced.length ? '0000-00-00' : plusDays(-3);
  const matches = [...merged.values()].filter((m) => m.date >= cutoff).sort((a, b) => (a.date + a.ko).localeCompare(b.date + b.ko));
  writeFileSync(OUT, JSON.stringify({ fetchedAt: at, source: 'FRF CCA - delegari (frf-cca.ro, hailafotbal.ro/arbitri/delegari)', matches }, null, 1) + '\n');

  // fill the packs
  let filled = 0;
  for (const m of matches.filter((x) => x.available && x.referee)) {
    const f = matchFixture(fixtures, m);
    if (!f) continue;
    const p = `docs/data/matches/${f.slug}.json`;
    if (!existsSync(p)) continue;
    const doc = JSON.parse(readFileSync(p, 'utf8'));
    if (!doc.referee) continue;
    const name = givenFirst(m.referee);
    const cur = doc.referee.name;
    if (has(cur) && strip(cur).split(/\s+/).pop() !== strip(name).split(/\s+/).pop()) {
      console.log(`  ${f.slug}: the pack has "${cur}", the CCA list says "${name}": left as is, check it`);
      continue;
    }
    const crew = {
      refereeCounty: m.refereeCounty || null, assistant1: m.assistant1 || null, assistant2: m.assistant2 || null,
      reserve: m.reserve || null, observer: m.observer || null, var: m.var || null, avar: m.avar || null, delegate: m.delegate || null,
    };
    let changed = false;
    if (!has(cur)) { doc.referee.name = name; if (!has(doc.referee.country)) doc.referee.country = 'România'; changed = true; }
    if (JSON.stringify(doc.referee.crew || null) !== JSON.stringify(crew)) { doc.referee.crew = crew; changed = true; }
    if (changed) {
      if (!(doc.sources || []).some((s) => /hailafotbal|frf-cca/.test(s.url || ''))) {
        (doc.sources = doc.sources || []).push({ name: 'FRF CCA — delegări arbitri', url: 'https://hailafotbal.ro/arbitri/delegari', accessed: at.slice(0, 10) });
      }
      writeFileSync(p, JSON.stringify(doc, null, 2) + '\n');
      filled++;
      console.log(`  ${f.slug}: referee ${has(cur) ? 'crew updated' : 'set'} (${name})`);
    }
  }
  console.log(`${filled} pack(s) updated.`);
}

if (process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scripts/fetch-delegations.mjs')) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
