// Edge Function: live score + events for the matches in progress, written to the mc_live_* tables (supabase/live.sql).
//
// Called by pg_cron every 30 s (no user, so verify_jwt = false in supabase/config.toml). It spends API-Football
// requests only after mc_live_claim() agrees, so calling it more often, or by anyone, costs nothing extra:
//   - one poll per 20 s while a watched match is in progress (and for 10 minutes after the last one), otherwise per 170 s;
//   - at most 3500 polls per UTC day.
// Each poll = one `fixtures?live=<leagues>` call (scores + events of everything in progress), plus one
// `fixtures?ids=...` call when a match we were following dropped out of the live list (to get its final state).
//
// The key is the function secret APIFOOTBALL_KEY (kept in step with the GitHub secret by deploy-supabase-functions.yml).
// Events are mutable, see ../_shared/live-reconcile.mjs.

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { fixtureRow, fromRow, normalizeEvent, patchToRow, reconcile, toRow } from '../_shared/live-reconcile.mjs';

const API = 'https://v3.football.api-sports.io';
const EMPTY_POLLS_BEFORE_REMOVING_ALL = 3;   // an empty event list for 3 polls in a row (~1 min) is believed

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// deno-lint-ignore no-explicit-any
async function apiGet(key: string, path: string): Promise<{ ok: boolean; fixtures: any[]; error?: string }> {
  try {
    const res = await fetch(API + path, { headers: { 'x-apisports-key': key } });
    if (!res.ok) return { ok: false, fixtures: [], error: 'http_' + res.status };
    const j = await res.json();
    const errs = j.errors;
    if (errs && (Array.isArray(errs) ? errs.length : Object.keys(errs).length)) {
      return { ok: false, fixtures: [], error: 'api: ' + JSON.stringify(errs).slice(0, 200) };
    }
    return { ok: true, fixtures: Array.isArray(j.response) ? j.response : [] };
  } catch (e) {
    return { ok: false, fixtures: [], error: 'unreachable: ' + String(e).slice(0, 120) };
  }
}

Deno.serve(async (_req: Request) => {
  const key = Deno.env.get('APIFOOTBALL_KEY');
  const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });
  if (!key) return json({ skipped: 'not_configured' });

  const claim = await sb.rpc('mc_live_claim');
  if (claim.error) return json({ error: 'claim', detail: claim.error.message }, 500);
  if (!claim.data || !claim.data.ok) return json({ skipped: claim.data ? claim.data.reason : 'no_answer' });
  const leagues: number[] = claim.data.leagues || [];

  let extraRequests = 0;
  let error: string | null = null;
  let active = false;
  const summary = { fixtures: 0, inserted: 0, updated: 0, removed: 0 };

  try {
    // 1) everything in progress in the watched leagues
    // deno-lint-ignore no-explicit-any
    let list: any[] = [];
    if (leagues.length) {
      const live = await apiGet(key, '/fixtures?live=' + leagues.join('-'));
      if (!live.ok) throw new Error(live.error);
      list = live.fixtures;
    }
    const liveIds = new Set(list.map((f) => f.fixture.id));

    // 2) matches we were following that left the live list: ask for their final state (one call, up to 20 ids)
    const open = await sb.from('mc_live_fixtures').select('fixture_id').eq('finished', false);
    if (open.error) throw new Error('read open fixtures: ' + open.error.message);
    const dropped: number[] = (open.data || []).map((r: { fixture_id: number }) => r.fixture_id).filter((id: number) => !liveIds.has(id)).slice(0, 20);
    if (dropped.length) {
      extraRequests++;
      const fin = await apiGet(key, '/fixtures?ids=' + dropped.join('-'));
      if (!fin.ok) throw new Error(fin.error);
      list = list.concat(fin.fixtures);
    }
    // a match that never got a final answer (abandoned feed): stop following it after 6 h
    await sb.from('mc_live_fixtures').update({ finished: true }).eq('finished', false)
      .lt('fetched_at', new Date(Date.now() - 6 * 3600 * 1000).toISOString());

    summary.fixtures = list.length;
    active = list.some((f) => !fixtureRow(f).finished);
    if (list.length) {
      const now = new Date().toISOString();
      const ids = list.map((f) => f.fixture.id);

      const ex = await sb.from('mc_live_fixtures').select('fixture_id,empty_polls').in('fixture_id', ids);
      if (ex.error) throw new Error('read fixtures: ' + ex.error.message);
      const emptyBefore = new Map<number, number>((ex.data || []).map((r: { fixture_id: number; empty_polls: number }) => [r.fixture_id, r.empty_polls]));

      const evs = await sb.from('mc_live_events').select('*').in('fixture_id', ids).eq('present', true).order('id');
      if (evs.error) throw new Error('read events: ' + evs.error.message);
      // deno-lint-ignore no-explicit-any
      const byFixture = new Map<number, any[]>();
      for (const r of evs.data || []) {
        if (!byFixture.has(r.fixture_id)) byFixture.set(r.fixture_id, []);
        byFixture.get(r.fixture_id)!.push(fromRow(r));
      }

      // fixtures first (events reference them)
      const rows = list.map((f) => {
        const incoming = (f.events || []).length;
        const stored = (byFixture.get(f.fixture.id) || []).length;
        const empty = incoming === 0 && stored > 0 ? (emptyBefore.get(f.fixture.id) || 0) + 1 : 0;
        return { ...fixtureRow(f), empty_polls: empty, fetched_at: now, updated_at: now };
      });
      const up = await sb.from('mc_live_fixtures').upsert(rows, { onConflict: 'fixture_id' });
      if (up.error) throw new Error('write fixtures: ' + up.error.message);

      for (const f of list) {
        const id = f.fixture.id;
        const row = rows.find((r) => r.fixture_id === id)!;
        const stored = byFixture.get(id) || [];
        // deno-lint-ignore no-explicit-any
        const incoming = (f.events || []).map((e: any) => normalizeEvent(e));
        if (!incoming.length && stored.length && row.empty_polls < EMPTY_POLLS_BEFORE_REMOVING_ALL) continue;   // probably a glitch
        const r = reconcile(stored, incoming);
        if (r.inserts.length) {
          const ins = await sb.from('mc_live_events').insert(r.inserts.map((e) => toRow(id, e)));
          if (ins.error) throw new Error('insert events: ' + ins.error.message);
          summary.inserted += r.inserts.length;
        }
        for (const u of r.updates) {
          const old = stored.find((s) => s.id === u.id);
          // a stored value filled in / changed by this poll: count it as an edit so the page can say "updated"
          const upd = await sb.from('mc_live_events')
            .update({ ...patchToRow(u.patch), updated_at: now, edited_at: now, edits: (old?.edits ?? 0) + 1 })
            .eq('id', u.id);
          if (upd.error) throw new Error('update event: ' + upd.error.message);
          summary.updated++;
        }
        if (r.removals.length) {
          const rm = await sb.from('mc_live_events').update({ present: false, removed_at: now, updated_at: now }).in('id', r.removals);
          if (rm.error) throw new Error('remove events: ' + rm.error.message);
          summary.removed += r.removals.length;
        }
      }
    }
  } catch (e) {
    error = String((e as Error).message || e).slice(0, 300);
  }

  await sb.rpc('mc_live_done', { p_extra_requests: extraRequests, p_active: active, p_error: error });
  return json(error ? { error, ...summary } : { ok: true, active, ...summary });
});
