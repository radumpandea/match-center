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
  ['GSP.ro', 'https://www.gsp.ro/rss'],
  ['Digi Sport', 'https://www.digisport.ro/rss'],
  ['Sport.ro', 'https://www.sport.ro/rss.xml'],
  ['ProSport', 'https://www.prosport.ro/rss.xml'],
  ['Fanatik Superliga', 'https://www.fanatik.ro/rss/superliga'],
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
    const first = entryItems[0];
    let sampleTitle = null, samplePub = null;
    if (first) {
      sampleTitle = decodeEntities((first[1].match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '');
      samplePub = (first[1].match(/<(?:pubDate|published|updated)>([\s\S]*?)<\/(?:pubDate|published|updated)>/) || [])[1] || null;
    }
    console.log(`${r.ok ? 'OK  ' : 'FAIL'} [${r.status}] ${name} -- ${entryItems.length} item(s)${sampleTitle ? ` | "${sampleTitle.slice(0, 70)}" (${samplePub})` : ''}`);
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
