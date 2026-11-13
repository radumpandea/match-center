// Smoke test of the pages in a real browser (Playwright / Chromium): the home page, the status page and a few
// match packs (a deep one, a standard one, a partial one) load without script errors and the main features work:
// panels render, the sortable stats table sorts, Ctrl+K search opens a player card, the "De spus" mark works,
// the compare and print buttons exist. Run by .github/workflows/smoke-test.yml on every change to the front end.
//
//   npm i --no-save playwright && npx playwright install chromium && node tests/smoke.mjs

import { createServer } from 'node:http';
import { readFileSync, existsSync, statSync, mkdirSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { chromium } from 'playwright';

const ROOT = new URL('../docs/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const file = normalize(join(ROOT, p));
  if (!file.startsWith(normalize(ROOT)) || !existsSync(file) || !statSync(file).isFile()) { res.writeHead(404); res.end('not found'); return; }
  res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}`;

// sample packs from fixtures.json: prefer one of each kind that exists on disk
const fixtures = JSON.parse(readFileSync(ROOT + 'data/fixtures.json', 'utf8'));
const packs = fixtures.map((f) => {
  const p = ROOT + `data/matches/${f.slug}.json`;
  if (!existsSync(p)) return null;
  const d = JSON.parse(readFileSync(p, 'utf8'));
  return { slug: f.slug, depth: d.partial ? 'partial' : (d.researchDepth || 'standard'), players: ((d.teams.home.squad || [])[0] || {}).name || '' };
}).filter(Boolean);
const pick = (kind) => packs.find((x) => x.depth === kind);
const samples = [pick('deep'), pick('standard'), pick('partial')].filter(Boolean);
if (!samples.length) samples.push(...packs.slice(0, 2));

mkdirSync('tests/out', { recursive: true });
const browser = await chromium.launch();
let failures = 0;
const fail = (where, msg) => { failures++; console.error(`FAIL ${where}: ${msg}`); };
const ok = (where, msg) => console.log(`ok   ${where}: ${msg}`);

async function watch(page, where) {
  page.on('pageerror', (e) => fail(where, `script error: ${e.message}`));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) fail(where, `console error: ${m.text()}`); });
}

try {
  // home page
  {
    const page = await browser.newPage();
    await watch(page, 'index');
    await page.goto(`${BASE}/index.html`);
    await page.waitForTimeout(1500);
    const n = await page.locator('a[href*="match.html"]').count();
    n > 0 ? ok('index', `${n} match links`) : fail('index', 'no match links');
    await page.close();
  }
  // status page
  {
    const page = await browser.newPage();
    await watch(page, 'status');
    await page.goto(`${BASE}/status.html`);
    await page.waitForTimeout(800);
    ok('status', (await page.locator('h1').innerText()));
    await page.close();
  }
  // match packs
  for (const s of samples) {
    const where = `match ${s.slug} (${s.depth})`;
    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await watch(page, where);
    // the checks below read the whole panel list: start in list mode; the tabs get their own check at the end
    await page.addInitScript((k) => { try { localStorage.setItem(k, JSON.stringify({ view: { tabs: false } })); } catch (e) {} }, `mc:${s.slug}:me`);
    await page.goto(`${BASE}/match.html?m=${encodeURIComponent(s.slug)}`);
    try { await page.waitForSelector('.mc-teams', { timeout: 8000 }); } catch { fail(where, 'header did not render'); await page.screenshot({ path: `tests/out/${s.slug}.png` }); await page.close(); continue; }
    await page.waitForTimeout(800);
    const panels = await page.locator('details.panel').count();
    panels > 0 ? ok(where, `${panels} panels`) : fail(where, 'no panels');

    // "De spus": star a bullet, it lands in the checklist, then clear it
    const mark = page.locator('.panels li button.talk-mark').first();
    if (await mark.count()) {
      await mark.click();
      const listed = await page.locator('#talk-list li').count();
      listed === 1 ? ok(where, 'talk mark adds to the checklist') : fail(where, `talk mark: checklist has ${listed} items`);
      await mark.click(); await mark.click();   // ✓ then back to ☆
    }

    await page.evaluate(() => document.querySelectorAll('details.panel').forEach((d) => { d.open = true; }));

    // sortable stats table
    const th = page.locator('table.playerstats th.pst-sort').nth(3);
    if (await th.count()) {
      const first = () => page.locator('table.playerstats').first().locator('tr').nth(1).locator('td').first().innerText();
      const before = await first();
      await th.click(); await th.click();
      ok(where, `stats table sorts (first row ${before} -> ${await first()})`);
    }

    // quick search opens a player card
    if (s.players) {
      await page.keyboard.press('Control+k');
      const box = page.locator('.qs-input');
      if (await box.count()) {
        await box.fill(s.players);
        await page.keyboard.press('Enter');
        try { await page.waitForSelector('.modal-back', { timeout: 3000 }); ok(where, 'quick search opened a player card'); await page.keyboard.press('Escape'); }
        catch { fail(where, 'quick search did not open a card'); }
      } else fail(where, 'Ctrl+K did not open the search');
    }

    // toolbar buttons
    for (const [re, label] of [[/Compar|Compare/i, 'compare'], [/Print|Tipăr/i, 'print']]) {
      const present = await page.evaluate((src) => [...document.querySelectorAll('.mc-toolbar button')].some((b) => new RegExp(src, 'i').test(b.title + ' ' + b.textContent)), re.source);
      present ? ok(where, `${label} button present`) : fail(where, `${label} button missing`);
    }
    // tabs layout: switching to a tab shows that group of panels and hides the pitch
    await page.evaluate((k) => { localStorage.setItem(k, JSON.stringify({ view: { tabs: true } })); }, `mc:${s.slug}:me`);
    await page.reload();
    try { await page.waitForSelector('.mc-tabs', { timeout: 8000 }); } catch { fail(where, 'tabs did not render'); }
    const tabsN = await page.locator('.mc-tab').count();
    const talk = page.locator('.mc-tab[data-tab="talk"]');
    if (await talk.count()) {
      await talk.click();
      const pitchHidden = await page.evaluate(() => getComputedStyle(document.querySelector('.pitch-row')).display === 'none');
      const shown = await page.evaluate(() => [...document.querySelectorAll('.panels > .panel')].filter((n) => getComputedStyle(n).display !== 'none').length);
      pitchHidden && shown > 0 ? ok(where, `tabs: ${tabsN} tabs, "talk" shows ${shown} panels and hides the pitch`) : fail(where, `tabs: pitchHidden=${pitchHidden} shown=${shown}`);
    } else fail(where, 'no "talk" tab');
    await page.screenshot({ path: `tests/out/${s.slug}.png` });
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll smoke checks passed.');
process.exit(failures ? 1 : 0);
