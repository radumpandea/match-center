// Deterministic, no AI, no API-Football calls: for each player the "Build Player Facts"
// run is about to research, find his Wikipedia article and Wikidata record and write
// the text to .player-sources/<apiId>.txt (not committed). The researcher then READS
// that file instead of searching the web: roughly one lookup less per player and no
// mix-ups between players with the same name (two different "Rafael Brito" exist).
//
// Matching: Wikipedia search ("<name> <club> footballer"), then the candidate must be
// a footballer whose birth year agrees with the age API-Football gives (±1), or, when
// the age is unknown, whose article mentions the club. Wikidata (via the page's
// wikibase_item) adds the exact birth date and the club career with the years and
// match counts it has -- often the only structured source for lesser-known players.
// Romanian Wikipedia is tried when the English one has nothing.
//
// Env: PLAYERS = JSON array of {apiId, name, team, age}. Requires Node 18+.

import { mkdirSync, writeFileSync } from 'node:fs';

// INTRO_ONLY=1 (pronunciation pass): keep just the intro, where Wikipedia puts the IPA, in OUT_DIR
const OUT = process.env.OUT_DIR || '.player-sources';
const INTRO_ONLY = !!process.env.INTRO_ONLY;
const MAX_TEXT = 16000;
const UA = { 'User-Agent': 'match-center-player-facts/1.0 (https://github.com/radumpandea/match-center)' };
const THIS_YEAR = new Date().getFullYear();

let players;
try { players = JSON.parse(process.env.PLAYERS || '[]'); } catch { players = []; }
mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function getJSON(url) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await fetch(url, { headers: UA });
      if (r.ok) return await r.json();
      if (r.status !== 429 && r.status < 500) return null;
    } catch { /* retry */ }
    await sleep(800 * (attempt + 1));
  }
  return null;
}
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

function birthYearFrom(text) {
  const m = /\(\s*(?:born|n\.|născut[ăa]?)[^)]*?(\d{4})/i.exec(text || '') || /\bborn[^.]{0,40}?(\d{4})/i.exec(text || '');
  return m ? Number(m[1]) : null;
}

async function search(lang, query) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=5&srprop=snippet&srsearch=${encodeURIComponent(query)}`;
  const j = await getJSON(url);
  return (j && j.query && j.query.search) || [];
}

async function article(lang, title) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&redirects=1&prop=extracts|pageprops&explaintext=1&ppprop=wikibase_item&titles=${encodeURIComponent(title)}`;
  const j = await getJSON(url);
  const pages = j && j.query && j.query.pages;
  const page = pages && Object.values(pages)[0];
  if (!page || page.missing !== undefined) return null;
  return { title: page.title, text: page.extract || '', qid: page.pageprops && page.pageprops.wikibase_item };
}

async function findPage(p) {
  const expected = p.age != null ? THIS_YEAR - Number(p.age) : null;
  // API-Football often gives the full legal name ("Achraf Hakimi Mouh", "Alejandro Garnacho
  // Ferreyra"), which is not what the article is titled: also try shorter forms, and accept a
  // title that contains ANY real part of the name (the footballer + birth-year checks below
  // keep homonyms out).
  const short = String(p.name || '').split(/\s+/).filter(Boolean);
  const names = [p.name];
  if (short.length > 2) {
    for (const alt of [`${short[0]} ${short[1]}`, `${short[0]} ${short[short.length - 1]}`, `${short[1]} ${short[short.length - 1]}`]) if (!names.includes(alt)) names.push(alt);
  }
  const parts = short.map(strip).filter((w) => w.replace(/[^a-z]/g, '').length >= 4);
  if (!parts.length && short.length) parts.push(strip(short[short.length - 1]));
  for (const lang of ['en', 'ro']) {
    const word = lang === 'en' ? 'footballer' : 'fotbalist';
    const seen = new Set();
    for (const nm of names) {
      for (const q of [`${nm} ${p.team || ''} ${word}`, `${nm} ${word}`]) {
        for (const hit of await search(lang, q)) {
          if (seen.has(hit.title)) continue;
          seen.add(hit.title);
          const snippet = String(hit.snippet || '').replace(/<[^>]+>/g, '');
          const title = strip(hit.title);
          if (!parts.some((w) => title.includes(w))) continue;
          const art = await article(lang, hit.title);
          if (!art) continue;
          const intro = art.text.slice(0, 700);
          const isFootballer = /footballer|football player|soccer player|fotbalist|footballeur/i.test(intro + snippet);
          const by = birthYearFrom(intro) || birthYearFrom(snippet);
          const yearOk = expected != null && by != null && Math.abs(by - expected) <= 1;
          const clubOk = p.team && strip(art.text).includes(strip(String(p.team).split(' ')[0]));
          if (isFootballer && (yearOk || (by == null && clubOk) || (expected == null && clubOk))) return { lang, ...art, birthYear: by };
        }
        await sleep(150);
      }
    }
  }
  return null;
}

const claimVal = (st) => st && st.mainsnak && st.mainsnak.datavalue && st.mainsnak.datavalue.value;
const qualYear = (st, prop) => {
  const q = st.qualifiers && st.qualifiers[prop];
  const v = q && q[0] && q[0].datavalue && q[0].datavalue.value;
  return v && v.time ? v.time.slice(1, 5) : null;
};
const qualNum = (st, prop) => {
  const q = st.qualifiers && st.qualifiers[prop];
  const v = q && q[0] && q[0].datavalue && q[0].datavalue.value;
  return v && v.amount ? String(Number(v.amount)) : null;
};

async function wikidataBlock(qid) {
  if (!qid) return '';
  const j = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const ent = j && j.entities && j.entities[qid];
  if (!ent) return '';
  const claims = ent.claims || {};
  const lines = [`Wikidata ${qid}:`];
  const born = claimVal((claims.P569 || [])[0]);
  if (born && born.time) lines.push(`- born: ${born.time.slice(1, 11)}`);
  const teams = (claims.P54 || []).map((st) => ({ id: (claimVal(st) || {}).id, from: qualYear(st, 'P580'), to: qualYear(st, 'P582'), apps: qualNum(st, 'P1350'), goals: qualNum(st, 'P1351') })).filter((t) => t.id);
  const ids = [...new Set(teams.map((t) => t.id))].slice(0, 50);
  let labels = {};
  if (ids.length) {
    const lj = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${ids.join('|')}`);
    for (const [id, e] of Object.entries((lj && lj.entities) || {})) labels[id] = e.labels && e.labels.en && e.labels.en.value;
  }
  if (teams.length) {
    lines.push('- teams (member of sports team):');
    teams.forEach((t) => lines.push(`  * ${labels[t.id] || t.id}${t.from || t.to ? ` (${t.from || '?'}–${t.to || '?'})` : ''}${t.apps ? `, ${t.apps} apps` : ''}${t.goals ? `, ${t.goals} goals` : ''}`));
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

let found = 0;
for (const p of players) {
  let body;
  try {
    const page = await findPage(p);
    if (!page) {
      body = `NO_WIKIPEDIA_PAGE for "${p.name}" (${p.team}, age ${p.age}). Use at most one web search; if nothing reliable turns up, write the file with funfacts [] and checkedAt.\n`;
    } else {
      found++;
      const wd = INTRO_ONLY ? '' : await wikidataBlock(page.qid);
      body = [`Source: https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, `Matched: ${page.title} (born ${page.birthYear || '?'}) for ${p.name}, ${p.team}`, wd, '', page.text.slice(0, INTRO_ONLY ? 900 : MAX_TEXT)].filter((x) => x !== undefined).join('\n');
    }
  } catch (e) {
    body = `RESOLVER_ERROR for "${p.name}": ${e.message}. Search the web instead.\n`;
  }
  writeFileSync(`${OUT}/${p.apiId}.txt`, body, 'utf8');
  console.log(`${p.apiId} ${p.name}: ${body.split('\n')[0].slice(0, 110)}`);
  await sleep(200);
}
console.log(`${found}/${players.length} players matched to an article.`);
