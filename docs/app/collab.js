/* Optional collaboration layer for the static GitHub Pages app.
   It deliberately degrades to localStorage if Supabase is not configured. */
(function () {
  'use strict';
  var cfg = window.PM_CONFIG || {};
  var enabled = !!(cfg.supabaseUrl && cfg.supabaseAnonKey && window.supabase);
  var client = enabled ? window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey) : null;
  var user = null, name = '', activeSlug = '', lastJson = '', timer = null, onRemote = null;
  var favs = {};

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
    if (!user) {
      var signed = await client.auth.signInAnonymously();
      user = signed.data && signed.data.user;
      if (signed.error) throw signed.error;
    }
    name = localName() || 'Utilizator';
    emit();
    return user;
  }

  function changedAreas(before, after) {
    var a = before || {}, b = after || {};
    var labels = {
      notes: 'notițe', lineup: 'poziții', xi: 'primul 11 / schimbări', bench: 'rezerve',
      events: 'evenimente', captain: 'căpitan', pnum: 'numere', panelExtra: 'informații adăugate',
      manual: 'date manuale', discColors: 'culori', view: 'vedere', panelOrder: 'panouri'
    };
    return Object.keys(labels).filter(function (k) { return json(a[k]) !== json(b[k]); }).map(function (k) { return labels[k]; });
  }

  async function loadFavourites() {
    if (!user) return;
    var res = await client.from('mc_favourites').select('match_slug').eq('user_id', user.id);
    if (res.error) return;
    favs = {};
    (res.data || []).forEach(function (r) { favs[r.match_slug] = true; });
    emit();
  }

  async function start(slug, localState, remoteCallback) {
    activeSlug = slug; onRemote = remoteCallback;
    if (!enabled) { emit(); return; }
    try {
      await ensureUser();
      await loadFavourites();
      var res = await client.from('mc_match_state').select('state').eq('match_slug', slug).maybeSingle();
      if (res.error) throw res.error;
      var remote = res.data && res.data.state;
      // Preserve edits already made on this device; nested maps merge so a new
      // note/position does not erase unrelated remote maps on first connect.
      var merged = merge(remote || {}, localState || {});
      lastJson = json(merged);
      if (onRemote && json(merged) !== json(localState || {})) onRemote(merged);
      if (!res.data && json(merged) !== '{}') await write(merged, {}, true);
      client.channel('mc-state-' + slug)
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'mc_match_state', filter: 'match_slug=eq.' + slug }, function (payload) {
          if (!payload.new || !payload.new.state || payload.new.updated_by === user.id) return;
          lastJson = json(payload.new.state);
          if (onRemote) onRemote(payload.new.state, payload.new.updated_by);
        }).subscribe();
    } catch (e) {
      console.warn('Match Center collaboration is unavailable.', e);
      enabled = false; emit();
    }
  }

  function merge(remote, local) {
    var out = Object.assign({}, remote || {});
    Object.keys(local || {}).forEach(function (k) {
      if (remote && remote[k] && typeof remote[k] === 'object' && !Array.isArray(remote[k]) && typeof local[k] === 'object' && !Array.isArray(local[k])) out[k] = Object.assign({}, remote[k], local[k]);
      else out[k] = local[k];
    });
    return out;
  }

  async function write(state, before, silent) {
    if (!enabled || !user || !activeSlug) return;
    var now = new Date().toISOString();
    var res = await client.from('mc_match_state').upsert({ match_slug: activeSlug, state: state, updated_by: user.id, updated_by_name: name, updated_at: now });
    if (res.error) throw res.error;
    var areas = changedAreas(before, state);
    if (!silent && areas.length) {
      await client.from('mc_match_changes').insert({ match_slug: activeSlug, user_id: user.id, display_name: name, summary: 'A modificat: ' + areas.join(', '), changed_at: now });
    }
  }

  function persist(state) {
    if (!enabled || !user) return;
    var next = json(state);
    if (next === lastJson) return;
    var before; try { before = JSON.parse(lastJson || '{}'); } catch (e) { before = {}; }
    lastJson = next;
    clearTimeout(timer);
    timer = setTimeout(function () { write(state, before, false).catch(function (e) { console.warn('Nu s-au sincronizat schimbările.', e); }); }, 500);
  }

  async function setName(value) {
    name = cleanName(value) || 'Utilizator'; setLocalName(name); emit();
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
  async function toggleFavourite(slug) {
    if (!enabled) {
      var local = JSON.parse(localStorage.getItem('mc:favourites') || '{}');
      local[slug] = !local[slug]; localStorage.setItem('mc:favourites', JSON.stringify(local)); return !!local[slug];
    }
    await ensureUser();
    if (favs[slug]) { await client.from('mc_favourites').delete().eq('user_id', user.id).eq('match_slug', slug); delete favs[slug]; }
    else { await client.from('mc_favourites').insert({ user_id: user.id, match_slug: slug }); favs[slug] = true; }
    emit(); return !!favs[slug];
  }

  async function changes(slug) {
    if (!enabled) return [];
    var res = await client.from('mc_match_changes').select('display_name,summary,changed_at').eq('match_slug', slug).order('changed_at', { ascending: false }).limit(20);
    return res.error ? [] : (res.data || []);
  }

  async function ready() {
    if (!enabled) { emit(); return; }
    try { await ensureUser(); await loadFavourites(); } catch (e) { enabled = false; emit(); }
  }

  window.MC_COLLAB = { configured: configured, ready: ready, start: start, persist: persist, setName: setName, status: status, isFavourite: isFavourite, toggleFavourite: toggleFavourite, loadFavourites: loadFavourites, changes: changes };
})();
