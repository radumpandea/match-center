// Run: node tests/officials.test.mjs
import assert from 'node:assert/strict';
import '../docs/app/officials.js';

const { parse, role } = globalThis.MC_OFFICIALS;
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

// the shape of a pasted match-sheet block (names on one line, the role in brackets under it)
const SHEET = `Officials
Ruddy BUQUET
(Main official)
Julien HAULBERT
(Assistant referee)
Nicolas DANOS
(Assistant referee)
Jérémy STINAT
(Fourth official)
Cyril GRINGORE
(Video assistant referee)
Dominique JULIEN
(Assistant video assistant referee)
Delegates
Patrick REINBOLD
(Delegate referent)
Frédéric BILLAUX
(Delegate)
Standings
View full standings`;

t('a pasted match sheet gives the referee and the whole crew', () => {
  const r = parse(SHEET);
  assert.equal(r.name, 'Ruddy Buquet');
  assert.deepEqual(r.crew, {
    assistant1: 'Julien Haulbert', assistant2: 'Nicolas Danos', reserve: 'Jérémy Stinat', var: 'Cyril Gringore',
    avar: 'Dominique Julien', delegate: 'Patrick Reinbold, Frédéric Billaux',
  });
  assert.equal(r.count, 8);
});

t('the same in French', () => {
  const r = parse('François LETEXIER\n(Arbitre central)\nCyril MUGNIER\n(Arbitre assistant)\nMehdi RAHMOUNI\n(Arbitre assistant)\nA. B. Durand\n(Quatrième arbitre)\nJérôme BRISARD\n(Arbitre vidéo)\nPaul Martin\n(Adjoint vidéo)\nJean Dupont\n(Délégué principal)');
  assert.equal(r.name, 'François Letexier');
  assert.equal(r.crew.assistant2, 'Mehdi Rahmouni');
  assert.equal(r.crew.reserve, 'A. B. Durand');
  assert.equal(r.crew.var, 'Jérôme Brisard');
  assert.equal(r.crew.avar, 'Paul Martin');
  assert.equal(r.crew.delegate, 'Jean Dupont');
});

t('one line per person, "Name (role)" or "Role: Name", Romanian too', () => {
  const r = parse('Arbitru: Istvan Kovacs\nAsistent: Vasile Marinescu, Mihai Artene\nRezervă: Andrei Chivulete\nCătălin Popa (VAR)\nAVAR: Radu Ghinguleac\nObservator: Ion Pop');
  assert.equal(r.name, 'Istvan Kovacs');
  assert.deepEqual([r.crew.assistant1, r.crew.assistant2], ['Vasile Marinescu', 'Mihai Artene']);
  assert.equal(r.crew.reserve, 'Andrei Chivulete');
  assert.equal(r.crew.var, 'Cătălin Popa');
  assert.equal(r.crew.avar, 'Radu Ghinguleac');
  assert.equal(r.crew.observer, 'Ion Pop');
});

t('hyphenated capital surnames and role words are not mistaken for names', () => {
  const r = parse('Jean-Baptiste LE BLÉ-MARTIN\n(Main official)');
  assert.equal(r.name, 'Jean-Baptiste Le Blé-Martin');
  assert.equal(role('Delegates'), null);
  assert.equal(role('Brest'), null);
});

t('a name that contains a role word is still a name when its role follows in brackets', () => {
  const r = parse('Marc VIDEO\n(Video assistant referee)\nAna REZERVA\n(Fourth official)');
  assert.equal(r.crew.var, 'Marc Video');
  assert.equal(r.crew.reserve, 'Ana Rezerva');
});

t('text without officials gives nothing', () => {
  const r = parse('Brest\nParis FC\n27 NOVEMBER 2026\nStade Francis-Le Blé');
  assert.equal(r.count, 0);
  assert.equal(r.name, null);
});

console.log(n + ' tests passed');
