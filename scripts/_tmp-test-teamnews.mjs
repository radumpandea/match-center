// Temporary integration check: import the real prefetch-preview module
// internals indirectly isn't possible (no exports), so this duplicates just
// enough to prove NEWS_SOURCES + filtering behave -- run the actual
// teamNews() logic path by requiring a tiny harness that mirrors it exactly,
// against a couple of real, currently-fixture-relevant team names.
import { NEWS_SOURCES } from './news-sources.mjs';

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, dd) => String.fromCodePoint(parseInt(dd, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '').trim();
}
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
}
function parseRssItems(xml, defaultSource) {
  const items = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1];
    const rawTitle = (block.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '';
    let title = decodeEntities(rawTitle);
    items.push({ title });
  }
  return items;
}

async function teamCuratedNews(teamName, comp) {
  const teamKey = norm(teamName);
  const out = [];
  for (const src of NEWS_SOURCES[comp] || []) {
    const r = await fetch(src.url, { headers: { 'user-agent': 'Mozilla/5.0 (match-center test)' } });
    if (!r.ok) { console.log(`  [${src.name}] HTTP ${r.status}`); continue; }
    const items = parseRssItems(await r.text());
    const matches = items.filter((it) => norm(it.title).includes(teamKey));
    console.log(`  [${src.name}] ${items.length} item(s) total, ${matches.length} matching "${teamName}"`);
    matches.slice(0, 2).forEach((m) => console.log(`      -> ${m.title}`));
    out.push(...matches);
  }
  return out;
}

async function main() {
  console.log('=== Arsenal (Premier League) ===');
  await teamCuratedNews('Arsenal', 'Premier League');
  console.log('=== FCSB (Superliga) ===');
  await teamCuratedNews('FCSB', 'Superliga');
  console.log('=== Borussia Dortmund (Bundesliga) ===');
  await teamCuratedNews('Borussia Dortmund', 'Bundesliga');
}
main();
