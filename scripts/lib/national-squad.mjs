// Pure helpers for scripts/trim-national-squad.mjs: read the "Current squad" section of a national team's Wikipedia
// article and match its players against a pack's squad[].
//
// Why: API-Football has no "called up for this window" list for national teams; its squad is a pool of everyone who was
// capped recently (35 names for Denmark on 17 Nov 2026 against 24 really called up). The call-up table on Wikipedia, with
// the note above it saying which matches it is for, is the reference (see the memory note on national-team squads).

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

// letters NFD does not split into base + accent
const FOLD = { 'ø': 'o', 'ö': 'o', 'æ': 'ae', 'œ': 'oe', 'å': 'a', 'ä': 'a', 'ü': 'u', 'ß': 'ss', 'đ': 'd', 'ð': 'd', 'ł': 'l', 'ı': 'i', 'þ': 'th' };
export function tokens(name) {
  const s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[øöæœåäüßđðłıþ]/g, (c) => FOLD[c]);
  return s.replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

function stripMarkup(s) {
  return String(s || '')
    .replace(/<ref[^>]*>[\s\S]*?<\/ref>/gi, '').replace(/<ref[^>]*\/>/gi, '')
    .replace(/\{\{[^{}]*\}\}/g, '')
    .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
    .replace(/'''?/g, '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
}

// The text between the section heading and the first table / player row = the note naming the matches.
export function squadNote(wikitext) {
  const i = wikitext.search(/\{\|\s*class|\{\{\s*(?:nat fs|football squad|fs)\b/i);
  const head = i < 0 ? wikitext : wikitext.slice(0, i);
  return stripMarkup(head.replace(/^=+[^=\n]+=+\s*$/m, ''));
}

// Does the note speak of the day of this match? "... on 14 and 17 November 2026" for a match on 17 Nov 2026.
export function noteCoversMatch(note, isoDate) {
  const [y, m, d] = isoDate.split('-').map(Number);
  const re = new RegExp('((?:\\d{1,2}(?:st|nd|rd|th)?\\s*(?:,|and|&|–|-|to)?\\s*)+)\\s*(' + MONTHS.join('|') + ')\\s+(\\d{4})', 'gi');
  let hit;
  while ((hit = re.exec(note))) {
    const month = MONTHS.indexOf(hit[2].toLowerCase()) + 1;
    if (month !== m || Number(hit[3]) !== y) continue;
    const days = (hit[1].match(/\d{1,2}/g) || []).map(Number);
    if (days.includes(d)) return true;
  }
  return false;
}

// Players of the table, in order: [{ name, no, pos }]. Works on the {{nat fs g player ...}} family of templates.
export function parseSquad(wikitext) {
  const out = [];
  const seen = new Set();
  const rows = wikitext.split(/\{\{\s*(?=nat fs|football squad|fs\s)/i).slice(1);
  for (const raw of rows) {
    const row = raw.split(/\n\s*\|\s*\}\}|\}\}\s*\n/)[0];
    // the value runs up to the next "| param =" (links and templates inside it carry pipes of their own)
    const m = row.match(/\|\s*name\s*=\s*([\s\S]*?)(?=\|\s*[a-z_]+\s*=|\n|$)/i);
    if (!m) continue;
    const name = stripMarkup(m[1]).replace(/\s*\((?:captain|c)\)\s*/i, '').trim();
    if (!name || seen.has(name)) continue;
    seen.add(name);
    const no = (row.match(/\|\s*no\s*=\s*(\d+)/i) || [])[1];
    const pos = (row.match(/\|\s*pos\s*=\s*([A-Za-z]+)/i) || [])[1];
    out.push({ name, no: no ? Number(no) : null, pos: pos || null });
  }
  return out;
}

// All tokens of the Wikipedia name are in the pack's full name ("Andreas Jungdal" in "Andreas Kristoffer Jungdal");
// failing that, same surname and same first initial.
export function sameMan(wikiName, packName) {
  const w = tokens(wikiName), p = tokens(packName);
  if (!w.length || !p.length) return false;
  if (w.every((x) => p.includes(x))) return true;
  return w.length > 1 && p.length > 1 && w[w.length - 1] === p[p.length - 1] && w[0][0] === p[0][0];
}

// squad: pack squad[] ({ name, ... }); called: parseSquad() result; keepNames: players that must stay (the XI).
// Returns { keep: [index], drop: [index], notInPack: [wikiName] }.
export function splitSquad(squad, called, keepNames = []) {
  const used = new Set();
  const keep = new Set();
  const notInPack = [];
  const pending = [];
  for (const w of called) {
    let idx = -1;
    for (let i = 0; i < squad.length; i++) {
      if (used.has(i)) continue;
      if (sameMan(w.name, squad[i].name)) { idx = i; break; }
    }
    if (idx >= 0) { used.add(idx); keep.add(idx); } else pending.push(w);
  }
  // Left over: a different first name (Wikipedia "Willi Orbán", API "Vilmos Tamás Orbán"). Accept when the surname is
  // shared with exactly one still-unmatched player of the pack and exactly one still-unmatched player of the table.
  const sur = (name) => tokens(name).slice(-1)[0];
  for (const w of pending) {
    const sameSurnameWiki = pending.filter((x) => sur(x.name) === sur(w.name));
    const cands = squad.map((p, i) => i).filter((i) => !used.has(i) && sur(squad[i].name) === sur(w.name));
    if (sameSurnameWiki.length === 1 && cands.length === 1) { used.add(cands[0]); keep.add(cands[0]); }
    else notInPack.push(w.name);
  }
  const kept = new Set([...keep]);
  squad.forEach((p, i) => { if (!kept.has(i) && keepNames.some((k) => k && sameMan(k, p.name))) kept.add(i); });
  const drop = squad.map((_p, i) => i).filter((i) => !kept.has(i));
  return { keep: [...kept], drop, notInPack };
}

// Wikipedia article for a team name as fixtures.json spells it.
const TITLE = {
  'Rep of Ireland': 'Republic of Ireland', 'Rep. of Ireland': 'Republic of Ireland', 'Republic of Ireland': 'Republic of Ireland',
  'Bosnia & Herzegovina': 'Bosnia and Herzegovina', 'Bosnia-Herzegovina': 'Bosnia and Herzegovina',
  'FYR Macedonia': 'North Macedonia', 'Türkiye': 'Turkey', 'Turkiye': 'Turkey', 'Czechia': 'Czech Republic',
  'Faroe Islands': 'Faroe Islands', 'USA': 'United States',
};
export function articleTitle(teamName) {
  const base = TITLE[teamName] || teamName;
  return base.replace(/ /g, '_') + '_national_football_team';
}
