#!/usr/bin/env node
// Level 3 (translation) via a cheap OpenRouter model instead of an agentic
// Claude Code Action run. This is pure mechanical translation of editorial
// text a previous run already researched and verified in Romanian — no web
// access, no new facts — so it doesn't need Claude's research tools, and it
// no longer competes with an interactive Claude session for the shared
// CLAUDE_CODE_OAUTH_TOKEN session budget (the collision that used to fail
// this workflow with a 429).
//
// Root cause of the earlier Haiku-via-Claude-Code-Action quality bug: one
// long agentic turn drifted into copying Romanian text through unchanged
// once the squad array got long. This script sidesteps that by chunking —
// every OpenRouter call carries a small, fixed-size batch of strings, so no
// single call is ever long enough to drift on, regardless of model.
//
//   MATCH=<slug> node scripts/translate-match-data-openrouter.mjs
//   COUNT=5 node scripts/translate-match-data-openrouter.mjs   (auto-pick)

import { readFileSync, writeFileSync, existsSync, unlinkSync, appendFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const DATA_DIR = 'docs/data';
const FIXTURES_PATH = `${DATA_DIR}/fixtures.json`;

const LANGS = ['en', 'de', 'it'];
const LANG_NAMES = { en: 'English', de: 'German', it: 'Italian' };
const PRESENT_WORD = { en: 'present', de: 'heute', it: 'presente' };

const MATCH = (process.env.MATCH || '').trim();
const COUNT = parseInt(process.env.COUNT || '5', 10);
const DEFAULT_MODEL = 'google/gemini-2.5-flash';
const MODEL = (process.env.OPENROUTER_MODEL || '').trim() || DEFAULT_MODEL;
const API_KEY = process.env.OPENROUTER_API_KEY;
const BASE_URL = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');

function readJSON(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}
function writeJSON(p, v) {
  writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8');
}

// Liga 2 România is Romanian-only content — never translate it, and never
// let it occupy a slot in the auto-picked list, even if it's otherwise
// ready. Applies to an explicit MATCH override too: this is a standing
// policy, not just a scheduling choice.
const isLiga2Romania = (slug) => slug.startsWith('ro2-');

// Only translate what's actually about to be shown — matches further out
// than the site's own display window (docs/index.html's DAYS_AHEAD) don't
// need a translation yet. Running on the same daily cron as before, this
// window is what makes new matches get translated automatically as they
// roll into it, without ever re-processing the full backlog.
const DAYS_AHEAD = 4;
function withinDisplayWindow(f) {
  if (!f.date) return false;
  const from = new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  const to = new Date(Date.now() + DAYS_AHEAD * 86400000).toLocaleDateString('en-CA', { timeZone: 'Europe/Bucharest' });
  return f.date >= from && f.date <= to;
}

function pickMatches() {
  if (MATCH) {
    if (isLiga2Romania(MATCH)) {
      console.log(`Skipping ${MATCH}: Liga 2 România is never translated.`);
      return [];
    }
    return [MATCH];
  }
  const fixtures = readJSON(FIXTURES_PATH);
  return fixtures
    .filter((f) => f.ready === true)
    .filter((f) => !isLiga2Romania(f.slug))
    .filter((f) => withinDisplayWindow(f))
    .filter((f) => existsSync(`${DATA_DIR}/matches/${f.slug}.json`))
    .filter((f) => !existsSync(`${DATA_DIR}/matches/${f.slug}.i18n.json`))
    .sort((a, b) => String(a.kickoff || a.date || '').localeCompare(String(b.kickoff || b.date || '')))
    .slice(0, COUNT)
    .map((f) => f.slug);
}

// ---- Flatten the translatable fields into {path, text} units, in the same
// field list docs/app/match.js's applyI18nOverlay reads back. ----

function collectUnits(doc) {
  const units = [];
  const add = (path, text) => {
    if (typeof text === 'string' && text.trim()) units.push({ path, text });
  };

  (doc.storyOfTheMatch || []).forEach((s, i) => add(['storyOfTheMatch', i], s));
  if (doc.h2h) add(['h2h', 'summary'], doc.h2h.summary);
  if (doc.referee) add(['referee', 'history'], doc.referee.history);
  if (doc.venue) {
    add(['venue', 'notes'], doc.venue.notes);
    (doc.venue.stories || []).forEach((s, i) => add(['venue', 'stories', i], s));
  }
  (doc.commentatorResearch || []).forEach((c, i) => {
    add(['commentatorResearch', i, 'topic'], c && c.topic);
    add(['commentatorResearch', i, 'fact'], c && c.fact);
  });
  for (const side of ['home', 'away']) {
    const team = doc.teams && doc.teams[side];
    if (!team) continue;
    if (team.coach && Array.isArray(team.coach.career)) {
      team.coach.career.forEach((c, i) => add(['teams', side, 'coach', 'career', i], c && c.note));
    }
    (team.news || []).forEach((n, i) => add(['teams', side, 'news', i], n && n.text));
    (team.pressQuotes || []).forEach((q, i) => add(['teams', side, 'pressQuotes', i], q && q.text));
    (team.stories || []).forEach((s, i) => {
      add(['teams', side, 'stories', i, 'title'], s && s.title);
      (s && s.bullets ? s.bullets : []).forEach((b, j) => add(['teams', side, 'stories', i, 'bullets', j], b));
    });
    (team.squad || []).forEach((p, i) => {
      add(['teams', side, 'squad', i, 'funfact'], p && p.funfact);
      add(['teams', side, 'squad', i, 'linkLine'], p && p.linkLine);
      add(['teams', side, 'squad', i, 'career'], p && p.career);
      add(['teams', side, 'squad', i, 'lastSeason'], p && p.lastSeason);
      add(['teams', side, 'squad', i, 'statusNote'], p && p.statusNote);
    });
  }
  return units;
}

// Every array-shaped field must come back the exact same length as the
// Romanian source (validate-i18n.mjs enforces this — the UI overlay maps by
// index, not content), so pre-fill every position with null before patching
// in the ones we actually translate.
function buildSkeleton(doc) {
  const out = {};
  if (Array.isArray(doc.storyOfTheMatch)) out.storyOfTheMatch = doc.storyOfTheMatch.map(() => null);
  if (doc.h2h) out.h2h = { summary: null };
  if (doc.referee) out.referee = { history: null };
  if (doc.venue) {
    out.venue = { notes: null };
    if (Array.isArray(doc.venue.stories)) out.venue.stories = doc.venue.stories.map(() => null);
  }
  if (Array.isArray(doc.commentatorResearch)) {
    out.commentatorResearch = doc.commentatorResearch.map(() => ({ topic: null, fact: null }));
  }
  out.teams = {};
  for (const side of ['home', 'away']) {
    const team = doc.teams && doc.teams[side];
    if (!team) continue;
    const t = {};
    if (team.coach && Array.isArray(team.coach.career)) {
      t.coach = { career: team.coach.career.map(() => null) };
    }
    if (Array.isArray(team.news)) t.news = team.news.map(() => null);
    if (Array.isArray(team.pressQuotes)) t.pressQuotes = team.pressQuotes.map(() => null);
    if (Array.isArray(team.stories)) {
      t.stories = team.stories.map((s) => ({
        title: null,
        bullets: Array.isArray(s && s.bullets) ? s.bullets.map(() => null) : [],
      }));
    }
    if (Array.isArray(team.squad)) {
      t.squad = team.squad.map(() => ({ funfact: null, linkLine: null, career: null, lastSeason: null, statusNote: null }));
    }
    out.teams[side] = t;
  }
  return out;
}

function setAtPath(root, path, value) {
  let node = root;
  for (let i = 0; i < path.length - 1; i++) node = node[path[i]];
  node[path[path.length - 1]] = value;
}

function collapseNulls(langDoc) {
  for (const side of ['home', 'away']) {
    const t = langDoc.teams && langDoc.teams[side];
    if (!t) continue;
    if (Array.isArray(t.squad)) {
      t.squad = t.squad.map((p) => (p && Object.values(p).some((v) => v != null) ? p : null));
    }
    if (Array.isArray(t.stories)) {
      t.stories = t.stories.map((s) => {
        if (!s) return null;
        const hasBullet = Array.isArray(s.bullets) && s.bullets.some((b) => b != null);
        return s.title != null || hasBullet ? s : null;
      });
    }
  }
  if (Array.isArray(langDoc.commentatorResearch)) {
    langDoc.commentatorResearch = langDoc.commentatorResearch.map((c) =>
      c && (c.topic != null || c.fact != null) ? c : null
    );
  }
}

// ---- OpenRouter calls ----

function chunkUnits(units, maxCount = 10, maxChars = 1800) {
  const batches = [];
  let cur = [];
  let curChars = 0;
  for (const u of units) {
    if (cur.length && (cur.length >= maxCount || curChars + u.text.length > maxChars)) {
      batches.push(cur);
      cur = [];
      curChars = 0;
    }
    cur.push(u);
    curChars += u.text.length;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

function buildMessages(lang, batch) {
  const langName = LANG_NAMES[lang];
  const presentWord = PRESENT_WORD[lang];
  const list = batch.map((u, i) => `${i}: ${u.text}`).join('\n');
  return [
    {
      role: 'system',
      content: `You are a professional sports-broadcast translator working on football (soccer) match briefings for a live commentator. Translate each numbered Romanian string into ${langName}.
Rules:
- Translate ALL Romanian prose and connecting words fully. Do not leave a single Romanian word in the output, including in short "career"-style strings like "Club (2016) · Club (2020-prezent)" — the club/competition NAMES and the years stay as-is, but "prezent" must become "${presentWord}" and any other connecting word (e.g. "din", "cu împrumut la", "produs al academiei", "transfer de X mil. euro de la") must be fully translated into ${langName}.
- Keep player, coach, club, and competition proper names unchanged.
- Preserve numbers, scores, and dates exactly as given.
- Professional, concise commentator tone, matching the register of the source.
- Output strictly this JSON object: {"translations": ["...", ...]} with EXACTLY ${batch.length} strings, in the same order as the input, one-to-one. No markdown fences, no extra commentary, no extra keys.`,
    },
    { role: 'user', content: list },
  ];
}

async function callOpenRouter(messages) {
  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.1,
      max_tokens: 8000,
      response_format: { type: 'json_object' },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`OpenRouter HTTP ${res.status}: ${body.slice(0, 500)}`);
  }
  const data = await res.json();
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message && choice.message.content;
  if (typeof content !== 'string') throw new Error(`Unexpected OpenRouter response shape: ${JSON.stringify(data).slice(0, 500)}`);
  if (choice.finish_reason && choice.finish_reason !== 'stop') {
    console.error(`  OpenRouter response finish_reason="${choice.finish_reason}" (likely truncated — consider a larger max_tokens or a smaller batch)`);
  }
  return content;
}

function parseTranslations(raw, expectedLen) {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fence) text = fence[1];
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed.translations) ? parsed.translations : null;
  if (!arr || arr.length !== expectedLen) return null;
  if (!arr.every((s) => typeof s === 'string')) return null;
  return arr;
}

async function translateBatch(lang, batch, attempt = 1) {
  const raw = await callOpenRouter(buildMessages(lang, batch));
  const arr = parseTranslations(raw, batch.length);
  if (arr) return arr;
  console.error(`  [${lang}] batch of ${batch.length} did not parse as expected (attempt ${attempt}), raw length=${raw.length}. Raw response:\n${raw.slice(0, 3000)}`);
  if (attempt >= 2) throw new Error(`Could not get a valid ${batch.length}-item translation for lang=${lang} after retry`);
  return translateBatch(lang, batch, attempt + 1);
}

// A translated string byte-identical to its Romanian source is almost
// always a copy-through -- except for `career` (club+year lists can be
// legitimately unchanged) and short strings (a category label like
// "Marcatori <club>" or an English football loanword the source already
// used verbatim, e.g. "clean sheets", routinely IS the correct
// translation) — see scripts/validate-i18n.mjs's matching SHORT_STRING_MAX.
// One targeted retry for a flagged non-short string before giving up; if
// it still comes back unchanged, leave it as-is and let validate-i18n.mjs
// fail the file loudly rather than silently shipping bad data.
const SHORT_STRING_MAX = 30;
async function fixCopyThrough(lang, unit, translated) {
  if (unit.path[unit.path.length - 1] === 'career') return translated;
  if (translated !== unit.text || !unit.text.trim()) return translated;
  if (unit.text.length <= SHORT_STRING_MAX) return translated;
  try {
    const arr = await translateBatch(lang, [unit]);
    return arr[0];
  } catch {
    return translated;
  }
}

async function translateDoc(doc, lang) {
  const units = collectUnits(doc);
  const langDoc = buildSkeleton(doc);
  const batches = chunkUnits(units);
  console.log(`  [${lang}] ${units.length} unit(s) in ${batches.length} batch(es), model=${MODEL}`);
  for (const batch of batches) {
    const translations = await translateBatch(lang, batch);
    for (let i = 0; i < batch.length; i++) {
      const val = await fixCopyThrough(lang, batch[i], translations[i]);
      setAtPath(langDoc, batch[i].path, val);
    }
  }
  collapseNulls(langDoc);
  return langDoc;
}

async function main() {
  if (!API_KEY) {
    console.error('OPENROUTER_API_KEY not set.');
    process.exit(1);
  }
  const slugs = pickMatches();
  if (!slugs.length) {
    console.log('No eligible matches to translate.');
    return;
  }

  const written = [];
  for (const slug of slugs) {
    // A batch this size runs unattended over several minutes; one match's
    // network hiccup or bad response must not sacrifice every match already
    // successfully translated before it, since the workflow only commits
    // once, after this whole script returns.
    try {
      const srcPath = `${DATA_DIR}/matches/${slug}.json`;
      const doc = readJSON(srcPath);
      if (doc.partial) {
        console.log(`Skipping ${slug}: still partial (Level 2 hasn't run yet).`);
        continue;
      }
      console.log(`Translating ${slug}...`);
      const i18nDoc = {};
      for (const lang of LANGS) {
        i18nDoc[lang] = await translateDoc(doc, lang);
      }
      const outPath = `${DATA_DIR}/matches/${slug}.i18n.json`;
      writeJSON(outPath, i18nDoc);

      try {
        execFileSync('node', ['scripts/validate-i18n.mjs', outPath], { stdio: 'inherit' });
      } catch {
        console.error(`Validation failed for ${slug}; removing the file so it doesn't get committed.`);
        unlinkSync(outPath);
        continue;
      }
      written.push(slug);
    } catch (e) {
      console.error(`Failed to translate ${slug}, skipping it and continuing with the rest of the batch:`, e);
    }
  }

  const githubOutput = process.env.GITHUB_OUTPUT;
  if (githubOutput) appendFileSync(githubOutput, `slugs=${written.join(', ')}\n`);
  console.log(written.length ? `Translated: ${written.join(', ')}` : 'Nothing to commit.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
