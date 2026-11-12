#!/usr/bin/env node
// Pre-match refresh: re-checks the things that change in the last day before kick-off on packs that are
// already built, and records WHAT changed on the pack (doc.refresh) so the match page can say
// "Updated 15:40 - referee announced, two new injuries, 3 new headlines".
//
// Why: prefetch-preview.mjs runs once a day and never re-reads injuries for a built pack (absences are only
// written when the pack is first built), and the referee / team news published in the final hours were missed
// (Angers v Nice, 8 Nov 2026: the coach's bereavement was in the news days before and not in the pack).
//
// Windows (minutes to kick-off): "24h" = 22-26 h before, "3h" = 2-4 h before. Hourly cron; a window already
// recorded in doc.refresh.done is skipped, so each match is refreshed at most once per window. Only packs
// with researchDepth "deep" (the matches that are really commented) unless ONLY_SLUGS names others.
// ~2 API-Football calls per match per window (fixtures?id=, injuries?fixture=) plus the news feeds.
//
//   APIFOOTBALL_KEY=... [ONLY_SLUGS=slug1,slug2] [RESERVE=1200] node scripts/prematch-refresh.mjs
//
// ONLY_SLUGS runs those packs now, whatever their window ("manual"). The run stops when the API reports the
// day's remaining allowance at or below RESERVE, so lineups (fetch-confirmed-lineups) always have calls left.
// What it never does: overwrite a referee that is already in the pack with a different name (it flags it),
// remove an absence, or touch lineups. Requires Node 18+.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { teamNews, classifyReason, fetchRss } from './prefetch-preview.mjs';
import { nameMatches, applyAbsenceStatus, decodeDeep } from './lib/enrich-pack.mjs';
import { computeWatch } from './lib/watch.mjs';
import { refereeSeasonStats, applyRefereeSeason } from './lib/referee-stats.mjs';

const API_KEY = process.env.APIFOOTBALL_KEY;
const HOST = 'https://v3.football.api-sports.io';
const DATA = 'docs/data';
const RESERVE = Number(process.env.RESERVE) || 1200;
const ONLY = String(process.env.ONLY_SLUGS || '').split(',').map((s) => s.trim()).filter(Boolean);
const WINDOWS = [
  { key: '24h', from: 22 * 60, to: 26 * 60 },
  { key: '3h', from: 2 * 60, to: 4 * 60 },
];

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));
const has = (v) => v != null && v !== '' && v !== 'n/d';
const strip = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const norm = (s) => strip(s).replace(/[^a-z0-9]+/g, '');

let remaining = null;
const refBudget = { left: 40 };   // fixtures/events calls for referee statistics this run
async function af(path, params) {
  const res = await fetch(`${HOST}/${path}?${new URLSearchParams(params)}`, { headers: { 'x-apisports-key': API_KEY } });
  const r = Number(res.headers.get('x-ratelimit-requests-remaining'));
  if (Number.isFinite(r)) remaining = r;
  if (!res.ok) return null;
  const j = await res.json();
  const errs = j && j.errors;
  if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) { console.log(`  API errors on ${path}: ${JSON.stringify(errs)}`); return null; }
  return j;
}

// API-Football almost never carries the referee of Romanian matches; the delegation is published by the FRF/LPF a
// few days ahead and repeated by the press. Headlines found for the fixture are reported as unverified hints
// (the referee itself is never written from a headline).
const RO_COMPS = new Set(['Superliga', 'Liga 2', 'Cupa României']);
async function refereeHints(f, doc) {
  const key = (s) => norm(s);
  const hk = key(f.home), ak = key(f.away);
  const queries = [`arbitri delegați "${f.home}" "${f.away}" when:7d`, `"${f.home}" "${f.away}" arbitru when:7d`];
  const seen = new Set(((doc.refresh && doc.refresh.changes) || []).filter((c) => c.kind === 'referee-hint').map((c) => key(c.text)));
  const out = [];
  for (const q of queries) {
    for (const it of await fetchRss(q)) {
      const k = key(it.title);
      if (!k || seen.has(k)) continue;
      if (!/arbitr|delegat|brigad/i.test(it.title)) continue;
      if (!(k.includes(hk) || k.includes(ak))) continue;
      seen.add(k);
      out.push({ kind: 'referee-hint', text: it.title, url: it.url || null, source: it.source || null, published: it.published || null });
    }
  }
  return out.slice(0, 3);
}

const REASON_RO = { injury: 'accidentat', suspension: 'suspendat', doubt: 'incert', other: 'indisponibil' };
const lastName = (s) => norm(String(s || '').trim().split(/\s+/).pop());

function refereeChange(doc, apiRef) {
  if (!has(apiRef)) return null;
  const cur = doc.referee && doc.referee.name;
  if (!has(cur)) {
    doc.referee = { name: apiRef, country: null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null };
    return { kind: 'referee', text: `Arbitru delegat: ${apiRef}` };
  }
  if (lastName(cur) !== lastName(apiRef)) {
    return { kind: 'referee', text: `API-Football indică alt arbitru decât pachetul: ${apiRef} (în pachet: ${cur}) — de verificat` };
  }
  return null;
}

function absenceChanges(doc, side, rows, teamId, kickDate) {
  const out = [];
  const t = doc.teams[side];
  t.absences = t.absences || [];
  const mine = (rows || []).filter((r) => r.team && r.team.id === teamId && r.player && r.player.name);
  const seen = new Set();
  for (const r of mine) {
    const name = r.player.name;
    if (seen.has(name)) continue;
    seen.add(name);
    const reason = classifyReason(r.player.reason);
    const exists = t.absences.find((a) => nameMatches(name, a.name) || nameMatches(a.name, name));
    if (exists) continue;
    const detail = r.player.reason || null;
    t.absences.push({ name, reason, detail, since: kickDate });
    out.push({ kind: 'absence', side, text: `${name} — ${REASON_RO[reason] || 'indisponibil'}${detail ? ` (${detail})` : ''}` });
  }
  if (mine.length) {
    // API-origin entries (they carry `since`) that the API no longer lists: report, never remove.
    for (const a of t.absences) {
      if (!a.since || seen.has(a.name)) continue;
      if ([...seen].some((n) => nameMatches(n, a.name) || nameMatches(a.name, n))) continue;
      out.push({ kind: 'absence-cleared', side, text: `${a.name} nu mai apare ca indisponibil la API-Football (rămâne în pachet până verifici)` });
    }
  }
  return out;
}

function newsChanges(doc, side, fresh) {
  const t = doc.teams[side];
  const known = new Set([...(t.newsCandidates || []).map((x) => norm(x.title)), ...(t.news || []).map((x) => norm(x.text))]);
  const added = fresh.filter((x) => x.title && !known.has(norm(x.title)));
  if (fresh.length) t.newsCandidates = fresh;
  return added.slice(0, 4).map((x) => ({ kind: 'news', side, text: x.title, url: x.url || null, source: x.source || null, published: x.published || null }));
}

async function main() {
  if (!API_KEY) { console.error('Missing APIFOOTBALL_KEY.'); process.exit(1); }
  const fixtures = readJSON(`${DATA}/fixtures.json`);
  const now = Date.now();
  const work = [];
  for (const f of fixtures) {
    if (!f.eventId || !f.slug) continue;
    const p = `${DATA}/matches/${f.slug}.json`;
    if (!existsSync(p)) continue;
    if (ONLY.length) { if (ONLY.includes(f.slug)) work.push({ f, p, win: 'manual' }); continue; }
    const mins = f.kickoff && f.kickoff !== 'n/d' ? (new Date(f.kickoff).getTime() - now) / 60000 : NaN;
    if (!Number.isFinite(mins)) continue;
    const w = WINDOWS.find((x) => mins >= x.from && mins <= x.to);
    if (w) work.push({ f, p, win: w.key });
  }
  if (!work.length) { console.log('Nothing in a refresh window.'); return; }

  let changed = 0;
  for (const { f, p, win } of work) {
    const doc = readJSON(p);
    if (doc.partial || !doc.teams) continue;
    if (win !== 'manual' && doc.researchDepth !== 'deep') continue;
    if (win !== 'manual' && doc.refresh && Array.isArray(doc.refresh.done) && doc.refresh.done.includes(win)) continue;
    if (remaining != null && remaining <= RESERVE) { console.log(`Allowance down to ${remaining} (reserve ${RESERVE}), stopping.`); break; }
    console.log(`Refreshing ${f.slug} (${win})...`);

    const changes = [];
    const fx = await af('fixtures', { id: f.eventId });
    const fr = fx && fx.response && fx.response[0];
    if (fr && fr.fixture && fr.fixture.status && !process.env.ALLOW_STARTED && !['NS', 'TBD', 'PST'].includes(fr.fixture.status.short)) { console.log(`  status ${fr.fixture.status.short}, match already started, skipped.`); continue; }
    if (fr) { const c = refereeChange(doc, fr.fixture && fr.fixture.referee); if (c) changes.push(c); }
    if (!has(doc.referee && doc.referee.name) && RO_COMPS.has(f.comp)) {
      try { changes.push(...(await refereeHints(f, doc))); } catch (e) { console.log(`  referee hints failed: ${e.message}`); }
    }
    if (fr && has(doc.referee && doc.referee.name) && f.leagueId) {
      try {
        const season = (fr.league && fr.league.season) || null;
        if (season) {
          const rs = await refereeSeasonStats({ af, doc, fixture: f, season, budget: refBudget });
          console.log(`  referee stats (${doc.referee.name}, league ${f.leagueId}, season ${season}): ${rs ? `${rs.matches} match(es), ${rs.fetched} event call(s)` : 'none found'}`);
          if (applyRefereeSeason(doc, f.comp, rs)) {
            changes.push({ kind: 'referee-stats', text: `Statistici arbitru (${doc.referee.name}, ${f.comp}, acest sezon): ${rs.matches} meciuri, ${(rs.yellow / rs.matches).toFixed(1)} galbene/meci, ${rs.red} roșii, ${rs.penalties} penalty-uri` });
          }
        }
      } catch (e) { console.log(`  referee stats failed: ${e.message}`); }
    }

    const kickDate = String(doc.kickoff || f.kickoff || '').slice(0, 10) || null;
    const inj = await af('injuries', { fixture: f.eventId });
    const rows = inj && inj.response;
    if (rows && rows.length) {
      changes.push(...absenceChanges(doc, 'home', rows, f.homeId, kickDate), ...absenceChanges(doc, 'away', rows, f.awayId, kickDate));
      applyAbsenceStatus(doc);
    }

    for (const side of ['home', 'away']) {
      try {
        const fresh = await teamNews(f[side], f[side === 'home' ? 'away' : 'home'], f.comp);
        changes.push(...newsChanges(doc, side, fresh));
      } catch (e) { console.log(`  news (${side}) failed: ${e.message}`); }
    }

    computeWatch(doc);   // a new suspension / injury can change who is one card from a ban
    const at = new Date().toISOString();
    const prev = doc.refresh || {};
    doc.refresh = {
      at,
      window: win,
      done: [...new Set([...(prev.done || []), ...(win === 'manual' ? [] : [win])])],
      changes: [...(prev.changes || []), ...changes.map((c) => ({ at, ...c }))].slice(-40),
    };
    decodeDeep(doc);
    writeFileSync(p, JSON.stringify(doc, null, 2) + '\n', 'utf8');
    changed++;
    console.log(`  ${changes.length} change(s): ${changes.map((c) => c.kind).join(', ') || 'none'}`);
  }
  console.log(`Refreshed ${changed} pack(s).${remaining != null ? ` API allowance left: ${remaining}.` : ''}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
