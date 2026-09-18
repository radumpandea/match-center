// Validates docs/data/matches/<slug>.i18n.json against its source
// docs/data/matches/<slug>.json.
//
//   node scripts/validate-i18n.mjs docs/data/matches/<slug>.i18n.json [more...]
//
// Two independent checks, both aimed at failure modes that would otherwise
// only show up visually, one match/language at a time, on the live site:
//
// 1. STRUCTURE — the UI (docs/app/match.js, applyI18nOverlay) maps a
//    translation onto the Romanian source by ARRAY INDEX, never by content,
//    so every translated array must have the exact same length as the
//    corresponding source array. A wrong length would silently misalign
//    every entry after the gap. A JSON Schema can't compare two different
//    files, hence this dedicated script rather than an addition to
//    docs/data/schema.json.
//
// 2. CONTENT — a translated leaf string that is byte-identical to the
//    Romanian source is almost always a sign the model copied the source
//    through untranslated (seen in practice: short, "unimportant"-looking
//    squad fields like `lastSeason`/`funfact` on bench players getting
//    skipped partway through a long file). A real coincidental match across
//    unrelated languages is vanishingly unlikely for a full sentence, so
//    this is treated as an error for prose fields. `career` is the one
//    exception (WARNING only): a source string that's already just
//    "Club (2016) · Club (2020–present)" with no Romanian words in it is
//    legitimately identical apart from "prezent" -> the target word.

import { readFileSync } from 'node:fs';

const LANGS = ['en', 'de', 'it'];

function readJSON(p) {
  return JSON.parse(readFileSync(p, 'utf8'));
}

function checkLen(errors, label, srcArr, trArr) {
  if (trArr === undefined || trArr === null) return;   // not translated -- fine, UI falls back to Romanian
  const srcLen = Array.isArray(srcArr) ? srcArr.length : 0;
  if (!Array.isArray(trArr)) { errors.push(`${label}: expected an array, got ${typeof trArr}`); return; }
  if (trArr.length !== srcLen) errors.push(`${label}: length ${trArr.length}, expected ${srcLen} (source array length)`);
}

function checkStr(errors, label, val) {
  if (val != null && typeof val !== 'string') errors.push(`${label}: expected a string or null, got ${typeof val}`);
}

// Flags a translated string that's identical to the Romanian source --
// almost certainly untranslated, not a real coincidence. `warnOnly` for
// fields (career) where an unchanged string can be legitimate.
function checkTranslated(errors, warnings, label, srcVal, trVal, warnOnly) {
  if (typeof srcVal !== 'string' || typeof trVal !== 'string') return;
  if (!srcVal.trim() || !trVal.trim()) return;
  if (srcVal !== trVal) return;
  (warnOnly ? warnings : errors).push(`${label}: identical to the Romanian source ("${srcVal.slice(0, 60)}${srcVal.length > 60 ? '…' : ''}") -- looks untranslated`);
}

function checkTranslatedArray(errors, warnings, label, srcArr, trArr, warnOnly) {
  if (!Array.isArray(srcArr) || !Array.isArray(trArr)) return;
  trArr.forEach((v, i) => checkTranslated(errors, warnings, `${label}[${i}]`, srcArr[i], v, warnOnly));
}

function validateFile(i18nPath) {
  const srcPath = i18nPath.replace(/\.i18n\.json$/, '.json');
  if (srcPath === i18nPath) return { errors: [`not a *.i18n.json path: ${i18nPath}`], warnings: [] };
  let src, i18n;
  try { src = readJSON(srcPath); } catch (e) { return { errors: [`cannot read source file ${srcPath}: ${e.message}`], warnings: [] }; }
  try { i18n = readJSON(i18nPath); } catch (e) { return { errors: [`cannot parse: ${e.message}`], warnings: [] }; }

  const errors = [];
  const warnings = [];
  for (const lang of Object.keys(i18n)) {
    if (!LANGS.includes(lang)) errors.push(`unknown language key "${lang}" (expected one of ${LANGS.join(', ')})`);
  }
  for (const lang of LANGS) {
    const tr = i18n[lang];
    if (!tr) continue;   // this language not (yet) translated -- fine

    checkLen(errors, `${lang}.storyOfTheMatch`, src.storyOfTheMatch, tr.storyOfTheMatch);
    checkTranslatedArray(errors, warnings, `${lang}.storyOfTheMatch`, src.storyOfTheMatch, tr.storyOfTheMatch);
    if (tr.h2h) {
      checkStr(errors, `${lang}.h2h.summary`, tr.h2h.summary);
      checkTranslated(errors, warnings, `${lang}.h2h.summary`, src.h2h && src.h2h.summary, tr.h2h.summary);
    }
    if (tr.referee) {
      checkStr(errors, `${lang}.referee.history`, tr.referee.history);
      checkTranslated(errors, warnings, `${lang}.referee.history`, src.referee && src.referee.history, tr.referee.history);
    }
    if (tr.venue) {
      checkStr(errors, `${lang}.venue.notes`, tr.venue.notes);
      checkTranslated(errors, warnings, `${lang}.venue.notes`, src.venue && src.venue.notes, tr.venue.notes);
      checkLen(errors, `${lang}.venue.stories`, src.venue && src.venue.stories, tr.venue.stories);
      checkTranslatedArray(errors, warnings, `${lang}.venue.stories`, src.venue && src.venue.stories, tr.venue.stories);
    }
    checkLen(errors, `${lang}.commentatorResearch`, src.commentatorResearch, tr.commentatorResearch);
    (tr.commentatorResearch || []).forEach((c, i) => {
      const sc = (src.commentatorResearch || [])[i];
      if (!c || !sc) return;
      checkTranslated(errors, warnings, `${lang}.commentatorResearch[${i}].topic`, sc.topic, c.topic);
      checkTranslated(errors, warnings, `${lang}.commentatorResearch[${i}].fact`, sc.fact, c.fact);
    });

    for (const side of ['home', 'away']) {
      const st = (src.teams && src.teams[side]) || {};
      const tt = tr.teams && tr.teams[side];
      if (!tt) continue;

      if (tt.coach !== undefined) {
        const srcCareer = st.coach && st.coach.career;
        checkLen(errors, `${lang}.teams.${side}.coach.career`, srcCareer, tt.coach && tt.coach.career);
        (tt.coach && tt.coach.career || []).forEach((c, i) => {
          const sc = (srcCareer || [])[i];
          if (!c || !sc) return;
          checkTranslated(errors, warnings, `${lang}.teams.${side}.coach.career[${i}].note`, sc.note, c.note);
        });
      }
      checkLen(errors, `${lang}.teams.${side}.news`, st.news, tt.news);
      (tt.news || []).forEach((text, i) => {
        const srcNews = (st.news || [])[i];
        checkTranslated(errors, warnings, `${lang}.teams.${side}.news[${i}]`, srcNews && srcNews.text, text);
      });
      if (tt.stories !== undefined) {
        checkLen(errors, `${lang}.teams.${side}.stories`, st.stories, tt.stories);
        (tt.stories || []).forEach((s, i) => {
          if (!s) return;
          const srcStory = (st.stories || [])[i];
          checkTranslated(errors, warnings, `${lang}.teams.${side}.stories[${i}].title`, srcStory && srcStory.title, s.title);
          checkLen(errors, `${lang}.teams.${side}.stories[${i}].bullets`, srcStory && srcStory.bullets, s.bullets);
          checkTranslatedArray(errors, warnings, `${lang}.teams.${side}.stories[${i}].bullets`, srcStory && srcStory.bullets, s.bullets);
        });
      }
      if (tt.squad !== undefined) {
        checkLen(errors, `${lang}.teams.${side}.squad`, st.squad, tt.squad);
        (tt.squad || []).forEach((p, i) => {
          if (!p) return;
          const sp = (st.squad || [])[i];
          if (!sp) return;
          checkTranslated(errors, warnings, `${lang}.teams.${side}.squad[${i}].funfact`, sp.funfact, p.funfact);
          checkTranslated(errors, warnings, `${lang}.teams.${side}.squad[${i}].linkLine`, sp.linkLine, p.linkLine);
          checkTranslated(errors, warnings, `${lang}.teams.${side}.squad[${i}].career`, sp.career, p.career, true);
          checkTranslated(errors, warnings, `${lang}.teams.${side}.squad[${i}].lastSeason`, sp.lastSeason, p.lastSeason);
          checkTranslated(errors, warnings, `${lang}.teams.${side}.squad[${i}].statusNote`, sp.statusNote, p.statusNote);
        });
      }
    }
  }
  return { errors, warnings };
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/validate-i18n.mjs <slug>.i18n.json [more...]');
  process.exit(2);
}
let ok = true;
for (const f of files) {
  const { errors, warnings } = validateFile(f);
  if (errors.length) {
    ok = false;
    console.error(`✗ ${f}`);
    for (const e of errors) console.error(`  ${e}`);
    for (const w of warnings) console.error(`  ! ${w}`);
  } else if (warnings.length) {
    console.log(`✓ ${f}  (${warnings.length} warning(s))`);
    for (const w of warnings) console.log(`  ! ${w}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
process.exit(ok ? 0 : 1);
