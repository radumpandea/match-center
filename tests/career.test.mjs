// Run: node tests/career.test.mjs   (cases taken from the packs on 28 Nov 2026)
import assert from 'node:assert/strict';
import { cleanCareerString as clean, isNationalName } from '../scripts/lib/career.mjs';
import { careerFromTransfers } from '../scripts/lib/enrich-pack.mjs';

let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

t('"null" next to the complete spell, and a spell written twice (Lammens)', () => {
  assert.equal(
    clean('Club Brugge KV (2020–2023) · Antwerp (2023–2025) · Antwerp (2023–2025) · Manchester United (2025–null) · Manchester United (2025–prezent)'),
    'Club Brugge KV (2020–2023) · Antwerp (2023–2025) · Manchester United (2025–prezent)');
});

t('"null" with an earlier start keeps that start', () => {
  assert.equal(clean('Angers (2024–null) · Angers (2025–prezent)'), 'Angers (2024–prezent)');
});

t('only loans in between: one spell, in its chronological place', () => {
  assert.equal(
    clean('Chelsea (2019–null) · Norwich (2021–2022, împrumut) · Chelsea (2022) · Brighton (2022–2024)'),
    'Chelsea (2019–2022) · Norwich (2021–2022, împrumut) · Brighton (2022–2024)');
  assert.equal(
    clean('Watford (2013–null) · Watford (2014–null) · Wealdstone (2014, împrumut) · Watford (2015) · Wycombe (2015–2018)'),
    'Watford (2013–2015) · Wealdstone (2014, împrumut) · Wycombe (2015–2018)');
});

t('a permanent move in between: the two spells are not joined (no invented continuity)', () => {
  assert.equal(
    clean('Santos (2010–null) · Porto (2012–2016) · Santos (2017–2019)'),
    'Santos (2010) · Porto (2012–2016) · Santos (2017–2019)');
});

t('the unfinished spell joins the nearest one, not an old stay at the same club (Racing Santander)', () => {
  assert.equal(
    clean('Racing Santander (2008–2010) · Real Madrid (2010–2012) · Racing Santander (2026–null) · Racing Santander (2026–prezent)'),
    'Racing Santander (2008–2010) · Real Madrid (2010–2012) · Racing Santander (2026–prezent)');
});

t('"null" with nothing better becomes the start year; a null start becomes "până în"', () => {
  assert.equal(clean('Lille (2019–2020) · Angers (2025–null)'), 'Lille (2019–2020) · Angers (2025)');
  assert.equal(clean('Troyes (null–2016) · Lille (2016–2017, împrumut)'), 'Troyes (până în 2016) · Lille (2016–2017, împrumut)');
  assert.equal(clean('Angers (2025–null, împrumut)'), 'Angers (2025, împrumut)');
});

t('national teams are not clubs (Kelleher, Arcus), youth national teams too', () => {
  assert.equal(clean('Liverpool (2016–2024) · Rep. Of Ireland (2018–prezent) · Brentford (2025–prezent)'), 'Liverpool (2016–2024) · Brentford (2025–prezent)');
  assert.equal(clean('Lille (2016–2017) · Haiti (2016–prezent) · Bosnia & Herzegovina (2020–prezent) · France U21 (2019) · Equatorial-Guinea (2021)'), 'Lille (2016–2017)');
});

t('clubs that look like countries stay: Monaco, FC Andorra, club youth sides', () => {
  for (const c of ['Monaco (2022–prezent)', 'Monaco II (2019–2021)', 'FC Andorra (2023–2024)', 'San Marino Academy (2020)', 'Ajax U21 (2018–2019)']) assert.equal(clean(c), c);
  assert.equal(isNationalName('Monaco'), false);
  assert.equal(isNationalName('Japan W'), true);
});

t('a loan then a permanent move to the same club are two different spells and both stay', () => {
  const s = 'Auxerre (2017–2018, împrumut) · Auxerre (2018–2022)';
  assert.equal(clean(s), s);
});

t('clean strings are untouched, cleaning twice changes nothing, empty stays empty', () => {
  const s = 'Troyes II (2014–2015) · Estac Troyes (până în 2016) · Vitesse (2022–2024) · Angers (2024–prezent)';
  assert.equal(clean(s), s);
  const once = clean('A (2020–null) · A (2020–2021) · A (2020–2021) · France (2019–prezent)');
  assert.equal(clean(once), once);
  assert.equal(clean(null), null);
  assert.equal(clean(''), '');
  assert.equal(clean('Romania (2019–prezent)'), null);
});

t('the rebuild from transfers no longer produces an unfinished second spell', () => {
  const tr = (d, ty, i, o) => ({ d, ty, i: { name: i }, o: { name: o } });
  const out = careerFromTransfers('Antwerp (2023–2025) · Manchester United (2025–prezent)', [
    tr('2023-07-01', 'Loan', 'Antwerp', 'Club Brugge KV'),
    tr('2025-07-01', '€ 21M', 'Manchester United', 'Antwerp'),
    tr('2025-08-01', 'N/A', 'Manchester United', 'Antwerp'),
  ]);
  assert.doesNotMatch(out, /null/);
  assert.equal(out.split('Manchester United').length - 1, 1, out);
  assert.match(out, /Manchester United \(2025–prezent\)/);
});

console.log(n + ' tests passed');
