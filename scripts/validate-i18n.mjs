// Validates docs/data/matches/<slug>.i18n.json against its source
// docs/data/matches/<slug>.json.
//
//   node scripts/validate-i18n.mjs docs/data/matches/<slug>.i18n.json [more...]
//
// The UI (docs/app/match.js, applyI18nOverlay) maps a translation onto the
// Romanian source by ARRAY INDEX, never by content — so the one thing that
// actually matters here is that every translated array has the exact same
// length as the corresponding array in the source file. A wrong length would
// silently misalign every entry after the gap without ever throwing at
// render time, which is why this needs its own check rather than relying on
// docs/data/schema.json (a JSON Schema can't compare two different files).

import { readFileSync } from 'node:fs';

const LANGS = ['en', 'fr', 'de', 'it'];

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

function validateFile(i18nPath) {
  const srcPath = i18nPath.replace(/\.i18n\.json$/, '.json');
  if (srcPath === i18nPath) return [`not a *.i18n.json path: ${i18nPath}`];
  let src, i18n;
  try { src = readJSON(srcPath); } catch (e) { return [`cannot read source file ${srcPath}: ${e.message}`]; }
  try { i18n = readJSON(i18nPath); } catch (e) { return [`cannot parse: ${e.message}`]; }

  const errors = [];
  for (const lang of Object.keys(i18n)) {
    if (!LANGS.includes(lang)) errors.push(`unknown language key "${lang}" (expected one of ${LANGS.join(', ')})`);
  }
  for (const lang of LANGS) {
    const tr = i18n[lang];
    if (!tr) continue;   // this language not (yet) translated -- fine

    checkLen(errors, `${lang}.storyOfTheMatch`, src.storyOfTheMatch, tr.storyOfTheMatch);
    if (tr.h2h) checkStr(errors, `${lang}.h2h.summary`, tr.h2h.summary);
    if (tr.referee) checkStr(errors, `${lang}.referee.history`, tr.referee.history);
    if (tr.venue) {
      checkStr(errors, `${lang}.venue.notes`, tr.venue.notes);
      checkLen(errors, `${lang}.venue.stories`, src.venue && src.venue.stories, tr.venue.stories);
    }
    checkLen(errors, `${lang}.commentatorResearch`, src.commentatorResearch, tr.commentatorResearch);

    for (const side of ['home', 'away']) {
      const st = (src.teams && src.teams[side]) || {};
      const tt = tr.teams && tr.teams[side];
      if (!tt) continue;

      if (tt.coach !== undefined) {
        checkLen(errors, `${lang}.teams.${side}.coach.career`, st.coach && st.coach.career, tt.coach && tt.coach.career);
      }
      checkLen(errors, `${lang}.teams.${side}.news`, st.news, tt.news);
      if (tt.stories !== undefined) {
        checkLen(errors, `${lang}.teams.${side}.stories`, st.stories, tt.stories);
        (tt.stories || []).forEach((s, i) => {
          if (!s) return;
          const srcStory = (st.stories || [])[i];
          checkLen(errors, `${lang}.teams.${side}.stories[${i}].bullets`, srcStory && srcStory.bullets, s.bullets);
        });
      }
      if (tt.squad !== undefined) {
        checkLen(errors, `${lang}.teams.${side}.squad`, st.squad, tt.squad);
      }
    }
  }
  return errors;
}

const files = process.argv.slice(2);
if (!files.length) {
  console.error('Usage: node scripts/validate-i18n.mjs <slug>.i18n.json [more...]');
  process.exit(2);
}
let ok = true;
for (const f of files) {
  const errors = validateFile(f);
  if (errors.length) {
    ok = false;
    console.error(`✗ ${f}`);
    for (const e of errors) console.error(`  ${e}`);
  } else {
    console.log(`✓ ${f}`);
  }
}
process.exit(ok ? 0 : 1);
