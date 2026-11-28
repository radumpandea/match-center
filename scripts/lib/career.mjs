// squad[].career is one string: "Club (2016–2022) · Club2 (2022–2023, împrumut) · Club3 (2023–prezent)".
// cleanCareerString() removes what must never be shown to a commentator (all three seen on 28 Nov 2026):
//   - a national team listed as a club ("Rep. Of Ireland (2018–prezent)"),
//   - the text "null" where a year should be ("Manchester United (2025–null)"),
//   - the same spell written twice.
// Everything else is left exactly as written (loan marks, editors' notes). Pure and idempotent; used by the prefetch
// (scripts/prefetch-preview.mjs, scripts/lib/enrich-pack.mjs) and by scripts/clean-careers.mjs.

const key = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  .replace(/&/g, ' and ').replace(/[.'’]/g, '').replace(/[-\s]+/g, ' ').trim();

// Country names as Intl knows them, plus the spellings API-Football uses. "Monaco" is left out on purpose: in a career it
// is AS Monaco (there is no Monaco national team in international football).
const NATIONS = (() => {
  const set = new Set();
  const names = new Intl.DisplayNames(['en'], { type: 'region' });
  for (let a = 65; a <= 90; a++) {
    for (let b = 65; b <= 90; b++) {
      const code = String.fromCharCode(a, b);
      try { const n = names.of(code); if (n && n !== code) set.add(key(n)); } catch { /* not a region code */ }
    }
  }
  [
    'rep of ireland', 'republic of ireland', 'northern ireland', 'england', 'scotland', 'wales', 'ivory coast', 'cote divoire',
    'cape verde islands', 'cape verde', 'turkey', 'turkiye', 'bosnia', 'bosnia herzegovina', 'bosnia and herzegovina',
    'fyr macedonia', 'north macedonia', 'macedonia', 'usa', 'united states', 'korea republic', 'south korea', 'korea dpr',
    'north korea', 'congo', 'congo dr', 'dr congo', 'curacao', 'czech republic', 'czechia', 'china', 'china pr', 'chinese taipei',
    'hong kong', 'macau', 'palestine', 'vietnam', 'laos', 'brunei', 'swaziland', 'eswatini', 'the gambia', 'gambia',
    'sao tome and principe', 'trinidad and tobago', 'antigua and barbuda', 'st kitts and nevis', 'saint kitts and nevis',
    'st lucia', 'saint lucia', 'st vincent and the grenadines', 'tahiti', 'zanzibar', 'kosovo', 'faroe islands', 'syria', 'iran', 'russia',
  ].forEach((n) => set.add(key(n)));
  set.delete('monaco');
  return set;
})();

// "France", "France U21", "Spain Olympic", "Japan W" -> true; "Ajax U21", "FC Andorra", "San Marino Academy" -> false.
export function isNationalName(name) {
  const base = key(name).replace(/\s+(u ?\d{2}|olympics?|w|women)$/, '').trim();
  return NATIONS.has(base);
}

const SPELL = /^(.*?)\s*\(([^()]*)\)$/;
const EMPTY = '(?:null|undefined|NaN)';

export function cleanCareerString(career) {
  if (typeof career !== 'string' || !career.trim()) return career;
  let spells = career.split(' · ').map((s) => s.trim()).filter(Boolean).map((raw) => {
    const m = SPELL.exec(raw);
    if (!m) return { name: raw, period: null, mark: '', openNull: null };
    const [core, ...rest] = m[2].split(',');
    const mark = rest.length ? ',' + rest.join(',') : '';
    let period = core.trim();
    let openNull = null, x;
    if ((x = period.match(new RegExp('^(\\d{4})\\s*[–-]\\s*' + EMPTY + '$')))) { openNull = +x[1]; period = x[1]; }
    else if ((x = period.match(new RegExp('^' + EMPTY + '\\s*[–-]\\s*(\\d{4})$')))) period = 'până în ' + x[1];
    else if (new RegExp(EMPTY).test(period)) period = '';
    return { name: m[1], period, mark, openNull };
  });

  spells = spells.filter((s) => !isNationalName(s.name));

  // "Club (2025–null)" and a complete spell at the same club. If only loans lie between the two, the player stayed with
  // the club: one spell, from the earlier year, in the earlier place. If a permanent move lies between, the two are
  // different spells and only the start year of the unfinished one is known.
  const isLoan = (s) => /împrumut|loan|leihe|prestito|prêt/i.test(s.mark);
  const dropped = new Set();
  for (let i = 0; i < spells.length; i++) {
    const s = spells[i];
    if (!s || s.openNull == null || dropped.has(i)) continue;
    const joinable = (n) => spells.slice(Math.min(i, n) + 1, Math.max(i, n)).every((b) => isLoan(b) || key(b.name) === key(s.name));
    const j = spells.map((_o, n) => n)
      .filter((n) => n !== i && !dropped.has(n) && spells[n].openNull == null && key(spells[n].name) === key(s.name) && joinable(n))
      .sort((a, b) => Math.abs(a - i) - Math.abs(b - i))[0];   // the nearest complete spell it can be joined with
    if (j === undefined) continue;             // nothing better to say: the start year alone stays
    const other = spells[j];
    const start = other.period && other.period.match(/^(\d{4})(?=\s*[–-]|$)/);
    if (start && s.openNull < +start[1]) {
      other.period = /[–-]/.test(other.period) ? other.period.replace(/^\d{4}/, String(s.openNull)) : s.openNull + '–' + other.period;
      if (i < j) { spells[i] = other; dropped.add(j); continue; }   // the joined spell takes the earlier place
    }
    dropped.add(i);
  }

  const seen = new Set();
  const out = [];
  spells.forEach((s, i) => {
    if (dropped.has(i)) return;
    const period = s.period == null ? null : s.period + (s.period ? s.mark : s.mark.replace(/^,\s*/, ''));
    const text = period ? `${s.name} (${period})` : s.name;
    if (seen.has(text)) return;
    seen.add(text);
    out.push(text);
  });
  return out.length ? out.join(' · ') : null;
}
