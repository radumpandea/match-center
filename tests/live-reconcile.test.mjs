// Run: node tests/live-reconcile.test.mjs
// The cases are the ones seen on the Nations League evening of 13 Nov 2026 (scripts/live-probe.mjs).
import assert from 'node:assert/strict';
import { normalizeEvent, reconcile, fixtureRow } from '../supabase/functions/_shared/live-reconcile.mjs';

let id = 0;
const ev = (o) => normalizeEvent({
  time: { elapsed: o.min, extra: o.extra ?? null }, team: { id: o.team }, type: o.type, detail: o.detail,
  player: { id: o.pid ?? null, name: o.player ?? null }, assist: { id: o.aid ?? null, name: o.assist ?? null },
});
const stored = (...evs) => evs.map((e) => ({ ...e, id: ++id }));
const run = (existing, incoming) => reconcile(existing, incoming);
let n = 0;
function t(name, fn) { fn(); n++; console.log('ok  ' + name); }

t('unchanged list: nothing to do', () => {
  const a = ev({ min: 3, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 10, player: 'A' });
  const r = run(stored(a), [a]);
  assert.deepEqual([r.inserts.length, r.updates.length, r.removals.length], [0, 0, 0]);
});

t('a new goal is an insert', () => {
  const a = ev({ min: 3, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 10, player: 'A' });
  const b = ev({ min: 14, team: 2, type: 'Goal', detail: 'Normal Goal', pid: 20, player: 'B' });
  const r = run(stored(a), [a, b]);
  assert.equal(r.inserts.length, 1);
  assert.equal(r.inserts[0].playerName, 'B');
  assert.equal(r.updates.length + r.removals.length, 0);
});

t('scorer and assist arrive later: an update, not a new event', () => {
  const first = ev({ min: 17, team: 1, type: 'Goal', detail: 'Normal Goal' });
  const later = ev({ min: 17, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 5, player: 'Erik Prekop' });
  const ex = stored(first);
  const r = run(ex, [later]);
  assert.equal(r.inserts.length, 0);
  assert.equal(r.removals.length, 0);
  assert.deepEqual(r.updates, [{ id: ex[0].id, patch: { playerId: 5, playerName: 'Erik Prekop' } }]);
});

t('Serbia-Germany: Thiaw becomes an own goal of Babic', () => {
  const first = ev({ min: 3, team: 25, type: 'Goal', detail: 'Normal Goal', pid: 1, player: 'Malick Thiaw' });
  const later = ev({ min: 3, team: 25, type: 'Goal', detail: 'Own Goal', pid: 2, player: 'Srdjan Babic' });
  const ex = stored(first);
  const r = run(ex, [later]);
  assert.equal(r.inserts.length + r.removals.length, 0);
  assert.equal(r.updates[0].patch.detail, 'Own Goal');
  assert.equal(r.updates[0].patch.playerName, 'Srdjan Babic');
});

t('Liechtenstein-Azerbaijan: minute 21 -> 26 and the scorer changes', () => {
  const first = ev({ min: 21, team: 3, type: 'Goal', detail: 'Own Goal', pid: 7, player: 'Jens Hofer' });
  const later = ev({ min: 26, team: 3, type: 'Goal', detail: 'Normal Goal', pid: 8, player: 'Mahir Emreli' });
  const ex = stored(first);
  const r = run(ex, [later]);
  assert.equal(r.inserts.length + r.removals.length, 0);
  assert.equal(r.updates[0].patch.minute, 26);
});

t('minute correction for the same player (19 -> 18)', () => {
  const first = ev({ min: 19, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 9, player: 'Reijnders' });
  const second = ev({ min: 33, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 9, player: 'Reijnders' });
  const fixed = ev({ min: 18, team: 1, type: 'Goal', detail: 'Normal Goal', pid: 9, player: 'Reijnders' });
  const ex = stored(first, second);
  const r = run(ex, [fixed, second]);
  assert.equal(r.inserts.length + r.removals.length, 0);
  assert.deepEqual(r.updates, [{ id: ex[0].id, patch: { minute: 18 } }]);
});

t('VAR cancels a goal: it is removed, the later goal of the same team stays untouched', () => {
  const a = ev({ min: 24, team: 4, type: 'Goal', detail: 'Normal Goal', pid: 1, player: 'Ioannidis' });
  const b = ev({ min: 40, team: 4, type: 'Goal', detail: 'Normal Goal', pid: 2, player: 'Other' });
  const ex = stored(a, b);
  const r = run(ex, [b]);
  assert.deepEqual(r.removals, [ex[0].id]);
  assert.equal(r.inserts.length + r.updates.length, 0);
});

t('Slovenia ghost goal (no player) that vanishes', () => {
  const ghost = ev({ min: 30, team: 5, type: 'Goal', detail: 'Normal Goal' });
  const card = ev({ min: 50, team: 5, type: 'Card', detail: 'Yellow Card', pid: 1, player: 'Kuzmic' });
  const ex = stored(ghost);
  const r = run(ex, [card]);
  assert.deepEqual(r.removals, [ex[0].id]);
  assert.equal(r.inserts.length, 1);
});

t('a VAR note changes from "-" to "Goal cancelled"', () => {
  const first = ev({ min: 25, team: 4, type: 'Var', detail: null, pid: 1, player: 'Ioannidis' });
  const later = ev({ min: 25, team: 4, type: 'Var', detail: 'Goal cancelled', pid: 1, player: 'Ioannidis' });
  const ex = stored(first);
  const r = run(ex, [later]);
  assert.deepEqual(r.updates, [{ id: ex[0].id, patch: { detail: 'Goal cancelled' } }]);
});

t('two substitutions at one minute change order: nothing happens', () => {
  const s1 = ev({ min: 45, team: 6, type: 'subst', detail: 'Substitution 1', pid: 1, player: 'Samardzic', aid: 2, assist: 'Zivkovic' });
  const s2 = ev({ min: 45, team: 6, type: 'subst', detail: 'Substitution 2', pid: 3, player: 'Dzodic', aid: 4, assist: 'Dragojevic' });
  const swapped1 = { ...s1, detail: 'Substitution 2' }, swapped2 = { ...s2, detail: 'Substitution 1' };
  const r = run(stored(s1, s2), [swapped2, swapped1]);
  // only the "Substitution N" label moved: two cheap detail updates, never an insert or a removal
  assert.equal(r.inserts.length + r.removals.length, 0);
});

t('a substitution minute is corrected (79 -> 78)', () => {
  const s = ev({ min: 79, team: 6, type: 'subst', detail: 'Substitution 3', pid: 1, player: 'X', aid: 2, assist: 'Y' });
  const ex = stored(s);
  const r = run(ex, [{ ...s, minute: 78 }]);
  assert.deepEqual(r.updates, [{ id: ex[0].id, patch: { minute: 78 } }]);
});

t('yellow turns into a red after VAR: same player, detail update', () => {
  const y = ev({ min: 76, team: 7, type: 'Card', detail: 'Yellow Card', pid: 1, player: 'D' });
  const red = ev({ min: 76, team: 7, type: 'Card', detail: 'Red Card', pid: 1, player: 'D' });
  const ex = stored(y);
  const r = run(ex, [red]);
  assert.deepEqual(r.updates, [{ id: ex[0].id, patch: { detail: 'Red Card' } }]);
});

t('names are decoded from HTML entities and trimmed', () => {
  const e = normalizeEvent({ time: { elapsed: 5 }, team: { id: 1 }, type: 'Goal', detail: 'Normal Goal', player: { id: 1, name: ' L. O&apos;Nien ' }, assist: {} });
  assert.equal(e.playerName, "L. O'Nien");
  assert.equal(e.assistName, null);
});

t('fixtureRow: status, score and finished flag', () => {
  const r = fixtureRow({ fixture: { id: 99, date: '2026-11-13T19:45:00+00:00', status: { short: 'FT', elapsed: 90 } }, league: { id: 5 }, teams: { home: { id: 1, name: 'A' }, away: { id: 2, name: 'B' } }, goals: { home: 7, away: 0 } });
  assert.equal(r.finished, true);
  assert.equal(r.home_goals, 7);
  assert.equal(fixtureRow({ fixture: { id: 1, status: { short: '2H', elapsed: 60 } }, goals: {} }).finished, false);
});

console.log(n + ' tests passed');
