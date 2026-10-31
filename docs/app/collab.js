/* Optional collaboration layer for the static GitHub Pages app.
   It deliberately degrades to localStorage if Supabase is not configured. */
(function () {
  'use strict';
  var t = window.MC_I18N.t;
  var cfg = window.PM_CONFIG || {};
  var enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var client = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  var user = null, name = '', activeSlug = '', timer = null, onRemote = null, getLocal = null;
  var favs = {};
  var FAV_LIMIT = 4;   // matches the mc_favourites_cap trigger in supabase.sql

  function localName() { return localStorage.getItem('mc:displayName') || ''; }
  function setLocalName(v) { localStorage.setItem('mc:displayName', v); }
  function cleanName(v) { return String(v || '').trim().replace(/\s+/g, ' ').slice(0, 40); }
  function configured() { return enabled; }
  function json(v) { try { return JSON.stringify(v || {}); } catch (e) { return '{}'; } }
  function emit() { window.dispatchEvent(new CustomEvent('mc-collab', { detail: status() })); }
  function status() { return { configured: enabled, online: !!user, name: name, favourites: Object.keys(favs) }; }

  async function ensureUser() {
    if (!enabled) return null;
    var got = await client.auth.getUser();
    user = got.data && got.data.user;
    try { var sess = await client.auth.getSession(); token = (sess.data && sess.data.session && sess.data.session.access_token) || ''; } catch (e) { token = ''; }
    name = localName() || (user && user.user_metadata && user.user_metadata.display_name) || (user && user.email ? user.email.split('@')[0] : '');
    emit();
    return user;
  }

  async function sendMagicLink(email) {
    if (!enabled) throw new Error(t('collab.notConfigured'));
    var clean = String(email || '').trim();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(clean)) throw new Error(t('collab.invalidEmail'));
    var res = await client.auth.signInWithOtp({
      email: clean,
      // Keep the exact match query too: returning to match.html without ?m=
      // would discard the screen the user was working on after authentication.
      options: { emailRedirectTo: location.origin + location.pathname + location.search }
    });
    if (res.error) throw res.error;
    return clean;
  }

  async function signOut() {
    if (!enabled) return;
    var res = await client.auth.signOut();
    if (res.error) throw res.error;
    user = null; favs = {}; name = ''; synced = false; token = ''; emit();
  }

  function changedAreas(before, after) {
    var a = before || {}, b = after || {};
    var keys = ['notes', 'lineup', 'xi', 'bench', 'events', 'captain', 'pnum', 'panelExtra', 'manual', 'discColors', 'view', 'panelOrder', 'confirmed', 'apiLineup'];
    return keys.filter(function (k) { return canon(a[k]) !== canon(b[k]); }).map(function (k) { return t('collab.change.' + k); });
  }

  async function loadFavourites() {
    if (!user) return;
    var res = await client.from('mc_favourites').select('match_slug').eq('user_id', user.id);
    if (res.error) return;
    favs = {};
    (res.data || []).forEach(function (r) { favs[r.match_slug] = true; });
    emit();
  }

  /* ---------- shared match state: three-way merge sync ----------
     The shared state (notes, events, captain, ...) is one jsonb document per
     match. Writing this device's copy over it would erase whatever another
     device (or colleague) saved in the meantime, so every write is a merge of
       base   = the server state this device last saw (also kept in localStorage),
       local  = what is on this screen now,
       remote = what the server holds right now.
     Lists of {id, ...} items (notes, events) merge item by item: an item added
     on either side is kept, an item deleted on this side is deleted. */
  var BASE_KEY = function (slug) { return 'mc:' + slug + ':base'; };
  var base = {}, lastAt = null, token = '';
  var synced = false, dirty = false, writing = false, again = false, pendingLog = false;
  var retryTimer = null, lastPull = 0, attachedGlobal = false, startTries = 0;

  function canon(v) {
    if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
    if (v && typeof v === 'object') return '{' + Object.keys(v).sort().map(function (k) { return JSON.stringify(k) + ':' + canon(v[k]); }).join(',') + '}';
    return JSON.stringify(v);
  }
  function same(a, b) { return canon(a) === canon(b); }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function isObj(v) { return !!v && typeof v === 'object' && !Array.isArray(v); }
  function isIdList(a) { return Array.isArray(a) && a.every(function (x) { return isObj(x) && typeof x.id === 'string'; }); }
  function byId(list) { var m = {}; list.forEach(function (x) { m[x.id] = x; }); return m; }

  function mergeLists(b, l, r) {
    var bm = byId(b), lm = byId(l), seen = {}, out = [];
    r.forEach(function (it) {
      seen[it.id] = true;
      if (bm[it.id] && !lm[it.id]) return;                    // deleted on this device
      out.push(lm[it.id] ? merge3(bm[it.id], lm[it.id], it) : it);
    });
    l.forEach(function (it) { if (!seen[it.id] && !bm[it.id]) out.push(it); });   // added on this device (if the server dropped it, it was deleted there)
    return out;
  }
  function merge3(b, l, r) {
    if (same(l, b)) return r;                                 // untouched here: the server's value
    if (same(r, b) || same(l, r)) return l;                   // untouched on the server: ours
    if (isObj(l) && isObj(r)) {
      var bb = isObj(b) ? b : {}, out = {}, keys = {};
      [l, r].forEach(function (o) { Object.keys(o).forEach(function (k) { keys[k] = true; }); });
      Object.keys(keys).forEach(function (k) {
        var v = merge3(bb[k], l[k], r[k]);
        if (v !== undefined) out[k] = v;
      });
      return out;
    }
    if (isIdList(l) && isIdList(r)) return mergeLists(isIdList(b) ? b : [], l, r);
    return l;                                                 // both changed the same value: this device wins
  }

  function localNow() { var v = getLocal ? getLocal() : null; return clone(v && typeof v === 'object' ? v : {}); }
  function saveBase() { try { localStorage.setItem(BASE_KEY(activeSlug), JSON.stringify(base)); } catch (e) {} }
  function loadBase() { try { return JSON.parse(localStorage.getItem(BASE_KEY(activeSlug))) || {}; } catch (e) { return {}; } }
  function isEmpty(v) { return !v || !Object.keys(v).length; }
  function applyToScreen(merged, by) {
    var now = localNow();
    if (!same(merged, now) && onRemote) onRemote(clone(merged), by);
  }
  function scheduleFlush(ms, log) {
    dirty = true; if (log) pendingLog = true;
    clearTimeout(timer); timer = setTimeout(flush, ms);
  }

  // Reads the server copy and folds it into the screen (and queues a write if
  // this device holds something the server does not).
  async function pull() {
    var res = await client.from('mc_match_state').select('state,updated_at').eq('match_slug', activeSlug).maybeSingle();
    if (res.error) throw res.error;
    var remote = res.data ? (res.data.state || {}) : null;
    var local = localNow();
    var merged = remote ? merge3(base, local, remote) : local;
    base = clone(remote || {}); saveBase();
    lastAt = res.data ? res.data.updated_at : null;
    applyToScreen(merged);
    if (!isEmpty(merged) && !same(merged, remote || {})) scheduleFlush(0, false);
    lastPull = Date.now();
  }

  async function flush() {
    if (!enabled || !user || !activeSlug || !synced) return;
    if (writing) { again = true; return; }
    writing = true; clearTimeout(timer); clearTimeout(retryTimer);
    var log = pendingLog; pendingLog = false;
    try {
      for (var attempt = 0; attempt < 4; attempt++) {
        var cur = await client.from('mc_match_state').select('state,updated_at').eq('match_slug', activeSlug).maybeSingle();
        if (cur.error) throw cur.error;
        var remote = cur.data ? (cur.data.state || {}) : null;
        var local = localNow();
        var merged = remote ? merge3(base, local, remote) : local;
        if (remote ? same(merged, remote) : isEmpty(merged)) {      // nothing to write
          base = clone(remote || {}); saveBase(); lastAt = cur.data ? cur.data.updated_at : null;
          applyToScreen(merged); dirty = false; return;
        }
        var now = new Date().toISOString();
        var row = { match_slug: activeSlug, state: merged, updated_by: user.id, updated_by_name: name, updated_at: now };
        var res;
        if (!cur.data) res = await client.from('mc_match_state').insert(row);
        else {
          var q = client.from('mc_match_state').update(row).eq('match_slug', activeSlug);
          if (attempt < 3) q = q.eq('updated_at', cur.data.updated_at);   // only if nobody wrote in between
          res = await q.select('match_slug');
        }
        if (res.error) { if (!cur.data && res.error.code === '23505') continue; throw res.error; }
        if (cur.data && !(res.data && res.data.length)) continue;          // somebody wrote in between: merge again
        var areas = changedAreas(remote || {}, merged);
        if (log && areas.length) {
          await client.from('mc_match_changes').insert({ match_slug: activeSlug, user_id: user.id, display_name: name, summary: t('collab.changedSummary', { areas: areas.join(', ') }), changed_at: now });
        }
        base = clone(merged); saveBase(); lastAt = now;
        // keep what was typed while the request was in flight
        var typed = localNow();
        applyToScreen(merge3(local, typed, merged));
        dirty = !same(typed, merged);
        return;
      }
    } catch (e) {
      console.warn(t('collab.syncFailed'), e);
      dirty = true; pendingLog = pendingLog || log;
      retryTimer = setTimeout(flush, 10000);
    } finally {
      writing = false;
      if (again) { again = false; scheduleFlush(0, false); }
    }
  }

  function persist(state) {
    if (!enabled || !user || !synced) return;
    if (same(state, base)) return;
    scheduleFlush(500, true);
  }

  // The tab is going away: a normal request may never finish, so send the
  // state in a keep-alive request that only applies if nobody wrote since.
  function flushOnExit() {
    if (!dirty || !synced || !user || !token || !lastAt || !activeSlug) return;
    var local = localNow();
    if (same(local, base)) return;
    var body = JSON.stringify({ state: local, updated_by: user.id, updated_by_name: name, updated_at: new Date().toISOString() });
    if (body.length > 60000) return;
    try {
      fetch(cfg.supabaseUrl + '/rest/v1/mc_match_state?match_slug=eq.' + encodeURIComponent(activeSlug) + '&updated_at=eq.' + encodeURIComponent(lastAt), {
        method: 'PATCH', keepalive: true,
        headers: { apikey: cfg.supabaseAnonKey, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
        body: body
      });
    } catch (e) { /* the next load merges it */ }
  }

  function attachGlobal() {
    if (attachedGlobal) return;
    attachedGlobal = true;
    document.addEventListener('visibilitychange', function () {
      if (!synced) return;
      if (document.visibilityState === 'hidden') { if (dirty) flush(); }
      else refresh();
    });
    window.addEventListener('pagehide', flushOnExit);
    window.addEventListener('online', function () { if (synced) { if (dirty) flush(); refresh(); } });
    window.addEventListener('focus', function () { if (synced) refresh(); });
    client.auth.onAuthStateChange(function (ev, session) { token = (session && session.access_token) || ''; });
  }
  // Another device of the same account (or a colleague) may have saved while
  // this tab sat in the background or offline.
  function refresh() {
    if (!synced || writing || Date.now() - lastPull < 5000) return;
    pull().catch(function (e) { console.warn(t('collab.syncFailed'), e); });
  }

  async function start(slug, localState, remoteCallback) {
    activeSlug = slug; onRemote = remoteCallback;
    getLocal = typeof localState === 'function' ? localState : function () { return localState; };
    if (!enabled) { emit(); return; }
    try {
      await ensureUser();
      if (!user) { emit(); return; }
      base = loadBase();
      await loadFavourites();
      await pull();
      synced = true;
      attachGlobal();
      client.channel('mc-state-' + slug)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'mc_match_state', filter: 'match_slug=eq.' + slug }, function (payload) {
          var st = payload.new && payload.new.state;
          if (!st || !synced) return;
          if (same(st, base)) return;                    // the echo of our own write
          lastAt = payload.new.updated_at;
          var merged = merge3(base, localNow(), st);
          base = clone(st); saveBase();
          applyToScreen(merged, payload.new.updated_by);
          if (!same(merged, st)) scheduleFlush(500, false);
        }).subscribe();
    } catch (e) {
      // Do not give up on sharing for the whole session after one failed
      // request: the local copy stays safe and the sync is tried again.
      console.warn('Match Center collaboration is unavailable.', e);
      if (++startTries <= 5) setTimeout(function () { start(slug, localState, remoteCallback); }, 5000 * startTries);
      else { enabled = false; emit(); }
    }
  }

  async function setName(value) {
    name = cleanName(value) || t('collab.defaultUser'); setLocalName(name); emit();
    if (user && activeSlug) {
      await client.from('mc_match_state').update({ updated_by_name: name }).eq('match_slug', activeSlug).eq('updated_by', user.id);
    }
  }

  function isFavourite(slug) {
    if (!enabled) {
      try { return !!JSON.parse(localStorage.getItem('mc:favourites') || '{}')[slug]; } catch (e) { return false; }
    }
    return !!favs[slug];
  }
  // `staleSlugs` (optional): the caller's own list of the user's currently
  // favourited slugs whose match has already been played -- callers know
  // this (they have fixtures.json's kickoff times), this module doesn't.
  // Adding a new favourite prunes those first instead of counting them
  // against FAV_LIMIT forever: a played match never gets un-favourited by
  // itself otherwise, so once someone hit 4 they could never favourite
  // anything again, even with nothing upcoming left in the list.
  async function toggleFavourite(slug, staleSlugs) {
    if (!enabled) {
      var local = JSON.parse(localStorage.getItem('mc:favourites') || '{}');
      if (!local[slug]) {
        var active = Object.keys(local).filter(function (k) { return local[k]; });
        if (active.length >= FAV_LIMIT && Array.isArray(staleSlugs)) {
          staleSlugs.forEach(function (s) { delete local[s]; });
          active = Object.keys(local).filter(function (k) { return local[k]; });
        }
        if (active.length >= FAV_LIMIT) {
          throw new Error(t('collab.favouriteLimit', { limit: FAV_LIMIT }));
        }
      }
      local[slug] = !local[slug]; localStorage.setItem('mc:favourites', JSON.stringify(local)); return !!local[slug];
    }
    await ensureUser();
    if (!user) throw new Error(t('collab.loginRequired'));
    if (favs[slug]) {
      var del = await client.from('mc_favourites').delete().eq('user_id', user.id).eq('match_slug', slug);
      if (del.error) throw del.error;
      delete favs[slug];
    } else {
      if (Object.keys(favs).length >= FAV_LIMIT && Array.isArray(staleSlugs) && staleSlugs.length) {
        var toPrune = staleSlugs.filter(function (s) { return favs[s]; });
        if (toPrune.length) {
          var delMany = await client.from('mc_favourites').delete().eq('user_id', user.id).in('match_slug', toPrune);
          if (!delMany.error) toPrune.forEach(function (s) { delete favs[s]; });
        }
      }
      if (Object.keys(favs).length >= FAV_LIMIT) {
        throw new Error(t('collab.favouriteLimit', { limit: FAV_LIMIT }));
      }
      var ins = await client.from('mc_favourites').insert({ user_id: user.id, match_slug: slug });
      if (ins.error) throw ins.error;
      favs[slug] = true;
    }
    emit(); return !!favs[slug];
  }

  async function changes(slug) {
    if (!enabled) return [];
    var res = await client.from('mc_match_changes').select('display_name,summary,changed_at').eq('match_slug', slug).order('changed_at', { ascending: false }).limit(20);
    return res.error ? [] : (res.data || []);
  }

  async function ready() {
    if (!enabled) { emit(); return; }
    try { await ensureUser(); if (user) await loadFavourites(); } catch (e) { enabled = false; emit(); }
  }

  // Canonical cross-match entity (team/player/coach/referee), keyed by
  // `entityKey` -- 'af:<API-Football id>' for team/player/coach, or
  // 'name:<surname>[-<first-initial>]' for referees (API-Football gives no
  // referee id, so the surname is the closest thing to a stable identity —
  // see scripts/sync-referee-entities.mjs). See docs/supabase.sql,
  // mc_entities. Public read, no login required, since it replaces facts
  // that used to be copy-pasted into every match file that mentions the same
  // real person. Returns null on any failure (not configured, row missing,
  // offline) so callers keep using their embedded match-file copy as the
  // fallback — this is a read-through enhancement, never a hard dependency.
  async function getEntity(kind, entityKey) {
    if (!enabled || !entityKey) return null;
    try {
      var res = await client.from('mc_entities').select('base,overrides')
        .eq('kind', kind).eq('entity_key', entityKey).maybeSingle();
      if (res.error || !res.data) return null;
      var merged = Object.assign({}, res.data.base || {}, res.data.overrides || {});
      if (typeof merged.name === 'string') merged.name = decodeEntityText(merged.name);
      return merged;
    } catch (e) { return null; }
  }

  // Batched version of getEntity() -- one round trip for many keys (e.g. an
  // entire squad's worth of player entity keys) instead of one query per
  // player. Returns a map of entityKey -> merged entity (base || overrides);
  // keys with no row or that fail are simply absent from the map, same
  // fallback contract as getEntity().
  var ENTITY_CHARS = { apos: "'", quot: '"', amp: '&', lt: '<', gt: '>', nbsp: ' ' };
  function decodeEntityText(s) {
    return String(s).replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCodePoint(parseInt(h, 16)); })
      .replace(/&#(\d+);/g, function (m, n) { return String.fromCodePoint(parseInt(n, 10)); })
      .replace(/&(apos|quot|amp|lt|gt|nbsp);/g, function (m, n) { return ENTITY_CHARS[n]; });
  }

  async function getEntities(kind, entityKeys) {
    var keys = Array.from(new Set((entityKeys || []).filter(Boolean)));
    if (!enabled || !keys.length) return {};
    try {
      var res = await client.from('mc_entities').select('entity_key,base,overrides')
        .eq('kind', kind).in('entity_key', keys);
      if (res.error || !res.data) return {};
      var out = {};
      res.data.forEach(function (row) {
        var ov = Object.assign({}, row.overrides || {});
        // A player's display name is a private, per-user choice (see
        // match.js `mine.pname`); a shared `name` override written before that
        // change must not reach other users, so only the API name counts.
        if (kind === 'player') delete ov.name;
        var merged = Object.assign({}, row.base || {}, ov);
        // names synced while the API still sent HTML entities ("L. O&apos;Nien") are decoded on read
        if (typeof merged.name === 'string') merged.name = decodeEntityText(merged.name);
        out[row.entity_key] = merged;
      });
      return out;
    } catch (e) { return {}; }
  }

  // Writes ONE field of the shared `overrides` layer of an mc_entities row
  // (kind: 'coach' | 'player', entityKey: 'af:<id>') -- a user correction that
  // every match reading that entity picks up (getEntity/getEntities merge
  // base || overrides). value null/'' removes the override. Needs a signed-in
  // user (RLS: authenticated users update/insert). Logged to mc_entity_changes.
  // Resolves { ok } and never throws: callers treat it as best-effort.
  async function setEntityOverride(kind, entityKey, field, value, apiId) {
    if (!enabled || !user || !entityKey) return { ok: false, reason: 'offline' };
    try {
      var cur = await client.from('mc_entities').select('base,overrides').eq('kind', kind).eq('entity_key', entityKey).maybeSingle();
      if (cur.error) throw cur.error;
      var now = new Date().toISOString();
      var overrides = Object.assign({}, (cur.data && cur.data.overrides) || {});
      var clear = value == null || value === '';
      var oldVal = overrides[field] !== undefined ? overrides[field] : (((cur.data && cur.data.base) || {})[field]);
      if (clear) delete overrides[field]; else overrides[field] = value;
      var res = cur.data
        ? await client.from('mc_entities').update({ overrides: overrides, updated_by: user.id, updated_by_name: name, updated_at: now }).eq('kind', kind).eq('entity_key', entityKey)
        : await client.from('mc_entities').insert({ kind: kind, entity_key: entityKey, api_id: apiId == null ? null : apiId, base: {}, overrides: overrides, updated_by: user.id, updated_by_name: name, updated_at: now });
      if (res.error) throw res.error;
      await client.from('mc_entity_changes').insert({ kind: kind, entity_key: entityKey, field: field, old_value: oldVal === undefined ? null : oldVal, new_value: clear ? null : value, user_id: user.id, display_name: name || t('collab.defaultUser'), changed_at: now });
      return { ok: true };
    } catch (e) {
      console.warn('Could not save the shared ' + kind + ' ' + field + '.', e);
      return { ok: false, reason: 'error' };
    }
  }

  // Asks the `api-lineups` Edge Function (supabase/functions/api-lineups) for the
  // official lineups of one API-Football fixture. The function holds the API
  // key, so it never reaches the browser, and only answers signed-in users.
  // Resolves { ok: true, data } or { ok: false, reason } and never throws:
  // not_configured | not_signed_in | not_deployed | error.
  // `fallback` ({ kickoff, home, away, homeId, awayId }) lets the function ask ESPN instead when
  // API-Football cannot answer (daily limit used up, outage) or has not published yet.
  async function fetchApiLineups(fixtureId, fallback) {
    if (!enabled) return { ok: false, reason: 'not_configured' };
    if (!user) await ensureUser();
    if (!user) return { ok: false, reason: 'not_signed_in' };
    try {
      var res = await client.functions.invoke('api-lineups', { body: { fixture: fixtureId, fallback: fallback || undefined } });
      if (res.error) {
        var status = res.error.context && res.error.context.status;
        return { ok: false, reason: status === 404 ? 'not_deployed' : status === 401 ? 'not_signed_in' : 'error' };
      }
      return { ok: true, data: res.data };
    } catch (e) { return { ok: false, reason: 'error' }; }
  }

  window.MC_COLLAB = { configured: configured, ready: ready, start: start, persist: persist, setName: setName, sendMagicLink: sendMagicLink, signOut: signOut, status: status, isFavourite: isFavourite, toggleFavourite: toggleFavourite, loadFavourites: loadFavourites, changes: changes, getEntity: getEntity, getEntities: getEntities, setEntityOverride: setEntityOverride, fetchApiLineups: fetchApiLineups };
})();
