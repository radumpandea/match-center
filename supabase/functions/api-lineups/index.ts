// Edge Function: official lineups for ONE API-Football fixture, on demand.
//
// Why a function: the Match Center is a static site, so calling api-sports.io
// from the browser would publish the paid API key. The key lives here, as the
// function secret APIFOOTBALL_KEY (same key the GitHub Actions use).
//
// Request  (POST, JSON): { "fixture": <API-Football fixture id> }
// Response (JSON):
//   { fetchedAt, published, teams: [ { teamId, formation, startXI[], substitutes[] } ] }
//   - published is true only when both teams have a full 11 (the sheet is out);
//   - players are { id, number, name, pos (G/D/M/F), grid ("row:col") }.
//
// Backup: when API-Football cannot answer (daily request limit used up, outage, not configured) or has
// not published the sheet yet, the function asks ESPN's public site API instead (no key, no quota; see
// ../_shared/espn-lineups.mjs). For that the request also carries
//   "fallback": { "kickoff": "<ISO>", "home": "<team name>", "away": "<team name>", "homeId": n, "awayId": n }
// and the answer then has source "espn" (players without API-Football ids, `approx` when the placement
// on the pitch is only approximate). The browser matches those players to its own squad.
//
// Only signed-in users may call it (the anon key alone is not enough), and a
// fixture's answer is cached for 30 s per instance so that several people
// pressing the button in the same minute cost one API call.
//
// Deploy: see .github/workflows/deploy-supabase-functions.yml

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { espnLineups } from '../_shared/espn-lineups.mjs';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const CACHE_MS = 30_000;
const cache = new Map<number, { at: number; body: unknown }>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

// deno-lint-ignore no-explicit-any
// API-Football sometimes sends HTML entities in names ("L. O&apos;Nien")
const ENT: Record<string, string> = { apos: "'", quot: '"', amp: "&", lt: "<", gt: ">", nbsp: " " };
function decode(s: string): string {
  if (typeof s !== "string" || s.indexOf("&") < 0) return s;
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(parseInt(n, 10)))
    .replace(/&(apos|quot|amp|lt|gt|nbsp);/g, (_m, n) => ENT[n]);
}

function players(list: any[] | undefined) {
  return (list || [])
    // deno-lint-ignore no-explicit-any
    .map((e: any) => e && e.player)
    // deno-lint-ignore no-explicit-any
    .filter((p: any) => p && p.name)
    // deno-lint-ignore no-explicit-any
    .map((p: any) => ({
      id: p.id ?? null,
      number: p.number ?? null,
      name: decode(p.name),
      pos: p.pos ?? null,
      grid: p.grid ?? null,
    }));
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  try {
    // The caller must be a real signed-in user, not just hold the public anon key.
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: who } = await sb.auth.getUser();
    if (!who || !who.user) return json({ error: 'not_signed_in' }, 401);

    const { fixture, fallback } = await req.json().catch(() => ({}));
    const id = Number(fixture);
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad_fixture' }, 400);

    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body);

    // 1) API-Football. Any failure is remembered, not returned yet: the backup may still answer.
    // deno-lint-ignore no-explicit-any
    let apiBody: any = null;
    let apiError: Record<string, unknown> | null = null;
    const key = Deno.env.get('APIFOOTBALL_KEY');
    if (!key) {
      apiError = { error: 'not_configured' };
    } else {
      try {
        const res = await fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${id}`, {
          headers: { 'x-apisports-key': key },
        });
        if (!res.ok) {
          apiError = { error: 'upstream', status: res.status };
        } else {
          const j = await res.json();
          // API-Football reports quota / plan problems as HTTP 200 with an `errors` object.
          const errs = j.errors;
          if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
            apiError = { error: 'upstream_errors', detail: errs };
          } else {
            // deno-lint-ignore no-explicit-any
            const teams = (j.response || []).map((r: any) => ({
              teamId: r.team?.id ?? null,
              formation: r.formation ?? null,
              startXI: players(r.startXI),
              substitutes: players(r.substitutes),
            }));
            apiBody = {
              fetchedAt: new Date().toISOString(),
              source: 'api',
              // deno-lint-ignore no-explicit-any
              published: teams.length === 2 && teams.every((t: any) => t.startXI.length === 11),
              teams,
            };
          }
        }
      } catch (_e) {
        apiError = { error: 'upstream_unreachable' };
      }
    }
    if (apiBody && apiBody.published) {
      cache.set(id, { at: Date.now(), body: apiBody });
      return json(apiBody);
    }

    // 2) Backup: ESPN, when the browser sent the match to look for.
    if (fallback && fallback.kickoff && fallback.home && fallback.away) {
      try {
        const e = await espnLineups({ kickoff: String(fallback.kickoff), home: String(fallback.home), away: String(fallback.away) });
        if (e) {
          const row = (t: any, teamId: unknown) => ({
            teamId: teamId ?? null,
            formation: t.formation,
            approx: t.approx,
            startXI: t.startXI.map((p: any) => ({ ...p, name: decode(p.name) })),
            substitutes: t.substitutes.map((p: any) => ({ ...p, name: decode(p.name) })),
          });
          const body = {
            fetchedAt: new Date().toISOString(),
            source: 'espn',
            published: true,
            // why the backup was used: the API's own answer (quota, outage) or just "not out yet" there
            apiProblem: apiError ? apiError.error : 'not_published',
            teams: [row(e.teams.home, fallback.homeId), row(e.teams.away, fallback.awayId)],
          };
          cache.set(id, { at: Date.now(), body });
          return json(body);
        }
      } catch (_e) {
        // the backup is best effort; fall through to the API's own answer
      }
    }

    // 3) Nothing published anywhere: the API's answer ("not out yet"), or its error.
    if (apiBody) return json(apiBody);   // not published yet: cheap to ask again, so never cached
    return json(apiError ?? { error: 'internal' }, 502);
  } catch (_e) {
    return json({ error: 'internal' }, 500);
  }
});
