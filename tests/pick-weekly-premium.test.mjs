// Run: node tests/pick-weekly-premium.test.mjs
import assert from 'node:assert/strict';
import { LEAGUES, pick, windowFor } from '../scripts/pick-weekly-premium.mjs';

const mk = (l, n) => Array.from({ length: n }, (_, i) => ({ slug: `${l}-${i + 1}` }));   // soonest first
const queues = (counts) => Object.fromEntries(LEAGUES.map((l) => [l, mk(l, counts[l] ?? 0)]));
const totals = (counts) => Object.fromEntries(LEAGUES.map((l) => [l, counts[l] ?? 0]));
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

t('the planned competitions', () => {
  assert.deepEqual(LEAGUES, ['Ligue 1', 'Premier League', 'Superliga', 'Serie A', 'LaLiga', 'Bundesliga', 'UEFA Nations League']);
});

t('club leagues are prepared for Friday..Monday, the Nations League for the next 5 days', () => {
  // Wed 2026-11-18
  assert.deepEqual(windowFor('Serie A', '2026-11-18'), { from: '2026-11-20', to: '2026-11-23' });
  assert.deepEqual(windowFor('UEFA Nations League', '2026-11-18'), { from: '2026-11-18', to: '2026-11-23' });
  // Mon 2026-11-16: the club weekend is just today, the international window still reaches Saturday
  assert.deepEqual(windowFor('LaLiga', '2026-11-16'), { from: '2026-11-16', to: '2026-11-16' });
  assert.deepEqual(windowFor('UEFA Nations League', '2026-11-16'), { from: '2026-11-16', to: '2026-11-21' });
});

t('first run of the week: three different leagues, soonest match of each, tie-break in league order', () => {
  const c = Object.fromEntries(LEAGUES.map((l) => [l, 9]));
  assert.deepEqual(pick(queues(c), totals(c), 3), ['Ligue 1-1', 'Premier League-1', 'Superliga-1']);
});

t('the next run serves the leagues that are furthest behind, so the competitions advance together', () => {
  const c = Object.fromEntries(LEAGUES.map((l) => [l, 9]));
  const q = queues(c);
  const done = [];
  for (let run = 0; run < 3; run++) {
    const p = pick(q, totals(c), 3);
    done.push(...p);
    for (const slug of p) { const l = slug.replace(/-\d+$/, ''); q[l] = q[l].filter((m) => m.slug !== slug); }
  }
  const leaguesDone = new Set(done.map((s) => s.replace(/-\d+$/, '')));
  assert.equal(leaguesDone.size, LEAGUES.length, 'after three runs every competition has one deep match: ' + done.join(', '));
});

t('a league with nothing queued drops out; runs fill up from the others', () => {
  const c = { 'Ligue 1': 0, 'Premier League': 2, Superliga: 0, 'Serie A': 3, LaLiga: 0, Bundesliga: 0 };
  const p = pick(queues(c), totals(c), 3);
  assert.equal(p.length, 3);
  assert.ok(p.every((s) => s.startsWith('Premier League') || s.startsWith('Serie A')));
});

t('never picks more than perRun, never the same match twice, and does not modify the queues', () => {
  const c = Object.fromEntries(LEAGUES.map((l) => [l, 4]));
  const q = queues(c);
  const p = pick(q, totals(c), 5);
  assert.equal(p.length, 5);
  assert.equal(new Set(p).size, 5);
  assert.equal(q['Ligue 1'].length, 4);
});

t('empty queues give an empty pick', () => {
  assert.deepEqual(pick(queues({}), totals({}), 3), []);
});

t('inside a league the soonest kick-off is taken first', () => {
  const c = { 'Serie A': 5 };
  assert.deepEqual(pick(queues(c), totals(c), 3), ['Serie A-1', 'Serie A-2', 'Serie A-3']);
});

console.log(n + ' tests passed');
