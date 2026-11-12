#!/usr/bin/env node
// Keeps the cache-busting ?v= on every docs/app/*.js and *.css reference in docs/*.html equal to a hash of
// that file's content. GitHub Pages serves assets with Cache-Control max-age=600, so a changed script that
// keeps its old ?v= is not picked up by browsers that loaded it in the last 10 minutes (the button that "was
// not there", Nov 2026). With a content hash the URL changes exactly when the file does, and never otherwise.
//
//   node scripts/stamp-assets.mjs           rewrite the HTML files in place
//   node scripts/stamp-assets.mjs --check   exit 1 (and list them) if any reference is stale; writes nothing
//
// Run automatically on every push by .github/workflows/stamp-assets.yml, which commits the HTML if anything
// was stale. Run it by hand before committing a change to docs/app/* to have the fix in the same commit.

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DOCS = fileURLToPath(new URL('../docs/', import.meta.url));
const CHECK = process.argv.includes('--check');

// CRLF -> LF first so the hash is the same on Windows (autocrlf) and on the Linux runner.
const hashOf = (file) => createHash('sha1').update(readFileSync(file, 'utf8').replace(/\r\n/g, '\n')).digest('hex').slice(0, 10);

const RE = /((?:src|href)=")(app\/[^"?#]+\.(?:js|css))(?:\?v=[^"]*)?(")/g;
let stale = 0;
for (const name of readdirSync(DOCS).filter((f) => f.endsWith('.html'))) {
  const file = path.join(DOCS, name);
  const html = readFileSync(file, 'utf8');
  const next = html.replace(RE, (m, pre, rel, post) => {
    const asset = path.join(DOCS, rel);
    if (!existsSync(asset)) { console.warn(`${name}: ${rel} does not exist, left alone`); return m; }
    return `${pre}${rel}?v=${hashOf(asset)}${post}`;
  });
  if (next !== html) {
    stale++;
    console.log(`${CHECK ? 'stale' : 'stamped'}: docs/${name}`);
    if (!CHECK) writeFileSync(file, next);
  }
}
if (CHECK && stale) { console.error(`${stale} page(s) reference outdated asset versions; run node scripts/stamp-assets.mjs`); process.exit(1); }
if (!stale) console.log('Asset versions already up to date.');
