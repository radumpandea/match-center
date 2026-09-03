# Source cheat-sheet — match-data-json

Quick reference for where each field of `docs/data/schema.json` is best sourced.
Fuller guidance is in `SKILL.md` (Pasul 1).

## Fetchable directly (no search-fragment workaround needed)
- **soccerstats.com** — standings, form, PPG, "Last 8", home/away goal splits, over/under,
  dedicated H2H page. Use for `form`, `h2h`, and calculated Opta-style facts. Any league.
  - League: `soccerstats.com/latest.asp?league=england` (england, france, spain, italy,
    germany, romania, ...)
  - Team: `soccerstats.com/teamstats.asp?league={lg}&stats=u{id}-{team}`
  - H2H: `soccerstats.com/h2h.asp?league={lg}&t1id={a}&t2id={b}` — IDs from
    `soccerstats.com/h2h_selection.asp?league={lg}`
- **superliga.ro** — the authoritative source for the Romanian SuperLiga. One club page
  (`superliga.ro/cluburi/{club}`) gives venue, coach, full squad by position with numbers +
  apps, team stats. Player pages add height, weight, preferred foot, Opta-style stats.
- **uefa.com** — official registered squad list per European tie:
  `uefa.com/{comp}/match/{id}--{a}-vs-{b}/lineups/`. `*` = List B (U21). This is the squad
  source for European games, not the club's general squad.
- **wikipedia.org** — individual player/coach page infobox: height + club career +
  international career (players); "Managerial career" with years + clubs (coaches). Often the
  single most efficient source. Check it first.

## Search-only (direct fetch blocks / 403)
- **transfermarkt** — best height & market-value database; read from search fragments.
- **fbref.com** — "Standard Stats — All Competitions" for the club/season: every player who
  logged an official minute. Use as a second check to drop paper-only squad members.
- **sofascore** — player profile shows height ("X is Y years old, Z cm tall"), usually
  visible straight from the search fragment. Team page has no heights and may be cached.

## Transfers / current squad
- **footmercato.net/club/{club}/effectif/** — shirt number, age, nationality, current-stats
  mini-table for the whole squad in one fetch. No height.
- **footmercato.net/tableau** (or club "actualité") — summer ins/outs with fees → `mercatoIn`
  / `mercatoOut`.

## Storylines / predictions
- **theanalyst.com** — Opta/Stats Perform's own site; closest tone to the "Opta Facts" style.
  For big-five leagues + UEFA, search `{A} v {B} preview theanalyst.com` — often has a
  supercomputer prediction and 5-10 ready narrative facts. Not available for smaller leagues.

## Probable XI
- maxifoot, VAVEL, Sports Mole, footmercato. If the match has already kicked off, look for
  the real lineup and put it in `confirmedXI` too.

## Accuracy
- Unknown → `null` / `"n/d"`, never invented.
- "First / return / record" claims need a source stating exactly that.
- News items: nothing older than 2-3 days; check the article's own date.
- Paraphrase press facts; no quote over 15 words; one quote per source max.
