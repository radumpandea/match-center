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
// Only signed-in users may call it (the anon key alone is not enough), and a
// fixture's answer is cached for 30 s per instance so that several people
// pressing the button in the same minute cost one API call.
//
// Deploy: see .github/workflows/deploy-supabase-functions.yml

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
      name: p.name,
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

    const { fixture } = await req.json().catch(() => ({}));
    const id = Number(fixture);
    if (!Number.isInteger(id) || id <= 0) return json({ error: 'bad_fixture' }, 400);

    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < CACHE_MS) return json(hit.body);

    const key = Deno.env.get('APIFOOTBALL_KEY');
    if (!key) return json({ error: 'not_configured' }, 500);

    const res = await fetch(`https://v3.football.api-sports.io/fixtures/lineups?fixture=${id}`, {
      headers: { 'x-apisports-key': key },
    });
    if (!res.ok) return json({ error: 'upstream', status: res.status }, 502);
    const j = await res.json();
    // API-Football reports quota / plan problems as HTTP 200 with an `errors` object.
    const errs = j.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
      return json({ error: 'upstream_errors', detail: errs }, 502);
    }

    // deno-lint-ignore no-explicit-any
    const teams = (j.response || []).map((r: any) => ({
      teamId: r.team?.id ?? null,
      formation: r.formation ?? null,
      startXI: players(r.startXI),
      substitutes: players(r.substitutes),
    }));
    const body = {
      fetchedAt: new Date().toISOString(),
      // deno-lint-ignore no-explicit-any
      published: teams.length === 2 && teams.every((t: any) => t.startXI.length === 11),
      teams,
    };
    // Only remember a published sheet for the full 30 s; "not out yet" is cheap
    // to ask again and should be seen the moment it changes.
    if (body.published) cache.set(id, { at: Date.now(), body });
    return json(body);
  } catch (_e) {
    return json({ error: 'internal' }, 500);
  }
});
