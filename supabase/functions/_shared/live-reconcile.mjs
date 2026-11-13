// Live events from API-Football are not final when they first appear (measured on the Nations League evening of
// 13 Nov 2026, see scripts/live-probe.mjs):
//   - the scorer / assist often arrives 30-90 s after the goal; the minute is corrected by +-1 (sometimes 21 -> 26);
//   - a goal can turn into an own goal (and the player changes) after a minute;
//   - VAR removes goals and cards, sometimes without a trace, sometimes with a "Var / Goal cancelled" event;
//   - the order of two substitutions made at the same minute flips between calls.
// So an event cannot be identified by player + minute, and "gone from the list" must be shown, not hidden.
//
// reconcile(existing, incoming) compares what is stored with the list the API returned now and says what to insert,
// what to patch and what to mark as removed. Pure functions, no I/O, so tests/live-reconcile.test.mjs can run them.
// Used by supabase/functions/live-poll/index.ts.

const ENT = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };
export function decode(s) {
  if (typeof s !== 'string' || s.indexOf('&') < 0) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&(apos|quot|amp|lt|gt|nbsp);/g, (_m, n) => ENT[n]);
}

const clean = (s) => (typeof s === 'string' && s.trim() ? decode(s.trim()) : null);

// One entry of `fixtures[].events` -> the shape we store.
export function normalizeEvent(e) {
  return {
    type: String(e.type || ''),
    detail: e.detail == null ? null : String(e.detail),
    minute: Number.isFinite(e.time && e.time.elapsed) ? e.time.elapsed : null,
    extra: Number.isFinite(e.time && e.time.extra) ? e.time.extra : null,
    teamId: e.team && e.team.id != null ? e.team.id : null,
    playerId: e.player && e.player.id != null ? e.player.id : null,
    playerName: clean(e.player && e.player.name),
    assistId: e.assist && e.assist.id != null ? e.assist.id : null,
    assistName: clean(e.assist && e.assist.name),
    comments: clean(e.comments),
  };
}

const pKey = (id, name) => (id != null ? 'i' + id : name ? 'n' + name.toLowerCase() : '');
const pl = (e) => pKey(e.playerId, e.playerName);
const as = (e) => pKey(e.assistId, e.assistName);
const FIELDS = ['detail', 'minute', 'extra', 'playerId', 'playerName', 'assistId', 'assistName', 'comments'];

function sigExact(e) { return [e.type, e.teamId, pl(e), as(e), e.minute, e.extra == null ? '' : e.extra, e.detail].join('|'); }
function sigPair(e) { return [e.type, e.teamId, pl(e), as(e)].join('|'); }      // substitutions: who went off / on
function sigPlayer(e) { return [e.type, e.teamId, pl(e)].join('|'); }
function sigGroup(e) { return [e.type, e.teamId].join('|'); }

// existing: stored events that are still present ({ id, ...normalized fields }), incoming: normalized events from the API.
// Returns { inserts: [event], updates: [{ id, patch }], removals: [id] }.
export function reconcile(existing, incoming) {
  const usedIn = new Set();
  const pairs = [];                  // [existing, incoming]
  const left = existing.slice();

  function pass(sig, skip) {
    const rest = [];
    for (const ex of left) {
      if (skip && skip(ex)) { rest.push(ex); continue; }
      const k = sig(ex);
      let hit = -1;
      for (let i = 0; i < incoming.length; i++) {
        if (usedIn.has(i)) continue;
        if (skip && skip(incoming[i])) continue;
        if (sig(incoming[i]) === k) { hit = i; break; }
      }
      if (hit < 0) rest.push(ex); else { usedIn.add(hit); pairs.push([ex, incoming[hit]]); }
    }
    left.length = 0; rest.forEach((x) => left.push(x));
  }
  const isSub = (e) => e.type === 'subst';

  pass(sigExact);                                           // nothing changed
  pass(sigPair, (e) => !isSub(e));                          // a substitution: same two players (the minute may differ)
  pass(sigPlayer, (e) => isSub(e) || !pl(e));               // same player, minute / detail / assist corrected
  // what is left of one kind and team: the same event with the player filled in or changed (Thiaw -> own goal of Babic,
  // "no player yet" -> a name). Paired in order; if the counts differ the surplus is new or removed.
  {
    const groups = new Map();
    for (const ex of left) { const k = sigGroup(ex); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(ex); }
    const rest = [];
    for (const [k, list] of groups) {
      if (list[0].type === 'subst') { rest.push(...list); continue; }
      const cand = [];
      incoming.forEach((e, i) => { if (!usedIn.has(i) && sigGroup(e) === k) cand.push(i); });
      const n = Math.min(list.length, cand.length);
      for (let j = 0; j < n; j++) { usedIn.add(cand[j]); pairs.push([list[j], incoming[cand[j]]]); }
      rest.push(...list.slice(n));
    }
    left.length = 0; rest.forEach((x) => left.push(x));
  }

  const updates = [];
  for (const [ex, inc] of pairs) {
    const patch = {};
    for (const f of FIELDS) if ((ex[f] == null ? null : ex[f]) !== (inc[f] == null ? null : inc[f])) patch[f] = inc[f] == null ? null : inc[f];
    if (Object.keys(patch).length) updates.push({ id: ex.id, patch });
  }
  const inserts = incoming.filter((_e, i) => !usedIn.has(i));
  return { inserts, updates, removals: left.map((x) => x.id) };
}

// ---- rows <-> events (snake_case columns of mc_live_events)
export function toRow(fixtureId, e) {
  return {
    fixture_id: fixtureId, type: e.type, detail: e.detail, minute: e.minute, extra: e.extra, team_id: e.teamId,
    player_id: e.playerId, player_name: e.playerName, assist_id: e.assistId, assist_name: e.assistName, comments: e.comments,
  };
}
export function patchToRow(p) {
  const map = { detail: 'detail', minute: 'minute', extra: 'extra', playerId: 'player_id', playerName: 'player_name', assistId: 'assist_id', assistName: 'assist_name', comments: 'comments' };
  const out = {};
  for (const k of Object.keys(p)) out[map[k]] = p[k];
  return out;
}
export function fromRow(r) {
  return {
    id: r.id, type: r.type, detail: r.detail, minute: r.minute, extra: r.extra, teamId: r.team_id,
    playerId: r.player_id, playerName: r.player_name, assistId: r.assist_id, assistName: r.assist_name, comments: r.comments, edits: r.edits || 0,
  };
}

// Statuses after which a fixture will not change any more.
export const FINISHED = new Set(['FT', 'AET', 'PEN', 'PST', 'CANC', 'ABD', 'AWD', 'WO']);
export function fixtureRow(f) {
  const st = (f.fixture && f.fixture.status) || {};
  return {
    fixture_id: f.fixture.id,
    league_id: f.league && f.league.id != null ? f.league.id : null,
    home_team_id: f.teams && f.teams.home ? f.teams.home.id : null,
    away_team_id: f.teams && f.teams.away ? f.teams.away.id : null,
    home_name: f.teams && f.teams.home ? clean(f.teams.home.name) : null,
    away_name: f.teams && f.teams.away ? clean(f.teams.away.name) : null,
    status: st.short || null,
    elapsed: Number.isFinite(st.elapsed) ? st.elapsed : null,
    extra: Number.isFinite(st.extra) ? st.extra : null,
    home_goals: f.goals && Number.isFinite(f.goals.home) ? f.goals.home : null,
    away_goals: f.goals && Number.isFinite(f.goals.away) ? f.goals.away : null,
    kickoff: f.fixture.date || null,
    finished: FINISHED.has(st.short),
  };
}
