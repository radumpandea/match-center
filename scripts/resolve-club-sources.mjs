// Deterministic, no AI, no API-Football calls: for each club the "Build Player Facts" run is
// about to research, find its Wikipedia article and write the text (plus Wikidata's founding
// date and home ground) to .club-sources/<teamId>.txt (not committed). The researcher READS
// that file instead of searching the web.
//
// Matching: Wikipedia search ("<name> football club"); the candidate must be a football club
// (its intro says so) and its title must share a real word with the club name. The ground's
// name from the pack, when present, must appear in the article -- a cheap guard against
// same-named clubs in other countries. Romanian Wikipedia is tried when English has nothing.
//
// Env: CLUBS = JSON array of {teamId, name, venue, city}. Requires Node 18+.

import { mkdirSync, writeFileSync } from 'node:fs';

const OUT = '.club-sources';
const MAX_TEXT = 14000;
const UA = { 'User-Agent': 'match-center-club-facts/1.0 (https://github.com/radumpandea/match-center)' };

let clubs;
try { clubs = JSON.parse(process.env.CLUBS || '[]'); } catch { clubs = []; }
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
const words = (s) => strip(s).replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length >= 3 && !['fc', 'afc', 'club', 'the', 'and', 'des', 'del', 'der', 'cf', 'sc'].includes(w));

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

async function findPage(c) {
  const mine = words(c.name);
  const ground = c.venue ? words(c.venue).slice(0, 2) : [];
  for (const lang of ['en', 'ro']) {
    const kind = lang === 'en' ? 'football club' : 'club de fotbal';
    const seen = new Set();
    for (const q of [`${c.name} ${kind}`, `${c.name} ${c.city || ''} ${kind}`]) {
      for (const hit of await search(lang, q)) {
        if (seen.has(hit.title)) continue;
        seen.add(hit.title);
        const tw = words(hit.title);
        if (!mine.some((w) => tw.includes(w))) continue;
        const art = await article(lang, hit.title);
        if (!art) continue;
        const intro = art.text.slice(0, 900);
        if (!/football (club|team)|association football|soccer|club de fotbal|echipă de fotbal|club de football/i.test(intro)) continue;
        if (/national (football )?team|women'?s|reserves|\bU-?\d{2}\b/i.test(art.title)) continue;
        // when the pack names the ground, the article should mention it (any distinctive word of it)
        if (ground.length && !ground.some((w) => strip(art.text).includes(w))) continue;
        return { lang, ...art };
      }
      await sleep(150);
    }
  }
  return null;
}

async function wikidataBlock(qid) {
  if (!qid) return '';
  const j = await getJSON(`https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`);
  const ent = j && j.entities && j.entities[qid];
  if (!ent) return '';
  const claims = ent.claims || {};
  const val = (st) => st && st.mainsnak && st.mainsnak.datavalue && st.mainsnak.datavalue.value;
  const lines = [`Wikidata ${qid}:`];
  const inc = val((claims.P571 || [])[0]);
  if (inc && inc.time) lines.push(`- founded: ${inc.time.slice(1, 11)}`);
  const home = val((claims.P115 || [])[0]);
  if (home && home.id) {
    const lj = await getJSON(`https://www.wikidata.org/w/api.php?action=wbgetentities&format=json&props=labels&languages=en&ids=${home.id}`);
    const label = lj && lj.entities && lj.entities[home.id] && lj.entities[home.id].labels && lj.entities[home.id].labels.en;
    if (label) lines.push(`- home ground: ${label.value}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

let found = 0;
for (const c of clubs) {
  let body;
  try {
    const page = await findPage(c);
    if (!page) {
      body = `NO_WIKIPEDIA_PAGE for "${c.name}" (${c.city || '?'}, ground ${c.venue || '?'}). Use at most one web search; if nothing reliable turns up, write the file with facts [] and checkedAt.\n`;
    } else {
      found++;
      const wd = await wikidataBlock(page.qid);
      body = [`Source: https://${page.lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`, `Matched: ${page.title} for ${c.name}`, wd, '', page.text.slice(0, MAX_TEXT)].join('\n');
    }
  } catch (e) {
    body = `RESOLVER_ERROR for "${c.name}": ${e.message}. Search the web instead.\n`;
  }
  writeFileSync(`${OUT}/${c.teamId}.txt`, body, 'utf8');
  console.log(`${c.teamId} ${c.name}: ${body.split('\n')[0].slice(0, 110)}`);
  await sleep(200);
}
console.log(`${found}/${clubs.length} clubs matched to an article.`);
