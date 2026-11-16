// Run: node tests/national-squad.test.mjs
import assert from 'node:assert/strict';
import { articleTitle, noteCoversMatch, parseSquad, sameMan, splitSquad, squadNote, tokens } from '../scripts/lib/national-squad.mjs';

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

// shaped like the section "Current squad" of an article (wikitext)
const WIKI = `==Current squad==
The following 4 players were called up for the [[2026–27 UEFA Nations League]] matches against [[Portugal national football team|Portugal]] and [[Norway national football team|Norway]] on 14 and 17 November 2026.<ref name="x">cite</ref>
{{Football squad start}}
{{nat fs g player|no=1|pos=GK|name=[[Mads Hermansen]]|age={{birth date and age2|2026|11|17|2000|7|11}}|caps=10|goals=0|club=[[Leicester City F.C.|Leicester City]]}}
{{nat fs g player|no=3|pos=DF|name=[[Joakim Mæhle]]|age=...|caps=40|goals=3|club=[[VfL Wolfsburg|Wolfsburg]]}}
{{nat fs g player|no=10|pos=MF|name=[[Christian Eriksen]] {{captain|c}}|age=...|caps=140|goals=45|club=[[X]]}}
{{nat fs g player|no=22|pos=FW|name=[[Jesper Lindstrøm]]|age=...|caps=20|goals=2|club=[[Y]]}}
{{Football squad end}}
====Recent call-ups====
{{nat fs g player|no=|pos=FW|name=[[Kasper Dolberg]]|age=...}}`;

t('the note names the matches and the days', () => {
  const note = squadNote(WIKI);
  assert.match(note, /UEFA Nations League matches against Portugal and Norway on 14 and 17 November 2026/);
  assert.equal(noteCoversMatch(note, '2026-11-17'), true);
  assert.equal(noteCoversMatch(note, '2026-11-14'), true);
  assert.equal(noteCoversMatch(note, '2026-11-16'), false);
  assert.equal(noteCoversMatch(note, '2027-03-26'), false);
  assert.equal(noteCoversMatch('Squad for the matches on 26 and 29 March 2027.', '2026-11-17'), false);
});

t('the table is read, the captain mark is dropped; players under "Recent call-ups" are not part of it only when cut off by the caller', () => {
  const table = WIKI.split(/====Recent/)[0];
  const sq = parseSquad(table);
  assert.deepEqual(sq.map((p) => p.name), ['Mads Hermansen', 'Joakim Mæhle', 'Christian Eriksen', 'Jesper Lindstrøm']);
  assert.equal(sq[0].no, 1);
  assert.equal(sq[0].pos, 'GK');
});

t('names match even when the pack has the full civil name or other spellings of ø/ö', () => {
  assert.equal(sameMan('Andreas Jungdal', 'Andreas Kristoffer Jungdal'), true);
  assert.equal(sameMan('Jesper Lindstrøm', 'Jesper Lindström'), true);
  assert.equal(sameMan('Pierre-Emile Højbjerg', 'Pierre-Emile Kordt Højbjerg'), true);
  assert.equal(sameMan('Mathias Jensen', 'Thomas Jensen'), false);
  assert.deepEqual(tokens('Ștefan Țicu-Bălănescu'), ['stefan', 'ticu', 'balanescu']);
});

t('the pool is split into called-up and dropped, the XI is never dropped, called-up names missing from the pack are reported', () => {
  const squad = [{ name: 'Mads Hermansen' }, { name: 'Christian Dannemann Eriksen' }, { name: 'Kasper Dolberg Rasmussen' }, { name: 'Joakim Mæhle Pedersen' }, { name: 'Anton Gaaei' }];
  const called = [{ name: 'Mads Hermansen' }, { name: 'Joakim Mæhle' }, { name: 'Somebody Else' }];
  const r = splitSquad(squad, called, ['Anton Gaaei']);
  assert.deepEqual(r.keep.sort(), [0, 3, 4]);
  assert.deepEqual(r.drop.sort(), [1, 2]);
  assert.deepEqual(r.notInPack, ['Somebody Else']);
});

t('article titles', () => {
  assert.equal(articleTitle('Denmark'), 'Denmark_national_football_team');
  assert.equal(articleTitle('Rep of Ireland'), 'Republic_of_Ireland_national_football_team');
  assert.equal(articleTitle('FYR Macedonia'), 'North_Macedonia_national_football_team');
});

console.log(n + ' tests passed');
