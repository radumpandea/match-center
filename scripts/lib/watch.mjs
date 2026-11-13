// "De urmărit" per team, computed from data already in the pack (no API call, no AI):
//   - suspension risk: a player one yellow card away from an automatic suspension, for competitions whose
//     accumulation rule is VERIFIED (see RULES below). A competition without an entry gets no suspension
//     lines at all: a wrong "he is one card from a ban" on air is worse than none.
//   - cards: players with 3+ yellow cards in the league this season, as a plain fact (no rule involved).
// squad[].stats.yellow / .apps come from API-Football for the match's own league (statRowFor in
// prefetch-preview.mjs), so they are the league's count, not cups' or the national team's.
//
// Verified rules (checked 12 Nov 2026):
//   Premier League: 5 yellows within the first 19 league matches = 1 match, 10 within the first 32 = 2 matches,
//     15 in the season = 3 matches (Premier League handbook as summarised by Yahoo Sports, GiveMeSport,
//     matchxi.com, bet365 news; all agree).
//   Ligue 1: 5 yellows = 1 automatic one-match suspension, from 2025/26 (ligue1.com, "Match Suspensions: New
//     Changes to Card Accumulation Rule in 2025-2026"; the article does not say what happens at 10, so only the
//     first threshold is used).
//   Superliga (13 Nov 2026, from the official text the user supplied: FRF Regulamentul Disciplinar, actualizat
//     ianuarie 2017, https://www.frf.ro/wp-content/uploads/2018/07/RD-actualizat-01.2017.pdf, art. 41 pct. 2.1):
//     a warning in four different matches of the same competition = automatic suspension for the next match;
//     the same at the 7th and the 9th warning; from the 10th warning on every further yellow = a suspension.
//     Counts are per competition (art. 40 pct. 1: cups are separate), and the regular-season warnings are NOT
//     carried into the play-off / play-out (art. 40 pct. 3), where the counters start again. The stats here
//     cover the whole league season and play-off round labels look like "Etapa 3", so the rule is applied
//     only to matches played July-December and January-February, before the play-off can start. Two yellows in
//     one match are a red and both yellows are cancelled (art. 41 pct. 2): the API may still count them, so
//     the panel carries an extra note for these lines. This is the 2017 text: if the FRF changed the
//     thresholds since, update here.
// NOT verified, deliberately absent: Liga 2 (play-off format not checked), LaLiga, Serie A, Bundesliga,
// Primeira Liga, UEFA competitions. Add an entry here only from an official text.

const RULES = {
  'Premier League': (y, round) => {
    if (y === 4 && round != null && round <= 19) return { threshold: 5, ban: 1, byRound: 19 };
    if (y === 9 && round != null && round <= 32) return { threshold: 10, ban: 2, byRound: 32 };
    if (y === 14) return { threshold: 15, ban: 3, byRound: null };
    return null;
  },
  'Ligue 1': (y) => (y === 4 ? { threshold: 5, ban: 1, byRound: null } : null),
  // the card about to come is warning y + 1: a ban at 4, 7, 9 and at every one from the 10th
  'Superliga': (y, round, doc) => {
    const month = new Date((doc && doc.kickoff) || NaN).getMonth() + 1;
    if (!Number.isFinite(month) || (month >= 3 && month <= 6)) return null;   // play-off / play-out window
    if (round == null || round > 30) return null;
    const next = y + 1;
    return next === 4 || next === 7 || next === 9 || next >= 10 ? { threshold: next, ban: 1, byRound: null, rule: 'frf' } : null;
  },
};

function roundNumber(doc) {
  const m = String((doc.competition && doc.competition.round) || '').match(/(\d+)\s*$/);
  return m ? Number(m[1]) : null;
}

export function computeWatch(doc) {
  let changed = false;
  const rule = RULES[doc.competition && doc.competition.name];
  const round = roundNumber(doc);
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t) continue;
    const out = [];
    const absent = new Set((t.absences || []).filter((a) => a.reason === 'suspension').map((a) => String(a.name || '').toLowerCase()));
    const rows = (t.squad || [])
      .filter((p) => p && p.name && p.stats && Number.isFinite(Number(p.stats.yellow)) && !absent.has(p.name.toLowerCase()))
      .map((p) => ({ p, y: Number(p.stats.yellow), apps: Number.isFinite(Number(p.stats.apps)) ? Number(p.stats.apps) : null }));
    for (const { p, y, apps } of rows) {
      const r = rule ? rule(y, round, doc) : null;
      if (r) out.push({ kind: 'suspension', name: p.name, apiId: p.apiId != null ? p.apiId : null, yellows: y, apps, threshold: r.threshold, ban: r.ban, byRound: r.byRound, ...(r.rule ? { rule: r.rule } : {}) });
    }
    const atRisk = new Set(out.map((o) => o.name));
    rows.filter((x) => x.y >= 3 && !atRisk.has(x.p.name)).sort((a, b) => b.y - a.y || (b.apps || 0) - (a.apps || 0)).slice(0, 3)
      .forEach(({ p, y, apps }) => out.push({ kind: 'cards', name: p.name, apiId: p.apiId != null ? p.apiId : null, yellows: y, apps }));
    if (JSON.stringify(out) !== JSON.stringify(t.watch || [])) {
      if (out.length) t.watch = out; else delete t.watch;
      changed = true;
    }
  }
  return changed;
}
