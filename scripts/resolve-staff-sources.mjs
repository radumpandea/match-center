// Deterministic, no AI, no API-Football calls: for each coach / referee the "Build Player Facts" run
// is about to research, find his Wikipedia article and write the text (plus Wikidata's birth date) to
// .staff-sources/<kind>-<key>.txt (not committed). The researcher READS that file instead of searching.
//
// Matching: Wikipedia search ("<name> football manager" / "<name> football referee"); the title must
// share a real word with the name, the intro must describe a manager/coach (or referee), and, when the
// age (or exact birth date) is known, the article's birth year must agree (+-1). Romanian Wikipedia is
// tried when English has nothing.
//
// Env: STAFF = JSON array of {kind, key, name, country, age, birthDate, team}. Requires Node 18+.

import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '.staff-sources';
const MAX_TEXT = 14000;
const UA = { 'User-Agent': 'match-center-staff-facts/1.0 (https://github.com/radumpandea/match-center)' };
const THIS_YEAR = new Date().getFullYear();

let staff;
try { staff = JSON.parse(process.env.STAFF || '[]'); } catch { staff = []; }
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
const words = (s) => strip(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3);

function birthYearFrom(text) {
  const m = /\(\s*(?:born|n\.|născut[ăa]?)[^)]*?(\d{4})/i.exec(text || '') || /\bborn[^.]{0,40}?(\d{4})/i.exec(text || '');
  return m ? Number(m[1]) : null;
}

async function search(lang, query) {
  const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&list=search&srlimit=6&srprop=snippet&srsearch=${encodeURIComponent(query)}`;
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
  let expected = null;
  if (p.birthDate && /^\d{4}/.test(p.birthDate)) expected = Number(p.birthDate.slice(0, 4));
  else if (p.age != null) expected = THIS_YEAR - Number(p.age);
  const mine = words(p.name);
  const parts = String(p.name || '').split(/\s+/).filter(Boolean);
  const names = [p.name];
  if (parts.length > 2) names.push(`${parts[0]} ${parts[parts.length - 1]}`);
  for (const lang of ['en', 'ro']) {
    const role = p.kind === 'referee' ? (lang === 'en' ? 'football referee' : 'arbitru de fotbal') : (lang === 'en' ? 'football manager' : 'antrenor de fotbal');
    const seen = new Set();
    for (const nm of names) {
      for (const q of [`${nm} ${role}`, `${nm} ${p.team || p.country || ''} ${role}`]) {
        for (const hit of await search(lang, q)) {
          if (seen.has(hit.title)) continue;
          seen.add(hit.title);
          const tw = words(hit.title);
          if (!mine.some((w) => tw.includes(w))) continue;
          const art = await article(lang, hit.title);
          if (!art) continue;
          const intro = art.text.slice(0, 800);
          const ok = p.kind === 'referee'
            ? /referee|arbitru|arbitre|schiedsrichter|árbitro/i.test(intro)
            : /manager|coach|antrenor|entraîneur|trainer|allenatore|entrenador/i.test(intro);
          if (!ok) continue;
          const by = birthYearFrom(intro);
          if (expected != null && by != null && Math.abs(by - expected) > 1) continue;
          return { lang, ...art, birthYear: by };
        }
        await sleep(150);
      }
    }
  }
  return null;
}

async function wikidataBlock(qid) {
  if (!qid) return '';
  const j = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const ent = j && j.entities && j.entities[qid];
  if (!ent) return '';
  const born = ent.claims && ent.claims.P569 && ent.claims.P569[0] && ent.claims.P569[0].mainsnak && ent.claims.P569[0].mainsnak.datavalue && ent.claims.P569[0].mainsnak.datavalue.value;
  return born && born.time ? `Wikidata ${qid}:\n- born: ${born.time.slice(1, 11)}` : '';
}

let found = 0;
for (const p of staff) {
  let body;
  try {
    const page = await findPage(p);
    if (!page) {
      body = `NO_WIKIPEDIA_PAGE for ${p.kind} "${p.name}" (${p.team || p.country || '?'}, age ${p.age}). Use at most one web search; if nothing reliable turns up, write the file with funfacts [] and checkedAt.\n`;
    } else {
      found++;
      const wd = await wikidataBlock(page.qid);
      body = [`Source: https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, `Matched: ${page.title} (born ${page.birthYear || '?'}) for ${p.kind} ${p.name}`, wd, '', page.text.slice(0, MAX_TEXT)].join('\n');
    }
  } catch (e) {
    body = `RESOLVER_ERROR for ${p.kind} "${p.name}": ${e.message}. Search the web instead.\n`;
  }
  writeFileSync(`${OUT}/${p.kind}-${p.key}.txt`, body, 'utf8');
  console.log(`${p.kind} ${p.key} ${p.name}: ${body.split('\n')[0].slice(0, 100)}`);
  await sleep(200);
}
console.log(`${found}/${staff.length} matched to an article.`);
