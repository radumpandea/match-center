// Pure helpers (no I/O, no network) that enrich a match pack from data it already holds or
// from API-Football rows handed in by the caller. Used by scripts/prefetch-preview.mjs.
//
//  - computeLinkLines(doc): fills squad[].linkLine from the head-to-head meetings that carry
//    goal / red-card events ("direct history vs this opponent"), deterministically.
//  - formatHonours(rows) / formatInjuries(rows): compact player extras from trophies?player=
//    and sidelined?player= responses.

const strip = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();

// "O. Dembélé" (event, abbreviated) vs "Ousmane Dembélé" (squad); also "Oso" vs "Oso".
export function nameMatches(eventName, squadName) {
  const e = strip(eventName).split(' ').filter(Boolean);
  const s = strip(squadName).split(' ').filter(Boolean);
  if (!e.length || !s.length) return false;
  const initials = [];
  while (e.length > 1 && e[0].length === 1) initials.push(e.shift());
  if (!e.length) return false;
  if (!e.every((w) => s.includes(w))) return false;
  return !initials.length || s.some((w) => w[0] === initials[0]);
}

const sameTeam = (a, b) => {
  const x = strip(a), y = strip(b);
  return !!x && !!y && (x === y || x.includes(y) || y.includes(x));
};

const ddmmyyyy = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${m[3]}.${m[2]}.${m[1]}` : String(iso || '');
};

function describe(list) {
  const byDate = new Map();
  for (const x of list) {
    if (!byDate.has(x.date)) byDate.set(x.date, []);
    if (x.minute != null) byDate.get(x.date).push(x.minute);
  }
  return [...byDate.entries()]
    .map(([date, mins]) => `${ddmmyyyy(date)}${mins.length ? ` (min. ${mins.join(', ')})` : ''}`)
    .join('; ');
}

// Returns true when it changed (or, with dry = true, would change) at least one linkLine.
export function computeLinkLines(doc, dry = false) {
  const meetings = ((doc.h2h && doc.h2h.recent) || []).filter((r) => r && Array.isArray(r.events) && r.events.length);
  if (!meetings.length) return false;
  const players = [];
  for (const side of ['home', 'away']) {
    for (const p of (doc.teams && doc.teams[side] && doc.teams[side].squad) || []) players.push({ side, p });
  }
  const agg = new Map();
  for (const m of meetings) {
    const sc = /^(.*) (\d+)-(\d+) (.*)$/.exec(m.score || '');
    if (!sc) continue;
    const teamOf = { home: sc[1], away: sc[4] };
    for (const e of m.events) {
      if ((e.type !== 'goal' && e.type !== 'red') || !e.player) continue;
      const cands = players.filter((x) => nameMatches(e.player, x.p.name));
      if (cands.length !== 1) continue;                    // unknown or ambiguous: say nothing
      const { side, p } = cands[0];
      // only what he did FOR his current club against the current opponent
      if (!sameTeam(teamOf[e.side], doc.teams[side].name)) continue;
      const rec = agg.get(p) || { side, goals: [], reds: [] };
      (e.type === 'goal' ? rec.goals : rec.reds).push({ date: m.date, minute: e.minute });
      agg.set(p, rec);
    }
  }
  let changed = false;
  for (const [p, rec] of agg) {
    if (p.linkLine) continue;
    const opp = doc.teams[rec.side === 'home' ? 'away' : 'home'].name;
    const n = meetings.length;
    // "ultimele N" only when every examined meeting has events; otherwise say what we actually counted
    const complete = n === ((doc.h2h.recent || []).length);
    const span = n === 1 ? (complete ? `În ultimul duel direct cu ${opp}` : `Într-un duel direct recent cu ${opp}`)
      : complete ? `În ultimele ${n} dueluri directe cu ${opp}` : `În ${n} dueluri directe recente cu ${opp}`;
    const bits = [];
    if (rec.goals.length) bits.push(`${rec.goals.length} ${rec.goals.length === 1 ? 'gol' : 'goluri'} — ${describe(rec.goals)}`);
    if (rec.reds.length) bits.push(`cartonaș roșu — ${describe(rec.reds)}`);
    if (!bits.length) continue;
    if (dry) return true;
    p.linkLine = `${span}: ${bits.join('; ')}.`;
    changed = true;
  }
  return changed;
}

const YOUTH = /\bu-?\d{2}\b|youth|junior|reserve|premier league 2|primavera|academy|u\d{2}|juvenil/i;
// friendlies and invitational cups add noise, not honours a commentator would quote
const MINOR = /gamper|friendl|florida cup|queensland|revello|tournoi|international champions cup|audi cup|emirates cup/i;
// API-Football names some national cups just "Cup" / "Super Cup": add the country so they are readable
const GENERIC = /^(super |league )?cup$/i;

// trophies?player= rows -> ["Ligue 1 ×3 (2022-23, 2023-24, 2024-25)", "Coupe de France (2023-24)", ...]
export function formatHonours(rows) {
  const groups = new Map();
  for (const r of rows || []) {
    if (!r || r.place !== 'Winner' || !r.league || YOUTH.test(r.league) || MINOR.test(r.league)) continue;
    const name = GENERIC.test(r.league) && r.country && !/^world$|^europe$/i.test(r.country) ? `${r.league} (${r.country})` : r.league;
    const g = groups.get(name) || [];
    if (r.season != null) g.push(String(r.season));
    groups.set(name, g);
  }
  return [...groups.entries()]
    .map(([league, seasons]) => ({ league, seasons: [...new Set(seasons)].sort().reverse(), n: seasons.length || 1 }))
    .sort((a, b) => b.n - a.n || String(b.seasons[0] || '').localeCompare(String(a.seasons[0] || '')))
    .slice(0, 8)
    .map(({ league, seasons, n }) => {
      const list = seasons.slice(0, 4).join(', ') + (seasons.length > 4 ? ', …' : '');
      return n > 1 ? `${league} ×${n}${list ? ` (${list})` : ''}` : `${league}${list ? ` (${list})` : ''}`;
    });
}

const INJURY = /injur|illness|surgery|fracture|ligament|muscle|strain|sprain|concussion|virus|covid|torn|rupture|fatigue|knock|bruise|tendon|hernia|groin|hamstring|knee|ankle|calf|thigh|back|foot|shoulder/i;

// sidelined?player= rows -> last 5 injuries [{type, start, end}], newest first
export function formatInjuries(rows) {
  return (rows || [])
    .filter((r) => r && r.type && INJURY.test(r.type) && !/suspend|coach|decision|international/i.test(r.type))
    .map((r) => ({ type: String(r.type), start: r.start ? String(r.start).slice(0, 10) : null, end: r.end ? String(r.end).slice(0, 10) : null }))
    .sort((a, b) => String(b.start || '').localeCompare(String(a.start || '')))
    .slice(0, 5);
}

// XI players of a pack (predicted or confirmed) as {side, p} entries
export function xiPlayers(doc) {
  const out = [];
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t) continue;
    const ids = new Set([].concat(t.predictedXI || [], t.confirmedXI || []).map((x) => x && x.apiId).filter((x) => x != null));
    for (const p of t.squad || []) if (p.apiId != null && ids.has(p.apiId)) out.push({ side, p });
  }
  return out;
}

// team id from the logo URL ("…/football/teams/95.png")
export function teamIdFromLogo(logo) {
  const m = /\/teams\/(\d+)\.png/.exec(logo || '');
  return m ? Number(m[1]) : null;
}

// Exact age on a given day from a birth date ("YYYY-MM-DD"). API-Football's own `age` field is
// not reliable (it comes out a year low for most players born after January), so the age shown
// is always derived from the birth date, on the day of the match.
export function ageOn(birthDate, onDate) {
  const b = /^(\d{4})-(\d{2})-(\d{2})/.exec(birthDate || '');
  const d = /^(\d{4})-(\d{2})-(\d{2})/.exec(onDate || '');
  if (!b || !d) return null;
  let age = Number(d[1]) - Number(b[1]);
  if (Number(d[2]) < Number(b[2]) || (Number(d[2]) === Number(b[2]) && Number(d[3]) < Number(b[3]))) age--;
  return age >= 14 && age <= 60 ? age : null;   // anything else is a bad birth date: keep the old value
}

// Sets age on every squad player and on the coach that has a birthDate; true when something changed.
export function applyAges(doc) {
  const on = (doc.kickoff || '').slice(0, 10) || new Date().toISOString().slice(0, 10);
  let changed = false;
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t) continue;
    for (const p of [...(t.squad || []), ...(t.coach ? [t.coach] : [])]) {
      const a = ageOn(p.birthDate, on);
      if (a != null && p.age !== a) { p.age = a; changed = true; }
    }
  }
  return changed;
}

// A lineup slot (predictedXI / confirmedXI / substitutes) written without a shirt number -- the
// deep build sometimes does -- shows its position label on the pitch disc instead of the number.
// Takes the number from the squad entry with the same apiId (else the same name); true when changed.
export function applyLineupNumbers(doc) {
  let changed = false;
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t || !Array.isArray(t.squad)) continue;
    for (const slot of [].concat(t.predictedXI || [], t.confirmedXI || [], t.substitutes || [])) {
      if (!slot || slot.number != null) continue;
      const p = (slot.apiId != null && t.squad.find((x) => x.apiId === slot.apiId)) ||
        t.squad.find((x) => x.name && x.name === slot.name);
      if (p && p.number != null) { slot.number = p.number; changed = true; }
    }
  }
  return changed;
}

// Squad players of a pack in research priority: likely starters first (both teams), then the
// matchday bench (when published), then everyone else by minutes played this season.
// With wholeSquad = false only the starters are returned.
export function squadByPriority(doc, wholeSquad) {
  const tiers = [[], [], []];
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t) continue;
    const xi = new Set([].concat(t.predictedXI || [], t.confirmedXI || []).map((x) => x && x.apiId).filter((x) => x != null));
    const bench = new Set((t.substitutes || []).map((x) => x && x.apiId).filter((x) => x != null));
    for (const p of t.squad || []) {
      if (p.apiId == null) continue;
      if (xi.has(p.apiId)) tiers[0].push({ side, p });
      else if (wholeSquad) (bench.has(p.apiId) ? tiers[1] : tiers[2]).push({ side, p });
    }
  }
  tiers[2].sort((a, b) => ((b.p.stats && b.p.stats.minutes) || 0) - ((a.p.stats && a.p.stats.minutes) || 0));
  return [].concat(tiers[0], tiers[1], tiers[2]);
}

// file-name key for a referee (they have no id in the data): "Willy Delajod" -> "willy-delajod"
export function refereeKey(name) {
  return strip(name).replace(/\s+/g, '-').replace(/^-+|-+$/g, '');
}

// API-Football (and some feeds) send HTML entities inside names: "L. O&apos;Nien", "M. N&apos;Diaye".
// decodeText() turns them into the real characters; decodeDeep() does it for every string of an object
// in place (URLs are left alone) and reports whether anything changed.
const NAMED = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };
export function decodeText(s) {
  if (typeof s !== 'string' || s.indexOf('&') < 0 || /^https?:\/\//i.test(s)) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (m, h) => { try { return String.fromCodePoint(parseInt(h, 16)); } catch { return m; } })
    .replace(/&#(\d+);/g, (m, d) => { try { return String.fromCodePoint(parseInt(d, 10)); } catch { return m; } })
    .replace(/&(apos|quot|amp|lt|gt|nbsp);/g, (m, n) => NAMED[n]);
}
export function decodeDeep(o) {
  let changed = false;
  const walk = (node) => {
    if (Array.isArray(node)) {
      for (let i = 0; i < node.length; i++) {
        if (typeof node[i] === 'string') { const v = decodeText(node[i]); if (v !== node[i]) { node[i] = v; changed = true; } }
        else if (node[i] && typeof node[i] === 'object') walk(node[i]);
      }
    } else if (node && typeof node === 'object') {
      for (const k of Object.keys(node)) {
        const v = node[k];
        if (typeof v === 'string') { const d = decodeText(v); if (d !== v) { node[k] = d; changed = true; } }
        else if (v && typeof v === 'object') walk(v);
      }
    }
  };
  walk(o);
  return changed;
}

// absences[] (API-Football injuries/suspensions plus what the editorial pass added) -> squad[].status, so a
// suspended, injured or doubtful player is marked on the pitch and on his card, not only listed in the
// absences panel. A player no longer in absences[] whose status has no note (nothing editorial to lose) goes
// back to "available". Returns true when something changed.
const ABS_STATUS = { injury: 'out', suspension: 'suspended', doubt: 'doubt' };
export function applyAbsenceStatus(doc) {
  let changed = false;
  for (const side of ['home', 'away']) {
    const t = doc.teams && doc.teams[side];
    if (!t) continue;
    const hit = new Set();
    for (const a of t.absences || []) {
      const want = ABS_STATUS[a && a.reason];
      if (!want || !a.name) continue;
      const cands = (t.squad || []).filter((p) => nameMatches(a.name, p.name));
      if (cands.length !== 1) continue;           // unknown or ambiguous: leave it
      const p = cands[0];
      hit.add(p);
      if (p.status !== want) { p.status = want; changed = true; }
      if (a.detail && p.statusNote !== a.detail) { p.statusNote = a.detail; changed = true; }
    }
    for (const p of t.squad || []) {
      if (!hit.has(p) && (p.status === 'out' || p.status === 'suspended' || p.status === 'doubt') && !p.statusNote) { p.status = 'available'; changed = true; }
    }
  }
  return changed;
}

// ---- squad[].career from transfers?player= ------------------------------------------------------
// players/teams (the base career string, "Club (2016–2022) · Club2 (2023–prezent)") only lists clubs
// where the API recorded appearances, so a loan or a short spell can be missing (Aouar at Roma) and the
// years follow seasons, not dates. transfers?player= gives every move with its date and type
// ("Loan", "Free", "€25M", "Back from loan", "N/A"). This rebuilds the string from that timeline and
// keeps the base clubs the transfer record knows nothing about (B teams, academies).
const keyOf = (n) => strip(n);
const parseBaseCareer = (str) => String(str || '').split(' · ').map((part) => {
  const m = /^(.*?)\s*\((\d{4})(?:[–-](\d{4}|prezent))?\)$/.exec(part.trim());
  return m ? { name: m[1], min: +m[2], max: m[3] === 'prezent' ? 'prezent' : (m[3] ? +m[3] : +m[2]) } : null;
}).filter(Boolean);

// transfers: [{ d: "2023-06-11", ty: "Free", i: { id, name }, o: { id, name } }] (compact form of the API rows)
export function careerFromTransfers(baseCareer, transfers, isNational = () => false, maxParts = 14) {
  const base = parseBaseCareer(baseCareer);
  const evs = (transfers || [])
    .filter((t) => t && t.d && ((t.i && t.i.name) || (t.o && t.o.name)))
    .map((t) => ({ y: +String(t.d).slice(0, 4), d: String(t.d).slice(0, 10), ty: String(t.ty || ''), i: t.i && t.i.name ? t.i.name : null, o: t.o && t.o.name ? t.o.name : null }))
    .filter((t) => Number.isInteger(t.y) && t.y > 1950)
    .sort((a, b) => a.d.localeCompare(b.d));
  if (!evs.length) return baseCareer || null;

  const spells = [];                 // { name, start, end, loan }
  const open = new Map();            // team key -> its open spell
  const opened = (name, start, loan) => { const s = { name, start, end: null, loan }; spells.push(s); open.set(keyOf(name), s); return s; };
  const closed = (name, y) => { const s = open.get(keyOf(name)); if (s) { s.end = y; open.delete(keyOf(name)); } return s; };

  for (const e of evs) {
    const back = /back|return/i.test(e.ty);
    const loan = !back && /loan/i.test(e.ty);
    if (back) {
      if (e.o) closed(e.o, e.y);
      if (e.i && !open.has(keyOf(e.i))) opened(e.i, null, false);   // the parent club, start unknown here
      continue;
    }
    if (e.o && !loan) {
      if (!open.has(keyOf(e.o))) opened(e.o, null, false);
      for (const [k, s] of [...open]) if (k === keyOf(e.o) || s.loan) { s.end = e.y; open.delete(k); }   // permanent move: leaves the old club, and any loan
    } else if (e.o && loan && !open.has(keyOf(e.o))) {
      opened(e.o, null, false);                                      // parent club of a loan, still the owner
    }
    if (e.i) opened(e.i, e.y, loan);
  }
  for (const s of open.values()) s.end = 'prezent';

  // base clubs: fill unknown starts, keep the ones the transfer record never mentions
  for (const s of spells) {
    const b = base.find((x) => keyOf(x.name) === keyOf(s.name));
    if (b && s.start == null) s.start = b.min;
  }
  for (const b of base) {
    if (isNational(b.name)) continue;
    if (!spells.some((s) => keyOf(s.name) === keyOf(b.name))) spells.push({ name: b.name, start: b.min, end: b.max, loan: false });
  }

  const clean = spells.filter((s) => s.name && !isNational(s.name));
  const sortYear = (s) => (s.start != null ? s.start : (typeof s.end === 'number' ? s.end - 0.5 : 0));
  clean.sort((a, b) => sortYear(a) - sortYear(b) || (a.loan ? 1 : 0) - (b.loan ? 1 : 0));

  const parts = clean.map((s) => {
    const loan = s.loan ? ', împrumut' : '';
    if (s.start == null) return s.end === 'prezent' ? `${s.name} (prezent${loan})` : `${s.name} (până în ${s.end}${loan})`;
    if (s.end === 'prezent') return `${s.name} (${s.start}–prezent${loan})`;
    return s.start === s.end ? `${s.name} (${s.start}${loan})` : `${s.name} (${s.start}–${s.end}${loan})`;
  });
  return parts.length ? parts.slice(-maxParts).join(' · ') : (baseCareer || null);
}
