// Deterministic, no AI: cuts the squad[] of a national-team pack down to the players really called up for the window.
//
//   node scripts/trim-national-squad.mjs [--dry] [slug ...]
//   no slug: every national-team pack (competitions in NATIONAL_COMPS) with a match from yesterday to 7 days ahead.
//
// API-Football's squad for a national team is a pool of everyone capped lately (35 names for Denmark when 24 were called
// up), so the pack starts with players who are not with the team. The reference is the "Current squad" table of the
// team's Wikipedia article; its note must name the day of this match, otherwise the table belongs to another window and
// nothing is changed (that is reported, not guessed). Players of the predicted/confirmed XI are never removed, and a team
// is left alone when the table cannot be matched well to the pack (more than 40 % of the called-up names not found).
// Idempotent; validates the pack afterwards and restores it if validation fails. Needs Node 18+ (global fetch).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { articleTitle, noteCoversMatch, parseSquad, splitSquad, squadNote } from './lib/national-squad.mjs';

const NATIONAL_COMPS = new Set(['UEFA Nations League']);
const API = 'https://en.wikipedia.org/w/api.php';
const UA = 'match-center-squad-check/1.0 (football match preparation tool)';
const args = process.argv.slice(2);
const DRY = args.includes('--dry');
const slugsArg = args.filter((a) => !a.startsWith('--'));

const ymd = (d) => d.toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
const addDays = (s, n) => new Date(Date.parse(`${s}T12:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const today = ymd(new Date());

async function wiki(params) {
  const url = API + '?' + new URLSearchParams({ format: 'json', formatversion: '2', redirects: '1', ...params });
  // Wikipedia answers 429 when asked too fast: wait (its Retry-After, else a growing pause) and try again.
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { headers: { 'User-Agent': UA } });
    if (res.ok) { await new Promise((r) => setTimeout(r, 400)); return res.json(); }
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      const wait = Math.min(Number(res.headers.get('retry-after')) || 0, 60) || attempt * 8;
      await new Promise((r) => setTimeout(r, wait * 1000));
      continue;
    }
    throw new Error('Wikipedia HTTP ' + res.status);
  }
}

const cache = new Map();   // title -> { section wikitext, note, called } | { error }
async function calledUp(title) {
  if (cache.has(title)) return cache.get(title);
  let out;
  try {
    const secs = await wiki({ action: 'parse', page: title, prop: 'sections' });
    const list = (secs.parse && secs.parse.sections) || [];
    const sec = list.find((s) => /^current squad$/i.test(s.line)) || list.find((s) => /^(current )?squad$/i.test(s.line));
    if (!sec) throw new Error('no "Current squad" section');
    const body = await wiki({ action: 'parse', page: title, prop: 'wikitext', section: String(sec.index) });
    let text = (body.parse && body.parse.wikitext) || '';
    text = text.split(/\n={3,}\s*(?:recent|previous|notable|former|other)/i)[0];
    out = { title: body.parse.title, note: squadNote(text), called: parseSquad(text) };
  } catch (e) {
    out = { error: String(e.message || e) };
  }
  cache.set(title, out);
  return out;
}

function validate(file) {
  const r = spawnSync(process.execPath, ['scripts/validate-match.mjs', file], { encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout || '') + (r.stderr || '') };
}

async function trimPack(slug, fx) {
  const file = `docs/data/matches/${slug}.json`;
  if (!existsSync(file)) { console.log(`${slug}: no pack yet`); return 0; }
  const before = readFileSync(file, 'utf8');
  const pack = JSON.parse(before);
  let changed = 0;
  for (const side of ['home', 'away']) {
    const team = pack.teams && pack.teams[side];
    if (!team || !Array.isArray(team.squad) || !team.squad.length) continue;
    const name = team.name || fx[side];
    const title = articleTitle(name);
    const info = await calledUp(title);
    const tag = `${slug} / ${name}`;
    if (info.error) { console.log(`${tag}: skipped, ${info.error} (${title})`); continue; }
    if (!noteCoversMatch(info.note, fx.date)) { console.log(`${tag}: skipped, the squad note does not cover ${fx.date}: "${info.note.slice(0, 160)}"`); continue; }
    if (info.called.length < 16) { console.log(`${tag}: skipped, only ${info.called.length} players read from the table`); continue; }
    const xi = [...(team.predictedXI || []), ...(team.confirmedXI || [])].map((p) => p && p.name).filter(Boolean);
    const r = splitSquad(team.squad, info.called, xi);
    if (r.notInPack.length > info.called.length * 0.4) { console.log(`${tag}: skipped, ${r.notInPack.length} of ${info.called.length} called-up names not found in the pack (${r.notInPack.slice(0, 6).join(', ')})`); continue; }
    if (!r.drop.length) { console.log(`${tag}: already matches the call-up (${team.squad.length} players)`); }
    else {
      const dropped = r.drop.map((i) => team.squad[i].name);
      console.log(`${tag}: ${team.squad.length} -> ${team.squad.length - r.drop.length} players; removed: ${dropped.join(', ')}`);
      team.squad = team.squad.filter((_p, i) => !r.drop.includes(i));
      changed++;
    }
    if (r.notInPack.length) console.log(`${tag}: called up but not in the pack: ${r.notInPack.join(', ')}`);
    // the reference, once per team
    const label = `Wikipedia: lotul convocat ${name}`;
    pack.sources = (pack.sources || []).filter((s) => s.name !== label);
    pack.sources.push({ name: label, url: 'https://en.wikipedia.org/wiki/' + info.title.replace(/ /g, '_'), accessed: today });
  }
  if (!changed) return 0;
  if (DRY) return changed;
  writeFileSync(file, JSON.stringify(pack, null, 2) + '\n');
  const v = validate(file);
  if (!v.ok) { writeFileSync(file, before); console.log(`${slug}: validation failed, pack restored\n${v.out.slice(0, 600)}`); return 0; }
  return changed;
}

async function main() {
  const fixtures = JSON.parse(readFileSync('docs/data/fixtures.json', 'utf8'));
  const picked = slugsArg.length
    ? fixtures.filter((f) => slugsArg.includes(f.slug))
    : fixtures.filter((f) => NATIONAL_COMPS.has(f.comp) && f.date >= addDays(today, -1) && f.date <= addDays(today, 7));
  if (!picked.length) { console.log('No national-team match to check.'); return; }
  let total = 0;
  for (const f of picked) {
    if (!NATIONAL_COMPS.has(f.comp)) { console.log(`${f.slug}: not a national-team competition, skipped`); continue; }
    total += await trimPack(f.slug, f);
  }
  console.log(`${DRY ? 'Would change' : 'Changed'} ${total} team(s).`);
}

main().catch((e) => { console.error(e); process.exit(1); });
