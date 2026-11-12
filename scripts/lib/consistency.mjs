// Deterministic consistency checks on a match pack: the kinds of mistakes found by hand so far (a story saying two
// players are not related while their own funfacts say they are brothers; a coach that is not the team's coach;
// a referee left as an initial; a citation that points at nothing). Returns warnings (strings), never errors:
// each one is a reason to look, not proof. Used by scripts/validate-match.mjs, so every workflow that validates a
// pack prints them.

const REL = /\b(frate|frați|fratele|fratelui|tatăl|tatălui|fiul|fiului|vărul|vărului|nepotul|nepotului|unchiul|rudă|rude|înrudit)\b/i;
const NOT_REL = /(?<![\p{L}])(nu (?:sunt|e|este|au)(?: [\p{L}]+){0,2} (?:rude|rudă|frați|înrudiți|înrudit)|fără (?:nicio )?legătur[ăa] de (?:rudenie|familie|sânge)|nu au (?:nicio )?legătur[ăa] de (?:rudenie|familie)|nu sunt din aceeași familie)/iu;

function bulletTexts(d) {
  const out = [];
  for (const s of d.storyOfTheMatch || []) out.push({ where: 'storyOfTheMatch', text: s });
  for (const side of ['home', 'away']) {
    const t = d.teams && d.teams[side];
    if (!t) continue;
    for (const st of t.stories || []) for (const b of st.bullets || []) out.push({ where: `teams.${side}.stories`, text: b, title: st.title });
    for (const b of t.clubFacts || []) out.push({ where: `teams.${side}.clubFacts`, text: b });
  }
  for (const b of (d.venue && d.venue.stories) || []) out.push({ where: 'venue.stories', text: b });
  return out.filter((x) => typeof x.text === 'string');
}

const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const lastWord = (s) => strip(s).trim().split(/\s+/).pop();

export function consistencyWarnings(d) {
  const w = [];
  const texts = bulletTexts(d);
  const nSources = (d.sources || []).length;

  // 1. citations "[n]" must point at an existing source
  for (const { where, text } of texts) {
    for (const m of text.matchAll(/\[(\d{1,2})\]/g)) {
      if (Number(m[1]) < 1 || Number(m[1]) > nSources) w.push(`${where}: citation [${m[1]}] but sources[] has ${nSources} entr${nSources === 1 ? 'y' : 'ies'}: "${text.slice(0, 60)}…"`);
    }
  }

  // 2. a referee that is only an initial and a surname
  const ref = d.referee && d.referee.name;
  if (ref && /^[A-ZÀ-Ý]\.\s/.test(ref)) w.push(`referee "${ref}" is abbreviated: use the full name`);

  // 3. "antrenorul X" in a text where X is neither team's coach (former coaches are skipped)
  const matchTexts = texts.filter((x) => x.where === 'storyOfTheMatch' || x.where.endsWith('.stories'));
  const thisYear = new Date(d.kickoff || Date.now()).getFullYear();
  const coaches = ['home', 'away'].map((s) => d.teams && d.teams[s] && d.teams[s].coach && d.teams[s].coach.name).filter((n) => n && n !== 'n/d');
  if (coaches.length) {
    for (const { where, text } of matchTexts) {
      // a text that dates something to an earlier year is history, not the current coach
      if ((text.match(/\b(?:19|20)\d\d\b/g) || []).some((y) => Number(y) < thisYear - 1)) continue;
      for (const m of text.matchAll(/(?<![\p{L}])(fostul|fosta|fost|succesor(?:ul)?(?: lui)?|predecesor(?:ul)?(?: lui)?|dup[ăa])?\s*antrenor(?:ul)?\s+([A-ZĂÂÎȘȚ][\p{L}'-]+(?:\s+[A-ZĂÂÎȘȚ][\p{L}'-]+)?)/gu)) {
        if (m[1]) continue;
        const name = m[2];
        if (!coaches.some((c) => name.split(/\s+/).some((p) => strip(c).includes(strip(p))))) {
          w.push(`${where}: "antrenorul ${name}" is not ${coaches.join(' / ')}`);
        }
      }
    }
  }

  // 4. "they are not related" while a player's funfacts speak of a relative
  const squad = ['home', 'away'].flatMap((s) => ((d.teams && d.teams[s] && d.teams[s].squad) || []).map((p) => ({ p, s })));
  for (const { where, text, title } of texts) {
    if (!NOT_REL.test(text)) continue;
    const ctx = strip((title || '') + ' ' + text);
    const named = squad.filter(({ p }) => p.name && lastWord(p.name).length > 3 && ctx.includes(lastWord(p.name)));
    const withRel = named.filter(({ p }) => (p.funfacts || []).some((f) => REL.test(f)));
    if (withRel.length) w.push(`${where}: says players are not related, but the funfacts of ${withRel.map(({ p }) => p.name).join(', ')} mention a relative: "${text.slice(0, 70)}…"`);
    // two squad members with the same surname named in the text: a denial of kinship is worth a second look
    const bySurname = {};
    for (const { p } of named) (bySurname[lastWord(p.name)] = bySurname[lastWord(p.name)] || []).push(p.name);
    for (const [sn, names] of Object.entries(bySurname)) {
      if (names.length > 1 && !withRel.length) w.push(`${where}: denies a family link while two squad members share the surname "${sn}" (${names.join(', ')}): verify`);
    }
  }

  // 5-7. lineups
  for (const side of ['home', 'away']) {
    const t = d.teams && d.teams[side];
    if (!t) continue;
    for (const key of ['confirmedXI', 'predictedXI']) {
      const xi = t[key] || [];
      if (!xi.length) continue;
      const abbr = xi.filter((x) => x && /^[A-ZÀ-Ý]\.\s/.test(x.name || '')).map((x) => x.name);
      if (abbr.length && d.researchDepth === 'deep') w.push(`teams.${side}.${key}: abbreviated names ${abbr.join(', ')}`);
      const nums = xi.map((x) => x && x.number).filter((n) => n != null);
      const dup = nums.filter((n, i) => nums.indexOf(n) !== i);
      if (dup.length) w.push(`teams.${side}.${key}: duplicate shirt number(s) ${[...new Set(dup)].join(', ')}`);
      const have = new Set((t.squad || []).map((p) => p.apiId).filter((x) => x != null));
      const missing = xi.filter((x) => x && x.apiId != null && have.size && !have.has(x.apiId)).map((x) => x.name);
      if (missing.length) w.push(`teams.${side}.${key}: ${missing.join(', ')} not in squad[]`);
    }
  }

  // 8. ages that disagree with the birth date by more than a year
  const ko = new Date(d.kickoff || Date.now());
  for (const { p, s } of squad) {
    if (!p.birthDate || p.age == null) continue;
    const b = new Date(p.birthDate);
    if (isNaN(b)) continue;
    let age = ko.getFullYear() - b.getFullYear();
    if (ko.getMonth() < b.getMonth() || (ko.getMonth() === b.getMonth() && ko.getDate() < b.getDate())) age--;
    if (Math.abs(age - p.age) > 1) w.push(`teams.${s}.squad: ${p.name} age ${p.age} but born ${p.birthDate} (= ${age})`);
  }

  // 9. news dated after the pack was written (+1 day) or after kick-off
  const gen = d.kickoff ? new Date(d.kickoff).getTime() : null;
  for (const side of ['home', 'away']) {
    for (const n of (d.teams && d.teams[side] && d.teams[side].news) || []) {
      const t = n.date ? new Date(n.date).getTime() : null;
      if (t && gen && t > gen + 86400000) w.push(`teams.${side}.news: "${(n.text || '').slice(0, 50)}…" dated ${n.date}, after kick-off`);
    }
  }

  // 10. a deep pack with a coach left as n/d
  if (d.researchDepth === 'deep') {
    for (const side of ['home', 'away']) {
      const c = d.teams && d.teams[side] && d.teams[side].coach;
      if (!c || !c.name || c.name === 'n/d') w.push(`teams.${side}.coach is n/d in a deep pack`);
    }
  }
  return w;
}
