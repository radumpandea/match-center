// Curated RSS feeds from real outlets, per tracked competition (see COMPS in
// refresh-fixtures.mjs). Verified live before being added here (HTTP 200,
// items dated the day of the check) -- candidates that 404'd, redirected to
// a plain homepage with no feed, or came back with stale/empty content were
// left out rather than wired in and hoped to work:
//   - dead/no RSS: as.com's own paths (/rss/futbol/primera.xml, /rss/tags/...,
//     /rss/portada.xml, /rss.xml -- the working one is feeds.as.com's mrss-s
//     path, see LaLiga below), premierleague.com (every /rss* path 404s --
//     the official PL site has no public feed), ligue1.com (same), laliga.com
//     (same), legaseriea.it (/en|it/rss redirects to the plain homepage, no
//     feed), goal.com (every edition's /feeds* path 404s -- discontinued),
//     golazo.ro, superliga.ro (scraped directly by the research skill
//     instead, see SKILL.md), lpf.ro, football365.com, onefootball.com,
//     eurosport.fr, francefootball.fr, foot01.com, calciomercato.com,
//     tuttomercatoweb.com, so-foot.com, sofoot.com, actufoot.com,
//     footnews.eu, but-en-or.fr, francebleu.fr/rss/sport, footmercato.net's
//     /rss and /football/rss.xml (SSL handshake failure), lequipe.fr's old
//     rss path, gsp.ro's /feed and /rss/fotbal-intern, sport.ro's /feed and
//     /rss/fotbal-intern, corrieredellosport.it, fantacalcio.it, sport.sky.it
//   - expired/parked domain: getfrenchfootballnews.com
//   - stale content (feed exists but hasn't published in a year+):
//     gazzetta.it (both /rss/calcio.xml and /rss/home.xml -- 2023/2024
//     dated items despite HTTP 200), 90min.com
//   - blocked: sport.es (WAF 403)
//   - off-topic despite the name: sky sports' /rss/12040 -- mixes in darts
//     and rugby league, not football-only
// Re-verify before adding more: a feed that returns HTTP 200 with an empty
// or stale <item> list looks identical to a healthy one until you actually
// read the dates.
//
// Why this exists: prefetch-preview.mjs's existing teamNews() already pulls
// candidates from a Google News search per team (broad, but noisy and
// sometimes thin for smaller clubs). These are real editorial outlets'
// own feeds -- higher signal when a story is actually there -- fetched and
// filtered by team-name match at ZERO token cost (Level 1, deterministic),
// so the match-data-json skill's WebSearch budget (Level 2, ~12 or ~50
// lookups) doesn't have to be spent re-discovering team news that was
// already sitting in a feed. Keyed by the fixtures.json `comp` string.
export const NEWS_SOURCES = {
  'Premier League': [
    { name: 'BBC Sport', url: 'http://feeds.bbci.co.uk/sport/football/rss.xml' },
    { name: 'The Guardian', url: 'https://www.theguardian.com/football/rss' },
    { name: 'talkSPORT', url: 'https://talksport.com/football/feed/' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  'Ligue 1': [
    { name: "L'Équipe", url: 'https://dwh.lequipe.fr/api/edito/rss?path=/Football' },
    { name: 'RMC Sport', url: 'https://rmcsport.bfmtv.com/rss/football/' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  'LaLiga': [
    { name: 'Marca', url: 'https://e00-marca.uecdn.es/rss/futbol/primera-division.xml' },
    { name: 'Mundo Deportivo', url: 'https://www.mundodeportivo.com/rss/home.xml' },
    { name: 'AS', url: 'https://feeds.as.com/mrss-s/pages/as/site/as.com/portada' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  'Serie A': [
    { name: 'Football Italia', url: 'https://www.football-italia.net/rss.xml' },
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/sport/calcio/calcio_rss.xml' },
    { name: 'CalcioWeb', url: 'https://www.calcioweb.eu/feed' },
    { name: 'Il Napolista', url: 'https://www.ilnapolista.it/feed/' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  'Coppa Italia': [
    { name: 'Football Italia', url: 'https://www.football-italia.net/rss.xml' },
    { name: 'ANSA', url: 'https://www.ansa.it/sito/notizie/sport/calcio/calcio_rss.xml' },
    { name: 'CalcioWeb', url: 'https://www.calcioweb.eu/feed' },
    { name: 'Il Napolista', url: 'https://www.ilnapolista.it/feed/' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  'Bundesliga': [
    { name: 'Kicker', url: 'https://newsfeed.kicker.de/news/bundesliga' },
    { name: 'Bundesliga.com', url: 'https://www.bundesliga.com/en/bundesliga/rss' },
    { name: 'Sportschau', url: 'https://www.sportschau.de/fussball/index~rss2.xml' },
    { name: 'Transfermarkt', url: 'https://www.transfermarkt.de/rss/news' },
    { name: 'The Analyst', url: 'https://theanalyst.com/feed' },
  ],
  '2. Bundesliga': [
    { name: 'Kicker', url: 'https://newsfeed.kicker.de/news/2bundesliga' },
    { name: 'Sportschau', url: 'https://www.sportschau.de/fussball/index~rss2.xml' },
    { name: 'Transfermarkt', url: 'https://www.transfermarkt.de/rss/news' },
  ],
  'Superliga': [
    { name: 'Digi Sport', url: 'https://www.digisport.ro/rss' },
    { name: 'GSP', url: 'https://www.gsp.ro/rss.xml' },
    { name: 'Fanatik', url: 'https://www.fanatik.ro/feed/' },
    { name: 'Adevărul', url: 'https://adevarul.ro/rss/sport/' },
  ],
  'Liga 2': [
    { name: 'Digi Sport', url: 'https://www.digisport.ro/rss' },
    { name: 'ProSport', url: 'https://www.prosport.ro/feed' },
    { name: 'Adevărul', url: 'https://adevarul.ro/rss/sport/' },
  ],
};
