#!/usr/bin/env node
// Writes docs/data/health.json: for every active workflow of the repo, how its last runs went, so the status
// page (docs/status.html) and the banner on the home page can say "Sync Entities failed 2 h ago" instead of the
// failure being found in a stray e-mail. Reads the Actions API with the job's GITHUB_TOKEN; no secrets, no API-Football.
//
// Writes only when something that matters changed (a workflow whose last run failed, the failure counts) or the
// file is older than 20 h, so it does not add a commit to every run.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/build-health.mjs

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const TOKEN = process.env.GITHUB_TOKEN;
const REPO = process.env.GITHUB_REPOSITORY;
const OUT = 'docs/data/health.json';
if (!TOKEN || !REPO) { console.error('Need GITHUB_TOKEN and GITHUB_REPOSITORY.'); process.exit(1); }

async function gh(path) {
  const res = await fetch(`https://api.github.com/repos/${REPO}${path}`, {
    headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
  });
  if (!res.ok) throw new Error(`GitHub ${path} -> HTTP ${res.status}`);
  return res.json();
}

// workflows that only exist to be started by hand: a failure there is not an outage
const MANUAL = /one-off|probe|add fixture|supabase sql|deploy supabase|claude code/i;

const now = Date.now();
const week = now - 7 * 86400000;
const wf = (await gh('/actions/workflows?per_page=100')).workflows.filter((w) => w.state === 'active');
const out = [];
for (const w of wf) {
  const runs = (await gh(`/actions/workflows/${w.id}/runs?per_page=20&exclude_pull_requests=true`)).workflow_runs
    .filter((r) => r.status === 'completed' && !['cancelled', 'skipped'].includes(r.conclusion));
  if (!runs.length) continue;
  const last = runs[0];
  const lastOk = runs.find((r) => r.conclusion === 'success');
  out.push({
    name: w.name,
    file: w.path.split('/').pop(),
    manual: MANUAL.test(w.name),
    last: { at: last.created_at, conclusion: last.conclusion, url: last.html_url },
    lastSuccessAt: lastOk ? lastOk.created_at : null,
    failures7d: runs.filter((r) => r.conclusion === 'failure' && new Date(r.created_at).getTime() > week).length,
    runs7d: runs.filter((r) => new Date(r.created_at).getTime() > week).length,
  });
}
out.sort((a, b) => (b.last.conclusion === 'failure') - (a.last.conclusion === 'failure') || b.failures7d - a.failures7d || a.name.localeCompare(b.name));
const failing = out.filter((x) => x.last.conclusion === 'failure' && !x.manual).map((x) => x.name);

const next = { generatedAt: new Date().toISOString(), failing, workflows: out };
let write = true;
if (existsSync(OUT)) {
  try {
    const prev = JSON.parse(readFileSync(OUT, 'utf8'));
    const sig = (h) => JSON.stringify([h.failing, (h.workflows || []).map((x) => [x.name, x.last.conclusion, x.failures7d])]);
    if (sig(prev) === sig(next) && now - new Date(prev.generatedAt).getTime() < 20 * 3600000) write = false;
  } catch { /* rewrite */ }
}
if (write) { writeFileSync(OUT, JSON.stringify(next, null, 1) + '\n'); console.log(`health.json written: ${out.length} workflows, ${failing.length} failing${failing.length ? ' (' + failing.join(', ') + ')' : ''}.`); }
else console.log('No change worth a commit.');
