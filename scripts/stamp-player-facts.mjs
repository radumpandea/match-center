// Deterministic, no AI: marks the player-fact files written in THIS run with "rev": 2.
//
// Rev 2 = written by the careful Sonnet pass (faithful to the article, see the prompt in
// build-player-facts.yml). Files without it come from the first, Haiku-written pass, which
// garbled rounds and wording, so pick-player-facts.mjs queues them again and
// apply-player-facts.mjs lets a rev-2 file replace the facts already copied into a pack.
//
// "Written in this run" = modified or untracked in the working tree under
// docs/data/players (the research step is the only thing that touched it). Requires Node 18+.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const REV = 2;
const out = execSync('git status --porcelain --untracked-files=all -- docs/data/players', { encoding: 'utf8' });
let n = 0;
for (const line of out.split('\n')) {
  const m = /^\s*(?:M|\?\?|A|AM)\s+(\S+\.json)\s*$/.exec(line);
  if (!m) continue;
  let j;
  try { j = JSON.parse(readFileSync(m[1], 'utf8')); } catch { continue; }
  if (j.rev === REV) continue;
  j.rev = REV;
  writeFileSync(m[1], JSON.stringify(j, null, 2) + '\n', 'utf8');
  n++;
}
console.log(`Stamped rev ${REV} on ${n} player file(s).`);
