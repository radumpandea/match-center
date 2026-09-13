// Temporary: probe candidate RSS feed URLs (real outlets, not Google News
// search) for the 8 tracked leagues -- HTTP status, item count, a sample
// title + date, so we only wire in feeds that actually work today.
const CANDIDATES = [
  // General / England
  ['BBC Sport Football', 'http://feeds.bbci.co.uk/sport/football/rss.xml'],
  ['Sky Sports Football', 'https://www.skysports.com/rss/12040'],
  ['The Guardian Football', 'https://www.theguardian.com/football/rss'],
  // France
  ["L'Équipe Football", 'https://www.lequipe.fr/rss/actu_rss_Football.xml'],
  ['RMC Sport Football', 'https://rmcsport.bfmtv.com/rss/football/'],
  // Spain
  ['Marca Futbol', 'https://e00-marca.uecdn.es/rss/futbol/primera-division.xml'],
  ['AS Primera', 'https://as.com/rss/futbol/primera.xml'],
  // Italy
  ['Gazzetta Calcio', 'https://www.gazzetta.it/rss/calcio.xml'],
  ['Corriere dello Sport', 'https://www.corrieredellosport.it/rss/calcio.xml'],
  // Germany
  ['Kicker Bundesliga', 'https://newsfeed.kicker.de/news/bundesliga'],
  ['Kicker 2.Bundesliga', 'https://newsfeed.kicker.de/news/2bundesliga'],
  ['Bundesliga.com', 'https://www.bundesliga.com/en/bundesliga/rss'],
  // Romania
  ['Digi Sport', 'https://www.digisport.ro/rss'],
  ['GSP.ro (feed)', 'https://www.gsp.ro/feed'],
  ['GSP.ro (rss.xml)', 'https://www.gsp.ro/rss.xml'],
  ['ProSport (feed)', 'https://www.prosport.ro/feed'],
  ['Fanatik (feed)', 'https://www.fanatik.ro/feed/'],
  ['Sport.ro (feed)', 'https://www.sport.ro/feed'],
  // Italy retest
  ['Football Italia', 'https://www.football-italia.net/rss.xml'],
  ['Sky Sport IT Calcio', 'https://sport.sky.it/rss/calcio.xml'],
  ['ANSA Calcio', 'https://www.ansa.it/sito/notizie/sport/calcio/calcio_rss.xml'],
  // France retest
  ["L'Équipe (alt path)", 'https://dwh.lequipe.fr/api/edito/rss?path=/Football'],
  ['Foot Mercato', 'https://www.footmercato.net/rss'],
];

function decodeEntities(s) {
  return String(s || '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, dd) => String.fromCodePoint(parseInt(dd, 10)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
    .replace(/<[^>]+>/g, '').trim();
}

async function probe(name, url) {
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (match-center rss probe)' }, redirect: 'follow' });
    const xml = await r.text();
    const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/g)];
    const entryItems = items.length ? items : [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)];   // Atom fallback
    const samples = entryItems.slice(0, 3).map((it) => {
      const t = decodeEntities((it[1].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
      const p = (it[1].match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/) || [])[1] || '?';
      return `"${t.slice(0, 55)}" (${p})`;
    });
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} [${r.status}] ${name} -- ${entryItems.length} item(s)`);
    samples.forEach((s) => console.log(`       ${s}`));
  } catch (e) {
    console.log(`ERR  ${name} -- ${e.message}`);
  }
}

async function main() {
  for (const [name, url] of CANDIDATES) {
    await probe(name, url);
  }
}
main();
