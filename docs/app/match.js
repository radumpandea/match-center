/* Match Center — render of docs/data/matches/<slug>.json when it exists;
   otherwise a skeleton built from docs/data/fixtures.json, best-effort filled
   from a client-side call to the live football feed, with the rest fillable
   by hand. Vanilla JS, no build step. */
(function () {
  'use strict';

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var root = $('#root');
  var I18N = window.MC_I18N;
  var t = I18N.t;
  var allFixtures = [];   // set from data/fixtures.json below; used to prune stale favourites
  // Translated editorial content (storyOfTheMatch, funfacts, news...) for the
  // UI languages other than Romanian, if a translation pass has produced one
  // for this match — see docs/data/matches/<slug>.i18n.json and
  // .claude/skills/match-i18n-json/SKILL.md. null/absent is normal (not every
  // match has been translated yet) and just means every language shows the
  // Romanian original, same as before this existed.
  var i18nDoc = null;

  var params = new URLSearchParams(location.search);
  var slug = (params.get('m') || '').trim();
  if (!slug) { fail(t('err.missingSlug')); return; }

  Promise.all([
    fetch('data/fixtures.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
    fetch('data/matches/' + encodeURIComponent(slug) + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; }),
    fetch('data/matches/' + encodeURIComponent(slug) + '.i18n.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (results) {
    var fixtures = results[0] || [];
    allFixtures = fixtures;
    var prep = results[1];
    i18nDoc = results[2];
    var fixture = fixtures.filter(function (f) { return f.slug === slug; })[0];
    if (!prep && !fixture) {
      fail(t('err.notFound', { slug: esc(slug) }));
      return;
    }
    // A file with "partial": true is the deterministic prefetch (squads / coach /
    // form / h2h / injuries / referee / venue). A file with no prep JSON at all
    // is a bare skeleton from the fixture row. Either way there is no live
    // client-side call any more — the daily prefetch fills these, and anything
    // still missing is fillable by hand.
    var partial = !!(prep && prep.partial);
    var data = prep || skeletonFromFixture(fixture, slug);
    data._skeleton = !prep;
    data._partial = partial;
    render(data);
    connectCollaboration(data);
    connectEntities(data, fixture);
  });

  function fail(html) { root.innerHTML = '<div class="errbox">' + html + '</div>'; }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  }); }
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function has(v) { return v != null && v !== '' && v !== 'n/d'; }
  // Same "upcoming" definition as index.html's isUpcoming() -- a 3h grace
  // window past kickoff so a match doesn't vanish from favourites the
  // instant it starts. Used to find the user's OWN favourited slugs whose
  // match has already been played, so favouriting a new one can free up
  // that slot instead of counting a played match against the cap forever.
  function isUpcomingFixture(f) {
    var ko = f.kickoff && f.kickoff !== 'n/d' ? new Date(f.kickoff) : null;
    if (ko && !isNaN(ko)) return ko.getTime() > Date.now() - 3 * 3600 * 1000;
    var today = new Date().toLocaleDateString('en-CA'); // YYYY-MM-DD, local
    return (f.date || '') >= today;
  }
  function staleFavouriteSlugs() {
    var upcoming = {};
    allFixtures.forEach(function (f) { if (isUpcomingFixture(f)) upcoming[f.slug] = true; });
    var favs = (window.MC_COLLAB && window.MC_COLLAB.status().favourites) || [];
    return favs.filter(function (s) { return !upcoming[s]; });
  }
  // Shared avatar for player/coach modal heads: a real headshot photo from
  // API-Football (media.api-sports.io) when we have one, the existing
  // initials-on-a-colored-circle fallback otherwise (referees have no photo
  // field in the API at all, so that one stays initials-only).
  function avatarEl(photo, label, bg) {
    var attrs = { class: 'avatar' + (photo ? ' has-photo' : '') };
    if (bg) attrs.style = 'background:' + bg;
    if (photo) return el('div', attrs, [el('img', { src: photo, alt: '' })]);
    attrs.text = label;
    return el('div', attrs);
  }
  // Season stat blurb for a squad/lineup entry: appearances + goals/assists
  // for outfield players, appearances + goals conceded for goalkeepers (API-
  // Football doesn't expose per-player clean sheets, only conceded/saves).
  function statLine(p) {
    var s = p.stats;
    if (!s) return '';
    if (s.apps != null) {
      var line = s.apps + (s.apps === 1 ? ' ' + t('statLine.matchOne') : ' ' + t('statLine.matchMany'));
      if (p.role === 'GK') {
        if (s.conceded != null) line += ', ' + s.conceded + ' ' + t('statLine.conceded');
      } else if (s.goals || s.assists) {
        line += ', ' + (s.goals || 0) + 'G/' + (s.assists || 0) + 'A';
      }
      return line;
    }
    if (p.role !== 'GK' && (s.goals || s.assists)) {
      return (s.goals || 0) + 'G/' + (s.assists || 0) + 'A';
    }
    return '';
  }
  function initials(name) {
    return String(name || '?').split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join('').toUpperCase();
  }
  function teamKey(s) {
    return String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '');
  }

  /* ---------- skeleton (no prep JSON yet) ---------- */
  function emptyTeam(name) {
    return {
      name: name, shortName: null, colors: null,
      coach: { name: null }, formation: 'n/d',
      predictedXI: Array.from({ length: 11 }, function () { return { number: null, name: null, pos: null }; }),
      confirmedXI: null, squad: [],
      form: null, absences: [], mercatoIn: [], mercatoOut: [], preseason: [], news: [], stories: []
    };
  }
  function skeletonFromFixture(f) {
    return {
      slug: f.slug, generatedAt: null, sources: [],
      competition: { name: f.comp, round: f.round, country: f.country },
      kickoff: f.kickoff || 'n/d',
      venue: { name: has(f.venue) ? f.venue : null, capacity: null, city: null, notes: null },
      referee: { name: null },
      h2h: { recent: [], summary: null },
      storyOfTheMatch: [],
      teams: { home: emptyTeam(f.home), away: emptyTeam(f.away) }
    };
  }

  /* Live client-side football-feed calls were removed when the pipeline moved
     to API-Football (server-side only). The daily prefetch now fills squads,
     coach, form, h2h, injuries, referee and venue; whatever is still missing
     is entered by hand. No API key ships in the page any more. */


  /* ---------- notes (localStorage) ---------- */
  var NKEY = 'mc:' + slug;
  var store = load();
  function load() {
    try { return JSON.parse(localStorage.getItem(NKEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(NKEY, JSON.stringify(store)); } catch (e) {}
    if (window.MC_COLLAB) window.MC_COLLAB.persist(store);
  }

  var collaborationStarted = false;
  function connectCollaboration(data) {
    if (collaborationStarted || !window.MC_COLLAB) return;
    collaborationStarted = true;
    window.MC_COLLAB.start(slug, store, function (remoteState) {
      store = remoteState || {};
      try { localStorage.setItem(NKEY, JSON.stringify(store)); } catch (e) {}
      view = (store.view && typeof store.view === 'object')
        ? { orientation: store.view.orientation === 'v' ? 'v' : 'h', swapped: !!store.view.swapped, fullNames: !!store.view.fullNames, labelSize: [0, 1, 2].indexOf(store.view.labelSize) >= 0 ? store.view.labelSize : 0 }
        : { orientation: 'h', swapped: false, fullNames: false, labelSize: 0 };
      render(data);
    });
  }
  // Overlays ONLY the coach's name from the canonical, shared record
  // (mc_entities, via collab.js) onto this match's embedded copy, once, on
  // load. `coach.apiId` only exists on files built after this was added;
  // older files simply have no apiId and this is a silent no-op, keeping the
  // embedded coach as-is. Name-only is deliberate: mc_entities is synced by a
  // deterministic, API-only script (scripts/sync-entities.mjs) with no
  // editorial research behind it, so its career[]/trophies[] are much
  // thinner than what the match-data-json skill writes into the file
  // directly — overlaying the whole object would clobber that research with
  // a worse copy. Name is the one field that genuinely goes stale between a
  // match file's build date and kickoff (the Wagner/Baum, Baines/Moyes bugs
  // from 2026-09), and is cheap to keep fresh this way everywhere at once.
  function afKey(apiId) { return apiId == null ? null : 'af:' + apiId; }
  // Referees have no id from API-Football, so the surname (+ first initial,
  // to cut down on two different referees who happen to share a surname) is
  // the closest thing to a stable identity -- same key derivation as
  // scripts/sync-referee-entities.mjs, duplicated here on purpose (small,
  // pure function; this codebase already duplicates norm()/has() across
  // scripts rather than sharing a module).
  function refKey(name) {
    var n = String(name || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
      .replace(/[^a-z\s.]/g, '').replace(/\./g, '').trim();
    var tokens = n.split(/\s+/).filter(Boolean);
    if (!tokens.length) return null;
    var surname = tokens[tokens.length - 1];
    var initial = tokens.length > 1 ? tokens[0][0] : '';
    return 'name:' + surname + (initial ? '-' + initial : '');
  }
  function connectEntities(data, fixture) {
    if (!window.MC_COLLAB) return;
    ['home', 'away'].forEach(function (side) {
      var coach = data.teams[side] && data.teams[side].coach;
      if (!coach || coach.apiId == null) return;
      window.MC_COLLAB.getEntity('coach', afKey(coach.apiId)).then(function (entity) {
        if (!entity || !has(entity.name) || entity.name === coach.name) return;
        coach.name = entity.name;
        render(data);
      });
    });
    connectPlayerEntities(data);
    connectRefereeEntity(data);
    connectTeamEntities(data, fixture);
  }
  // Team-level facts (nickname, stadium/city trivia) have no API-Football
  // source -- they're researched once by the AI editorial skill and pushed
  // into mc_entities by scripts/sync-entities.mjs (from docs/data/teams/
  // <teamId>.json). Overlaying them here means a team researched on ONE
  // match immediately shows the same facts on every OTHER match involving
  // that team, without waiting for the prefetch top-up loop to touch each
  // file individually. Fill-only (never overwrites an already-present
  // value): unlike coach.name, these never go stale, so there's nothing to
  // correct, only to backfill.
  function connectTeamEntities(data, fixture) {
    if (!window.MC_COLLAB || !fixture) return;
    var ids = { home: fixture.homeId, away: fixture.awayId };
    var keys = [];
    ['home', 'away'].forEach(function (side) { if (ids[side] != null) keys.push(afKey(ids[side])); });
    if (!keys.length) return;
    window.MC_COLLAB.getEntities('team', keys).then(function (map) {
      var touched = false;
      ['home', 'away'].forEach(function (side) {
        var entity = ids[side] != null && map[afKey(ids[side])];
        if (!entity) return;
        var t = data.teams[side];
        if (t && !has(t.nickname) && has(entity.nickname)) { t.nickname = entity.nickname; touched = true; }
        if (side === 'home' && (!data.venue.stories || !data.venue.stories.length) &&
            entity.venueStories && entity.venueStories.length) {
          data.venue.stories = entity.venueStories; touched = true;
        }
      });
      if (touched) render(data);
    });
  }
  // Same name-only overlay as coaches, batched for every squad/predictedXI/
  // confirmedXI entry that carries an apiId (see scripts/sync-player-entities.mjs
  // and fix-squad-names.mjs, which backfills apiId onto existing files). One
  // round trip for the whole match instead of one query per player.
  function connectPlayerEntities(data) {
    var keys = [];
    ['home', 'away'].forEach(function (side) {
      var t = data.teams[side];
      if (!t) return;
      [t.squad, t.predictedXI, t.confirmedXI].forEach(function (list) {
        (list || []).forEach(function (p) { if (p && p.apiId != null) keys.push(afKey(p.apiId)); });
      });
    });
    if (!keys.length || !window.MC_COLLAB) return;
    window.MC_COLLAB.getEntities('player', keys).then(function (map) {
      var touched = false;
      ['home', 'away'].forEach(function (side) {
        var t = data.teams[side];
        if (!t) return;
        [t.squad, t.predictedXI, t.confirmedXI].forEach(function (list) {
          (list || []).forEach(function (p) {
            var entity = p && p.apiId != null && map[afKey(p.apiId)];
            if (!entity || !has(entity.name) || entity.name === p.name) return;
            p.name = entity.name;
            touched = true;
          });
        });
      });
      if (touched) render(data);
    });
  }
  // Same name-only overlay, keyed by surname+initial instead of apiId (see
  // refKey() above and scripts/sync-referee-entities.mjs). Lower confidence
  // than the apiId-based overlays -- a shared surname could in principle
  // belong to a different referee -- so this only ever proposes a LONGER
  // name for the same surname+initial, never a same-length rewrite, and is
  // named "referee" everywhere so it's easy to disable in one place if it
  // ever misfires.
  function connectRefereeEntity(data) {
    if (!window.MC_COLLAB || !data.referee || !has(data.referee.name)) return;
    var key = refKey(data.referee.name);
    if (!key) return;
    window.MC_COLLAB.getEntity('referee', key).then(function (entity) {
      if (!entity || !has(entity.name) || entity.name === data.referee.name) return;
      if (entity.name.length <= data.referee.name.length) return;
      data.referee.name = entity.name;
      render(data);
    });
  }

  function notesFor(id) { return (store.notes && store.notes[id]) || []; }
  // one input line -> { kind, text }. A leading -, *, • or – marks a bullet;
  // two markers (--, **) or a 2-space indent marks a sub-bullet.
  function parseNoteLine(raw, dflt) {
    var lead = (raw.match(/^\s*/) || [''])[0].length;
    var s = raw.trim();
    var m2 = s.match(/^([-*]{2}|[-*•–]\s*[-*•–])\s+(.*)$/);
    if (m2) return { kind: 'sub', text: m2[2].trim() };
    var m1 = s.match(/^[-*•–]\s+(.*)$/);
    if (m1) return { kind: lead >= 2 ? 'sub' : 'bullet', text: m1[1].trim() };
    if (lead >= 2 && s) return { kind: 'sub', text: s };
    return { kind: dflt || 'text', text: s };
  }
  function addNote(id, text, kind) {
    var rows = String(text || '').split('\n')
      .map(function (l) { return parseNoteLine(l, kind); })
      .filter(function (r) { return r.text; });
    if (!rows.length) return;
    store.notes = store.notes || {};
    var arr = (store.notes[id] = store.notes[id] || []);
    rows.forEach(function (r) {
      arr.push({ id: Date.now() + '' + Math.random().toString(36).slice(2, 6), text: r.text, kind: r.kind, ts: Date.now() });
    });
    save();
  }
  function delNote(id, noteId) {
    if (!store.notes || !store.notes[id]) return;
    store.notes[id] = store.notes[id].filter(function (n) { return n.id !== noteId; });
    save();
  }

  function notesBlock(id, label) {
    var wrap = el('div', { class: 'notes' });
    var list = el('div');
    var curKind = 'text';
    var KIND = { text: { pre: '', cls: 'nk-t' }, bullet: { pre: '• ', cls: 'nk-b' }, sub: { pre: '– ', cls: 'nk-s' } };
    function redraw() {
      list.innerHTML = '';
      notesFor(id).forEach(function (n) {
        var k = KIND[n.kind] || KIND.text;
        list.appendChild(el('div', { class: 'note ' + k.cls }, [
          el('span', { text: k.pre + n.text }),
          el('span', {}, [
            el('time', { text: new Date(n.ts).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
            el('button', { text: '✕', title: t('common.delete'), onclick: function () { delNote(id, n.id); redraw(); } })
          ])
        ]));
      });
    }
    var ta = el('textarea', { placeholder: t('notes.placeholder', { label: label || id }) });
    function commit() { addNote(id, ta.value, curKind); ta.value = ''; redraw(); ta.focus(); }
    var kindBtns = ['text', 'bullet', 'sub'].map(function (k) {
      return el('button', {
        class: 'note-kind' + (k === curKind ? ' on' : ''),
        title: { text: t('notes.kindText'), bullet: t('notes.kindBullet'), sub: t('notes.kindSub') }[k],
        text: { text: '¶', bullet: '•', sub: '–' }[k],
        onclick: function () {
          curKind = k;
          [].forEach.call(kindRow.children, function (b, i) { b.classList.toggle('on', ['text', 'bullet', 'sub'][i] === k); });
          ta.focus();
        }
      });
    });
    var kindRow = el('span', { class: 'note-kinds' }, kindBtns);
    var addBtn = el('button', { text: t('common.add'), onclick: commit });
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') commit();
    });
    wrap.appendChild(list);
    wrap.appendChild(ta);
    wrap.appendChild(el('div', { class: 'notes-row' }, [kindRow, addBtn]));
    redraw();
    return wrap;
  }

  function exportNotes(data) {
    var lines = [t('export.title', { home: data.teams.home.name, away: data.teams.away.name }),
      '', '_' + (data.competition.name || '') + ' · ' + (data.competition.round || '') + ' · ' + t('export.generatedAt', { when: new Date().toLocaleString(I18N.localeTag()) }) + '_', ''];
    var n = store.notes || {};
    function nameOf(id) {
      var p = id.split(':');
      if (p[0] === 'match') return t('export.matchGeneral');
      if (p[0] === 'team') return data.teams[p[1]] ? data.teams[p[1]].name : p[1];
      if (p[0] === 'player') {
        var tm = data.teams[p[1]]; var pl = tm && effSquad(data, p[1]).filter(function (x) { return String(x.number) === p[2] || x.name === p[2]; })[0];
        return (pl ? pl.name : p[2]) + ' (' + (tm ? tm.name : p[1]) + ')';
      }
      if (p[0] === 'coach') return t('export.coach', { team: data.teams[p[1]] ? data.teams[p[1]].name : p[1] });
      if (p[0] === 'ref') return t('export.referee');
      return id;
    }
    Object.keys(n).forEach(function (id) {
      if (!n[id] || !n[id].length) return;
      lines.push('## ' + nameOf(id));
      n[id].forEach(function (note) {
        var ind = note.kind === 'sub' ? '  ' : '';
        lines.push(ind + '- ' + note.text + '  \n  ' + ind + '_' + new Date(note.ts).toLocaleString(I18N.localeTag()) + '_');
      });
      lines.push('');
    });
    var px = store.panelExtra || {};
    var pxKeys = Object.keys(px).filter(function (k) { return px[k] && px[k].length; });
    if (pxKeys.length) {
      lines.push('## ' + t('export.addedInfo'));
      pxKeys.forEach(function (k) {
        var head = k.indexOf('teaminfo:') === 0
          ? (data.teams[k.split(':')[1]] ? data.teams[k.split(':')[1]].name : k)
          : k;
        lines.push('', '### ' + head);
        px[k].forEach(function (it) { lines.push('- ' + it.text); });
      });
      lines.push('');
    }
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'notite-' + slug + '.md' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- pitch view (orientation + which team is nearest the viewer) ---------- */
  var view = (store.view && typeof store.view === 'object')
    ? { orientation: store.view.orientation === 'v' ? 'v' : 'h', swapped: !!store.view.swapped, fullNames: !!store.view.fullNames, labelSize: [0, 1, 2].indexOf(store.view.labelSize) >= 0 ? store.view.labelSize : 0 }
    : { orientation: 'h', swapped: false, fullNames: false, labelSize: 0 };
  function saveView() { store.view = { orientation: view.orientation, swapped: view.swapped, fullNames: view.fullNames, labelSize: view.labelSize }; save(); }

  /* ---------- disc (player node) colours per team ----------
     user override (store.discColors) wins; then the pack's colors.primary;
     then a default. Applied to the --home / --away CSS vars on <html>. */
  var DISC_DEFAULT = { home: '#6d28d9', away: '#b91c1c' };
  function hex6(v) { return /^#[0-9a-fA-F]{6}$/.test(v || '') ? v : null; }
  function resolveDisc(d, side) {
    var ov = store.discColors && store.discColors[side];
    if (hex6(ov)) return ov;
    var c = d.teams[side] && d.teams[side].colors;
    if (c && hex6(c.primary)) return c.primary;
    return DISC_DEFAULT[side];
  }
  // The shirt-number text inside a disc used to be hard-coded white — fine
  // against the default purple/red, invisible against a light custom colour
  // (e.g. a white kit, reported 2026-09-14 on Universitatea Cluj's white
  // discs). Picks dark or light text by the background's perceived
  // brightness instead of assuming it's always dark.
  function inkFor(hex) {
    var h = hex6(hex) || '#000000';
    var r = parseInt(h.slice(1, 3), 16), g = parseInt(h.slice(3, 5), 16), b = parseInt(h.slice(5, 7), 16);
    var brightness = (r * 299 + g * 587 + b * 114) / 1000;
    return brightness > 150 ? '#111' : '#fff';
  }
  function applyDiscColors(d) {
    var home = resolveDisc(d, 'home'), away = resolveDisc(d, 'away');
    document.documentElement.style.setProperty('--home', home);
    document.documentElement.style.setProperty('--away', away);
    document.documentElement.style.setProperty('--home-ink', inkFor(home));
    document.documentElement.style.setProperty('--away-ink', inkFor(away));
  }

  /* ---------- tactical formation (user override) ----------
     Pick this before placing players into slots: layout() always produces
     exactly 11 points (1 GK + the outfield lines) for any of these, so
     switching formation just reflows whichever 11 slots already exist. */
  var FORMATIONS = ['3-4-3', '3-5-2', '4-1-4-1', '4-2-3-1', '4-3-3', '4-4-2', '4-5-1', '5-3-2', '5-4-1'];
  function baseFormation(d, side) {
    return has(d.teams[side].formation) ? d.teams[side].formation : '4-4-2';
  }
  function effFormation(d, side) {
    return (store.formation && store.formation[side]) || baseFormation(d, side);
  }
  function formationSelect(d, side) {
    var cur = effFormation(d, side);
    var opts = FORMATIONS.indexOf(cur) < 0 ? [cur].concat(FORMATIONS) : FORMATIONS;
    var sel = el('select', {
      class: 'formation-select',
      title: 'Sistem tactic — ' + d.teams[side].name,
      onchange: function () {
        store.formation = store.formation || {};
        if (sel.value === baseFormation(d, side)) delete store.formation[side];
        else store.formation[side] = sel.value;
        if (!Object.keys(store.formation).length) delete store.formation;
        save();
        rerenderPitch(d);
      }
    }, opts.map(function (f) { return el('option', { value: f, text: f }); }));
    sel.value = cur;
    return el('label', { class: 'formation-label' }, [
      el('span', { text: (d.teams[side].shortName || d.teams[side].name).slice(0, 3).toUpperCase() }),
      sel
    ]);
  }

  /* Each player is placed by (d, w): d = depth from own goal-line (0.05) to just
     short of halfway (~0.45); w = position across the pitch width (0..1). The
     view transform below turns (d, w) into left/top % for the chosen orientation
     and near/far end. */
  function layout(formation) {
    var counts = [1].concat(String(formation || '4-4-2').split('-')
      .map(function (x) { return parseInt(x, 10) || 0; }).filter(Boolean));
    var rows = counts.length, pts = [];
    counts.forEach(function (nn, ri) {
      var d = rows === 1 ? 0.24 : (0.05 + (ri / (rows - 1)) * 0.40);
      for (var i = 0; i < nn; i++) {
        var span = nn >= 5 ? 0.66 : nn === 4 ? 0.60 : nn === 3 ? 0.52 : 0.36;
        var w = nn === 1 ? 0.5 : (0.5 - span / 2 + (i / (nn - 1)) * span);
        pts.push({ d: d, w: w });
      }
    });
    return pts;
  }

  // (d, w) + near/far end -> {left, top} in %
  function place(pt, isNear) {
    var d = pt.d, w = pt.w;
    if (view.orientation === 'v') {
      return isNear ? { left: w * 100, top: (1 - d) * 100 } : { left: w * 100, top: d * 100 };
    }
    return isNear ? { left: d * 100, top: w * 100 } : { left: (1 - d) * 100, top: w * 100 };
  }
  // inverse of place(): left/top % (0..100) back to orientation-independent (d, w)
  function unplace(left, top, isNear) {
    var L = left / 100, T = top / 100;
    if (view.orientation === 'v') {
      return isNear ? { d: 1 - T, w: L } : { d: T, w: L };
    }
    return isNear ? { d: L, w: T } : { d: 1 - L, w: T };
  }
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }

  /* ---------- who is on the pitch (lineup overrides) ---------- */
  function sameP(a, b) {
    if (!a || !b) return false;
    if (a.number != null && b.number != null) return a.number === b.number;
    return a.name === b.name;
  }
  function keyOf(p) { return p && p.number != null ? 'n' + p.number : 's' + (p && p.name); }
  // squad plus any players added by hand (see openAddPlayer)
  function effSquad(d, side) {
    return (d.teams[side].squad || []).concat((store.manualSquad && store.manualSquad[side]) || []);
  }
  function addManualPlayer(side, player) {
    store.manualSquad = store.manualSquad || {};
    store.manualSquad[side] = store.manualSquad[side] || [];
    store.manualSquad[side].push(player);
    save();
  }
  // Manually-entered referee/coach/venue (store.manual) win over whatever the
  // skeleton/prep/live data has — applied fresh on every render() call.
  function applyManualOverlay(d) {
    var man = store.manual;
    if (!man) return;
    if (man.referee) d.referee = man.referee;
    if (man.venue) d.venue = man.venue;
    ['home', 'away'].forEach(function (side) {
      if (man.coach && man.coach[side]) d.teams[side].coach = man.coach[side];
    });
  }
  // Per-player shirt-number overrides (store.pnum[side][name]) — for numbers that
  // are missing or have changed. Keyed by name (stable), applied every render().
  function applyPnum(d) {
    var pn = store.pnum;
    if (!pn) return;
    ['home', 'away'].forEach(function (side) {
      var map = pn[side];
      if (!map) return;
      var set = function (o) {
        if (!o || o.name == null || !Object.prototype.hasOwnProperty.call(map, o.name)) return;
        if (o._num0 === undefined) o._num0 = o.number;   // remember the pristine number
        o.number = map[o.name];
      };
      (d.teams[side].squad || []).forEach(set);
      (d.teams[side].predictedXI || []).forEach(set);
      (d.teams[side].confirmedXI || []).forEach(set);
      (store.manualSquad && store.manualSquad[side] || []).forEach(set);
      var xi = store.xi && store.xi[side];
      if (xi) Object.keys(xi).forEach(function (k) { set(xi[k]); });
    });
  }
  // Per-player display-name overrides (store.pname[side][keyOf(p)]) — lets the
  // user show something other than the researched name (a nickname, a
  // correction) everywhere the player appears, without touching the source
  // data. Keyed by keyOf() (number-first, falls back to the pristine name) so
  // the override survives a later number edit. Applied every render(), right
  // after applyPnum so keyOf() already reflects any number override.
  function applyPname(d) {
    var pn = store.pname || {};
    ['home', 'away'].forEach(function (side) {
      var map = pn[side] || {};
      var set = function (o) {
        if (!o) return;
        var k = keyOf(o);
        if (Object.prototype.hasOwnProperty.call(map, k)) {
          if (o._name0 === undefined) o._name0 = o.name;   // remember the researched name
          o.name = map[k];
        } else if (o._name0 !== undefined) {
          o.name = o._name0;   // override was cleared -- restore the researched name
        }
      };
      (d.teams[side].squad || []).forEach(set);
      (d.teams[side].predictedXI || []).forEach(set);
      (d.teams[side].confirmedXI || []).forEach(set);
      (store.manualSquad && store.manualSquad[side] || []).forEach(set);
      var xi = store.xi && store.xi[side];
      if (xi) Object.keys(xi).forEach(function (k) { set(xi[k]); });
    });
  }
  // Overlays translated editorial text (i18nDoc[lang]) onto the Romanian
  // source doc, applied fresh on every render() call — same pattern as
  // applyManualOverlay/applyPnum/applyPname above. Every translated array
  // must line up POSITIONALLY with its Romanian source array (see the
  // match-i18n-json skill); this only ever reads by index, never by
  // content, so a translation file with the right shape is required.
  // Backs up the original Romanian value the first time a field is
  // overridden (so switching back to 'ro', or to a language the file
  // doesn't cover, restores it) — mirrors _name0/_num0 above.
  function applyI18nOverlay(d) {
    var lang = I18N.getLang();
    var tr = lang !== 'ro' && i18nDoc ? i18nDoc[lang] : null;
    function field(obj, key, val) {
      if (!obj) return;
      var bk = '_ro$' + key;
      if (val) {
        if (obj[bk] === undefined) obj[bk] = obj[key] !== undefined ? obj[key] : null;
        obj[key] = val;
      } else if (obj[bk] !== undefined) {
        obj[key] = obj[bk];
      }
    }
    // storyOfTheMatch[] / venue.stories[] are arrays of bare strings -- no
    // per-item object to hang a backup marker on, so back up the whole
    // array on the parent instead.
    function stringArrayField(parent, key, trArr) {
      if (!parent || !Array.isArray(parent[key])) return;
      var bk = '_ro$' + key;
      if (trArr) {
        if (parent[bk] === undefined) parent[bk] = parent[key];
        parent[key] = parent[bk].map(function (s, i) { return (trArr[i] != null && trArr[i] !== '') ? trArr[i] : s; });
      } else if (parent[bk] !== undefined) {
        parent[key] = parent[bk];
      }
    }
    stringArrayField(d, 'storyOfTheMatch', tr && tr.storyOfTheMatch);
    field(d.h2h, 'summary', tr && tr.h2h && tr.h2h.summary);
    field(d.referee, 'history', tr && tr.referee && tr.referee.history);
    if (d.venue) {
      field(d.venue, 'notes', tr && tr.venue && tr.venue.notes);
      stringArrayField(d.venue, 'stories', tr && tr.venue && tr.venue.stories);
    }
    if (d.commentatorResearch) {
      d.commentatorResearch.forEach(function (c, i) {
        var tc = tr && tr.commentatorResearch && tr.commentatorResearch[i];
        field(c, 'topic', tc && tc.topic);
        field(c, 'fact', tc && tc.fact);
      });
    }
    ['home', 'away'].forEach(function (side) {
      var team = d.teams[side];
      var tt = tr && tr.teams && tr.teams[side];
      if (team.coach && team.coach.career) {
        team.coach.career.forEach(function (c, i) {
          field(c, 'note', tt && tt.coach && tt.coach.career && tt.coach.career[i]);
        });
      }
      (team.news || []).forEach(function (n, i) {
        field(n, 'text', tt && tt.news && tt.news[i]);
      });
      (team.stories || []).forEach(function (s, i) {
        var ts = tt && tt.stories && tt.stories[i];
        field(s, 'title', ts && ts.title);
        stringArrayField(s, 'bullets', ts && ts.bullets);
      });
      (team.squad || []).forEach(function (p, i) {
        var tp = tt && tt.squad && tt.squad[i];
        field(p, 'funfact', tp && tp.funfact);
        field(p, 'linkLine', tp && tp.linkLine);
        field(p, 'career', tp && tp.career);
        field(p, 'lastSeason', tp && tp.lastSeason);
        field(p, 'statusNote', tp && tp.statusNote);
      });
    });
  }

  function setPlayerName(d, side, p, name) {
    var k = keyOf(p);
    var orig = p._name0 !== undefined ? p._name0 : p.name;
    name = (name || '').trim();
    store.pname = store.pname || {};
    store.pname[side] = store.pname[side] || {};
    if (!name || name === orig) delete store.pname[side][k]; else store.pname[side][k] = name;
    if (!Object.keys(store.pname[side]).length) delete store.pname[side];
    save();
    var back = document.querySelector('.modal-back');
    if (back) back.remove();
    render(d);
  }
  function setPlayerNumber(d, side, p, n) {
    var oldKey = keyOf(p);
    var newKey = (n != null && !isNaN(n)) ? 'n' + n : 's' + p.name;
    n = (n != null && !isNaN(n)) ? n : null;
    var orig = (d.teams[side].squad || []).filter(function (x) { return x.name === p.name; })[0];
    var origNum = orig ? (orig._num0 !== undefined ? orig._num0 : orig.number) : (p._num0 !== undefined ? p._num0 : null);
    store.pnum = store.pnum || {};
    store.pnum[side] = store.pnum[side] || {};
    if (n === origNum) delete store.pnum[side][p.name];
    else store.pnum[side][p.name] = n;
    if (!Object.keys(store.pnum[side]).length) delete store.pnum[side];
    if (oldKey !== newKey) {
      if (store.bench && store.bench[side]) {
        store.bench[side] = store.bench[side].map(function (k) { return k === oldKey ? newKey : k; });
      }
      if (store.captain && store.captain[side] === oldKey) store.captain[side] = newKey;
      if (store.pname && store.pname[side] && Object.prototype.hasOwnProperty.call(store.pname[side], oldKey)) {
        store.pname[side][newKey] = store.pname[side][oldKey];
        delete store.pname[side][oldKey];
      }
      if (store.events) {
        var oe = side + ':' + (p.number != null ? p.number : p.name);
        var ne = side + ':' + (n != null ? n : p.name);
        if (oe !== ne && store.events[oe]) {
          store.events[ne] = (store.events[ne] || []).concat(store.events[oe]);
          delete store.events[oe];
        }
      }
    }
    if (p._num0 === undefined) p._num0 = p.number;   // keep pristine before mutating
    p.number = n;
    save();
    var back = document.querySelector('.modal-back');
    if (back) back.remove();
    render(d);
  }
  // predicted XI for a side with the user's manual swaps applied. Padded to 11
  // blank slots so a skeleton / partial-prefetch match still shows a full pitch
  // to build the lineup on (real packs already carry exactly 11).
  function effXI(d, side) {
    var pred = (d.teams[side].predictedXI || []).slice();
    while (pred.length < 11) pred.push({ number: null, name: null, pos: null });
    var ov = (store.xi && store.xi[side]) || {};
    return pred.map(function (slot, i) { return ov[i] || slot; });
  }
  // matchday bench: an explicit list of squad keys in store.bench[side]; when
  // unset, the implicit bench is everyone in the squad not in the XI.
  function benchList(d, side) {
    var xiKeys = effXI(d, side).map(keyOf);
    var squad = effSquad(d, side);
    var offPitch = function (p) { return xiKeys.indexOf(keyOf(p)) < 0; };
    var explicit = store.bench && store.bench[side];
    if (explicit && explicit.length) {
      return explicit
        .map(function (k) { return squad.filter(function (p) { return keyOf(p) === k; })[0]; })
        .filter(function (p) { return p && offPitch(p); });
    }
    return squad.filter(offPitch);
  }
  function setBench(d, side, keys) {
    store.bench = store.bench || {};
    if (keys && keys.length) store.bench[side] = keys; else delete store.bench[side];
    save();
    rerenderPitch(d);
  }
  // one captain per team, keyed by keyOf() like the bench
  function isCaptain(side, p) { return !!p && !!(store.captain && store.captain[side] === keyOf(p)); }
  function setCaptain(d, side, p) {
    store.captain = store.captain || {};
    var k = keyOf(p);
    if (store.captain[side] === k) delete store.captain[side]; else store.captain[side] = k;
    if (!Object.keys(store.captain).length) delete store.captain;
    save();
    var back = document.querySelector('.modal-back');
    if (back) back.remove();
    render(d);
  }
  // kind: 'xi' = a correction to the announced first XI (this player actually
  // starts); 'sub' = an in-match substitution (has a minute, shows in the match
  // log). Legacy entries with no `kind` are treated as 'xi'.
  function applySub(d, side, idx, player, minute, kind) {
    var pred = d.teams[side].predictedXI || [];
    var m = parseInt(minute, 10);
    store.xi = store.xi || {};
    store.xi[side] = store.xi[side] || {};
    store.xi[side][idx] = {
      number: player.number != null ? player.number : null,
      name: player.name,
      pos: pred[idx] ? pred[idx].pos : player.pos,
      minute: isNaN(m) ? null : m,
      kind: kind === 'sub' ? 'sub' : 'xi'
    };
    save();
    rerenderPitch(d);
    rerenderPanels(d);
  }
  function clearSub(d, side, idx) {
    if (store.xi && store.xi[side]) { delete store.xi[side][idx]; save(); rerenderPitch(d); rerenderPanels(d); }
  }

  /* ---------- goals & cards per player (store.events) ---------- */
  var EV_ICON = { goal: '⚽', owngoal: '⚽', yellow: '🟨', red: '🟥', sub: '🔄' };
  function evMeta(type) { return EV_ICON[type] ? { icon: EV_ICON[type], label: t('events.' + type) } : null; }
  function evKey(side, p) { return side + ':' + (p && p.number != null ? p.number : (p && p.name)); }
  function eventsFor(side, p) { return (store.events && store.events[evKey(side, p)]) || []; }
  function addEvent(side, p, type, minute) {
    if (!EV_ICON[type]) return;
    var m = parseInt(minute, 10);
    store.events = store.events || {};
    var k = evKey(side, p);
    (store.events[k] = store.events[k] || []).push({
      id: Date.now() + '' + Math.random().toString(36).slice(2, 6),
      type: type, minute: isNaN(m) ? null : m
    });
    save();
  }
  function delEvent(side, p, eventId) {
    var k = evKey(side, p);
    if (!store.events || !store.events[k]) return;
    store.events[k] = store.events[k].filter(function (e) { return e.id !== eventId; });
    if (!store.events[k].length) delete store.events[k];
    save();
  }
  function evCounts(side, p) {
    var e = eventsFor(side, p), c = { goal: 0, owngoal: 0, yellow: 0, red: 0 };
    e.forEach(function (x) { if (c[x.type] != null) c[x.type]++; });
    return c;
  }
  function scoreFor(d, side) {
    var goals = 0;
    ['home', 'away'].forEach(function (eventSide) {
      effSquad(d, eventSide).forEach(function (p) {
        var c = evCounts(eventSide, p);
        if (eventSide === side) goals += c.goal;
        if (eventSide !== side) goals += c.owngoal;
      });
    });
    return goals;
  }
  function cornerCounts(side) {
    var c = store.corners && store.corners[side];
    return { left: c && Number.isInteger(c.left) && c.left > 0 ? c.left : 0, right: c && Number.isInteger(c.right) && c.right > 0 ? c.right : 0 };
  }
  function adjustCorner(d, side, flank, delta) {
    store.corners = store.corners || {};
    store.corners[side] = store.corners[side] || { left: 0, right: 0 };
    store.corners[side][flank] = Math.max(0, (Number.isInteger(store.corners[side][flank]) ? store.corners[side][flank] : 0) + delta);
    save();
    rerenderPitch(d);
  }
  // Flatten store.events into a minute-sorted match log, resolving player names.
  function collectEvents(d) {
    var rows = [];
    var ev = store.events || {};
    Object.keys(ev).forEach(function (k) {
      var ci = k.indexOf(':');
      var side = k.slice(0, ci), ref = k.slice(ci + 1);
      if (side !== 'home' && side !== 'away') return;
      var num = parseInt(ref, 10);
      var pl = effSquad(d, side).filter(function (x) {
        return (!isNaN(num) && x.number === num) || x.name === ref;
      })[0] || { name: ref, number: isNaN(num) ? null : num };
      (ev[k] || []).forEach(function (e) {
        rows.push({
          minute: e.minute, type: e.type, id: e.id, side: side, player: pl,
          playerName: (pl.number != null ? pl.number + '. ' : '') + pl.name,
          teamName: d.teams[side].name
        });
      });
    });
    // in-match substitutions (store.xi entries flagged kind === 'sub')
    var xi = store.xi || {};
    ['home', 'away'].forEach(function (side) {
      var pred = d.teams[side].predictedXI || [];
      var ov = xi[side] || {};
      Object.keys(ov).forEach(function (i) {
        var cur = ov[i], orig = pred[i];
        if (!cur || cur.kind !== 'sub') return;
        if (orig && sameP(cur, orig)) return;
        rows.push({
          minute: cur.minute, type: 'sub', id: 'xi:' + side + ':' + i, side: side, player: null,
          playerName: (orig && has(orig.name) ? shortName(orig.name) : '—') + ' → ' + shortName(cur.name),
          teamName: d.teams[side].name,
          onDel: (function (s, idx) { return function () { clearSub(d, s, idx); }; })(side, parseInt(i, 10))
        });
      });
    });
    rows.sort(function (a, b) {
      return (a.minute == null ? 999 : a.minute) - (b.minute == null ? 999 : b.minute);
    });
    return rows;
  }

  // Drag-to-reposition. The trailing native `click` is handled separately by the
  // caller; after a real drag we set node._dragged so that click is swallowed.
  function makeDraggable(node, shell, onDrop) {
    node.addEventListener('pointerdown', function (e) {
      if (e.button != null && e.button !== 0) return;
      var rect = shell.getBoundingClientRect();
      var sx = e.clientX, sy = e.clientY, moved = false, last = null;
      try { node.setPointerCapture(e.pointerId); } catch (err) {}
      function move(ev) {
        if (!moved && Math.abs(ev.clientX - sx) + Math.abs(ev.clientY - sy) > 4) {
          moved = true;
          node.classList.add('dragging');
        }
        if (!moved) return;
        var left = clamp(((ev.clientX - rect.left) / rect.width) * 100, 2, 98);
        var top = clamp(((ev.clientY - rect.top) / rect.height) * 100, 3, 97);
        last = { left: left, top: top };
        node.style.left = left.toFixed(2) + '%';
        node.style.top = top.toFixed(2) + '%';
      }
      function end() {
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', end);
        node.removeEventListener('pointercancel', end);
        node.classList.remove('dragging');
        if (moved && last) {
          node._dragged = true;
          setTimeout(function () { node._dragged = false; }, 350);
          onDrop(last);
        }
      }
      node.addEventListener('pointermove', move);
      node.addEventListener('pointerup', end);
      node.addEventListener('pointercancel', end);
    });
  }

  /* ---------- render ---------- */
  var pitchEl = null;
  function rerenderPitch(data) {
    var next = pitch(data);
    if (pitchEl) pitchEl.replaceWith(next);
    pitchEl = next;
  }

  function render(data) {
    applyManualOverlay(data);
    applyPnum(data);
    applyPname(data);
    applyDiscColors(data);
    applyI18nOverlay(data);
    document.title = data.teams.home.name + ' – ' + data.teams.away.name + ' · Match Center';
    root.innerHTML = '';
    pitchEl = null;
    panelsEl = null;

    var orientBtn = el('button', {
      text: view.orientation === 'v' ? t('toolbar.viewHorizontal') : t('toolbar.viewVertical'),
      onclick: function () {
        view.orientation = view.orientation === 'v' ? 'h' : 'v';
        orientBtn.textContent = view.orientation === 'v' ? t('toolbar.viewHorizontal') : t('toolbar.viewVertical');
        saveView();
        rerenderPitch(data);
      }
    });
    var swapBtn = el('button', {
      text: t('toolbar.swapSides'),
      onclick: function () { view.swapped = !view.swapped; saveView(); rerenderPitch(data); }
    });
    var resetPosBtn = el('button', {
      text: t('toolbar.resetPositions'),
      onclick: function () {
        if (store.lineup) { delete store.lineup; save(); rerenderPitch(data); }
      }
    });
    var namesBtn = el('button', {
      text: view.fullNames ? t('toolbar.shortNames') : t('toolbar.fullNames'),
      onclick: function () {
        view.fullNames = !view.fullNames;
        namesBtn.textContent = view.fullNames ? t('toolbar.shortNames') : t('toolbar.fullNames');
        saveView();
        rerenderPitch(data);
      }
    });
    var SIZE_LABELS = ['M', 'L', 'XL'];
    var fontBtn = el('button', {
      text: t('toolbar.textSize', { size: SIZE_LABELS[view.labelSize] }),
      onclick: function () {
        view.labelSize = (view.labelSize + 1) % 3;
        fontBtn.textContent = t('toolbar.textSize', { size: SIZE_LABELS[view.labelSize] });
        saveView();
        rerenderPitch(data);
      }
    });
    var resetOrderBtn = el('button', {
      text: t('toolbar.resetPanelLayout'),
      title: t('toolbar.resetPanelLayoutTitle'),
      onclick: function () {
        var ch = false;
        if (store.panelOrder) { delete store.panelOrder; ch = true; }
        if (store.panelWide) { delete store.panelWide; ch = true; }
        if (ch) { save(); rerenderPanels(data); }
      }
    });
    function discSwatch(side) {
      var inp = el('input', {
        type: 'color', class: 'ds-input', value: resolveDisc(data, side),
        title: t('toolbar.discColorTitle', { team: data.teams[side].name }),
        oninput: function () {
          store.discColors = store.discColors || {};
          store.discColors[side] = inp.value;
          save(); applyDiscColors(data); rerenderPitch(data);
        }
      });
      return el('label', { class: 'disc-swatch' }, [
        el('span', { text: (data.teams[side].shortName || data.teams[side].name).slice(0, 3).toUpperCase() }),
        inp
      ]);
    }
    var discReset = el('button', {
      text: t('toolbar.resetColors'), title: t('toolbar.resetColorsTitle'),
      onclick: function () {
        if (store.discColors) { delete store.discColors; save(); render(data); }
      }
    });
    var favBtn = el('button', {
      text: (window.MC_COLLAB && window.MC_COLLAB.isFavourite(slug)) ? t('toolbar.favourite') : t('toolbar.notFavourite'),
      title: t('toolbar.favouriteTitle'),
      onclick: async function () {
        if (!window.MC_COLLAB) return;
        try {
          var yes = await window.MC_COLLAB.toggleFavourite(slug, staleFavouriteSlugs());
          favBtn.textContent = yes ? t('toolbar.favourite') : t('toolbar.notFavourite');
        } catch (e) { openCollaboration(data); }
      }
    });
    var collabBtn = el('button', {
      text: (window.MC_COLLAB && window.MC_COLLAB.status().online) ? t('toolbar.collabConnected', { name: window.MC_COLLAB.status().name || t('toolbar.collabUser') }) : t('toolbar.collabConnect'),
      title: t('toolbar.collabTitle'),
      onclick: function () { openCollaboration(data); }
    });
    var langSwitch = I18N.switcherEl(function () { render(data); });
    var themeToggle = window.MC_THEME.toggleEl();

    // header
    var metaWrap = el('div', { class: 'mc-meta' }, [
      data.competition.logo ? el('img', { class: 'comp-logo', src: data.competition.logo, alt: '' }) : null,
      document.createTextNode(metaLine(data))
    ]);
    if (!has(data.venue && data.venue.name)) {
      metaWrap.appendChild(el('button', { class: 'meta-add', text: t('toolbar.addVenue'), onclick: function () { openEditVenue(data); } }));
    }
    var head = el('div', { class: 'mc-head' }, [
      el('div', { class: 'mc-head-top' }, [
        el('a', { class: 'mc-back', href: 'index.html', text: t('toolbar.backToList') }),
        el('div', { class: 'mc-head-controls' }, [themeToggle, langSwitch])
      ]),
      el('div', { class: 'mc-teams' }, [
        el('span', {}, [
          data.teams.home.logo ? el('img', { class: 'team-logo', src: data.teams.home.logo, alt: '' }) : null,
          document.createTextNode(data.teams.home.name),
          has(data.teams.home.nickname) ? el('small', { class: 'nickname', text: ' „' + data.teams.home.nickname + '"' }) : null
        ]),
        el('span', { class: 'vs', text: t('common.vs') }),
        el('span', {}, [
          data.teams.away.logo ? el('img', { class: 'team-logo', src: data.teams.away.logo, alt: '' }) : null,
          document.createTextNode(data.teams.away.name),
          has(data.teams.away.nickname) ? el('small', { class: 'nickname', text: ' „' + data.teams.away.nickname + '"' }) : null
        ])
      ]),
      metaWrap,
      (data._skeleton || data._partial) ? skeletonBanner(data) : null,
      el('div', { class: 'mc-toolbar' }, [
        swapBtn,
        orientBtn,
        namesBtn,
        fontBtn,
        formationSelect(data, 'home'),
        formationSelect(data, 'away'),
        discSwatch('home'),
        discSwatch('away'),
        discReset,
        favBtn,
        collabBtn,
        resetPosBtn,
        resetOrderBtn,
        el('button', { text: t('toolbar.print'), onclick: function () { window.print(); } }),
        el('button', { text: t('toolbar.exportNotes'), onclick: function () { exportNotes(data); } }),
        el('button', { text: t('toolbar.expandCollapse'), onclick: toggleAll }),
        el('button', { text: t('toolbar.deleteAllNotes'), onclick: function () {
          if (confirm(t('toolbar.confirmDeleteAllNotes'))) { delete store.notes; save(); render(data); }
        } })
      ])
    ]);
    root.appendChild(head);

    pitchEl = pitch(data);
    var asideH = teamAside(data, 'home');
    var asideA = teamAside(data, 'away');
    root.appendChild(el('div', { class: 'pitch-row' + ((asideH || asideA) ? ' has-aside' : '') }, [asideH, pitchEl, asideA]));

    panelsEl = panels(data);
    root.appendChild(panelsEl);

    setupStickyScore(data);
  }

  // A compact scoreboard that appears fixed at the top once the real pitch
  // scrolls out of view, so the commentator still sees who's playing and the
  // score while reading panels further down. IntersectionObserver on the
  // pitch row itself -- no manual scroll-position math, and it naturally
  // re-shows once scrolled back up to the pitch. Torn down and rebuilt on
  // every full render() (language/theme switch, orientation, etc. all
  // rebuild `root` from scratch, which would otherwise leave a stale
  // observer watching a detached node).
  var stickyObserver = null;
  function setupStickyScore(d) {
    if (stickyObserver) { stickyObserver.disconnect(); stickyObserver = null; }
    var old = document.querySelector('.mc-sticky-score');
    if (old) old.remove();
    var pitchRow = document.querySelector('.pitch-row');
    if (!pitchRow || typeof IntersectionObserver === 'undefined') return;

    var bar = el('div', { class: 'mc-sticky-score', title: t('pitch.scrollToTop') }, [
      el('span', { class: 'mss-team home' }, [
        d.teams.home.logo ? el('img', { src: d.teams.home.logo, alt: '' }) : null,
        document.createTextNode(d.teams.home.shortName || d.teams.home.name)
      ]),
      el('strong', { class: 'mss-result', text: scoreFor(d, 'home') + ' – ' + scoreFor(d, 'away') }),
      el('span', { class: 'mss-team away' }, [
        document.createTextNode(d.teams.away.shortName || d.teams.away.name),
        d.teams.away.logo ? el('img', { src: d.teams.away.logo, alt: '' }) : null
      ])
    ]);
    bar.addEventListener('click', function () {
      pitchRow.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    document.body.appendChild(bar);

    stickyObserver = new IntersectionObserver(function (entries) {
      bar.classList.toggle('show', !entries[0].isIntersecting);
    }, { threshold: 0 });
    stickyObserver.observe(pitchRow);
  }

  function openCollaboration(data) {
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        el('div', { class: 'avatar', text: '👥' }),
        el('div', {}, [el('h3', { text: t('collab.title') }), el('div', { class: 'sub', text: t('collab.subtitle') })]),
        el('button', { class: 'modal-close', text: '×', onclick: close })
      ]);
    }, {
      [t('collab.tabProfile')]: function () {
        var s = window.MC_COLLAB ? window.MC_COLLAB.status() : { configured: false };
        var field = el('input', { class: 'field', value: s.name || '', placeholder: t('collab.namePlaceholder') });
        var msg = el('div', { class: 'ev-empty', text: s.configured ? (s.online ? t('collab.online') : t('collab.offlinePrompt')) : t('collab.localOnly') });
        var saveName = el('button', { class: 'pick', text: t('collab.saveName'), onclick: async function () {
          if (!window.MC_COLLAB) return;
          await window.MC_COLLAB.setName(field.value); msg.textContent = t('collab.nameSaved', { name: window.MC_COLLAB.status().name || t('collab.defaultUser') });
        } });
        var email = el('input', { class: 'field', type: 'email', placeholder: t('collab.emailPlaceholder') });
        var sendLink = el('button', { class: 'pick', text: t('collab.sendMagicLink'), onclick: async function () {
          try { var to = await window.MC_COLLAB.sendMagicLink(email.value); msg.textContent = t('collab.magicLinkSent', { email: to }); } catch (e) { msg.textContent = e.message || t('collab.magicLinkFailed'); }
        } });
        var logout = el('button', { class: 'pick', text: t('collab.signOut'), onclick: async function () { await window.MC_COLLAB.signOut(); close(); render(data); } });
        var auth = s.configured && !s.online
          ? el('div', {}, [el('p', { text: t('collab.authIntro') }), email, el('div', { class: 'ev-btns' }, [sendLink])])
          : (s.online ? el('div', { class: 'ev-btns' }, [logout]) : null);
        return el('div', {}, [el('p', { text: t('collab.profileHint') }), field, el('div', { class: 'ev-btns' }, [saveName]), auth, msg]);
      },
      [t('collab.tabActivity')]: function () {
        var wrap = el('div', {}, [el('div', { class: 'ev-empty', text: t('collab.activityLoading') }) ]);
        if (!window.MC_COLLAB || !window.MC_COLLAB.configured()) { wrap.firstChild.textContent = t('collab.activityUnavailable'); return wrap; }
        window.MC_COLLAB.changes(slug).then(function (items) {
          wrap.innerHTML = '';
          if (!items.length) { wrap.appendChild(el('div', { class: 'ev-empty', text: t('collab.activityEmpty') })); return; }
          items.forEach(function (item) { wrap.appendChild(el('div', { class: 'ev-row' }, [el('span', { text: item.display_name + ' — ' + item.summary }), el('time', { text: new Date(item.changed_at).toLocaleString(I18N.localeTag(), { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })])); });
        });
        return wrap;
      }
    });
  }

  function skeletonBanner(d) {
    var haveSquads = (d.teams.home.squad || []).length && (d.teams.away.squad || []).length;
    var lead = d._partial
      ? t('skeleton.partialLead')
      : t('skeleton.noneLead') +
        (haveSquads ? t('skeleton.squadsLoaded') : ' ') +
        t('skeleton.fillRest');
    var tail = haveSquads
      ? t('skeleton.tailWithSquads')
      : t('skeleton.tailNoSquads');
    return el('div', { class: 'skeleton-banner' }, [
      el('span', { text: lead + tail })
    ]);
  }

  function metaLine(d) {
    var bits = [];
    if (has(d.competition.name)) bits.push(d.competition.name);
    if (has(d.competition.round)) bits.push(d.competition.round);
    if (has(d.kickoff)) {
      var dt = new Date(d.kickoff);
      bits.push(isNaN(dt) ? d.kickoff : dt.toLocaleString(I18N.localeTag(), { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }));
    }
    if (has(d.venue && d.venue.name)) bits.push(d.venue.name + (has(d.venue.city) ? ', ' + d.venue.city : ''));
    if (has(d.broadcast)) bits.push('📺 ' + d.broadcast);
    return bits.join('  ·  ');
  }

  function pitch(d) {
    var vert = view.orientation === 'v';
    var nearKey = view.swapped ? 'away' : 'home';
    var shell = el('div', { class: 'pitch-shell' + (vert ? ' vertical' : '') + (view.fullNames ? ' full-names' : '') + (view.labelSize === 1 ? ' lbl-1' : view.labelSize === 2 ? ' lbl-2' : '') }, [
      el('div', { class: 'pitch-lines' }),
      el('div', { class: 'pitch-box a' }),
      el('div', { class: 'pitch-box b' })
    ]);

    ['home', 'away'].forEach(function (side) {
      var tm = d.teams[side];
      var isNear = side === nearKey;
      var xi = effXI(d, side);
      var pts = layout(effFormation(d, side));
      var squad = effSquad(d, side);
      xi.forEach(function (slot, i) {
        var isEmpty = !has(slot.name);
        var full = isEmpty ? null : playerByNameOrNum(squad, slot);
        var pkey = slot.number != null ? String(slot.number) : slot.name;
        var override = pkey && store.lineup && store.lineup[side] && store.lineup[side][pkey];
        var pos = place(override || pts[i] || { d: 0.03, w: 0.05 + i * 0.08 }, isNear);
        var stat = full && full.status;
        var cap = !isEmpty && isCaptain(side, full || slot);
        var ec = full ? evCounts(side, full) : { goal: 0, owngoal: 0, yellow: 0, red: 0 };
        var badges = null;
        if (ec.goal || ec.owngoal || ec.yellow || ec.red) {
          badges = el('div', { class: 'node-badges' }, [
            ec.goal ? el('span', { class: 'nb goal', text: '⚽' + (ec.goal > 1 ? '×' + ec.goal : '') }) : null,
            ec.owngoal ? el('span', { class: 'nb og', text: 'AG' + (ec.owngoal > 1 ? '×' + ec.owngoal : '') }) : null,
            ec.yellow ? el('span', { class: 'nb yc', text: ec.yellow > 1 ? String(ec.yellow) : '' }) : null,
            ec.red ? el('span', { class: 'nb rc' }) : null
          ]);
        }
        var node = el('div', {
          class: 'node ' + side + (isEmpty ? ' empty' : (stat && stat !== 'available' ? ' status-' + stat : '')) + (override ? ' moved' : '') + (ec.red ? ' sent-off' : '') + (cap ? ' is-captain' : ''),
          style: 'left:' + pos.left.toFixed(2) + '%;top:' + pos.top.toFixed(2) + '%',
          title: isEmpty ? t('pitch.addPlayerHere') : t('pitch.dragOrClick'),
          onclick: function () {
            if (node._dragged) { node._dragged = false; return; }
            if (isEmpty) openAddPlayer(d, side, i);
            else if (full) openPlayer(d, side, full);
          }
        }, [
          el('div', { class: 'disc' }, [
            el('span', { text: isEmpty ? '+' : (slot.number != null ? String(slot.number) : (slot.pos || '')) }),
            cap ? el('span', { class: 'cap-mark', text: 'C' }) : null
          ]),
          badges,
          el('div', { class: 'lbl', text: isEmpty ? t('pitch.emptySlot') : (view.fullNames ? (slot.name || '') : shortName(slot.name)) }),
          (!isEmpty && full && (has(full.age) || has(full.nat)))
            ? el('div', { class: 'lbl-sub', text: '(' + [has(full.age) ? t('player.ageValue', { n: full.age }) : null, full.nat].filter(Boolean).join(', ') + ')' })
            : null,
          (!isEmpty && full && statLine(full))
            ? el('div', { class: 'lbl-stat', text: statLine(full) })
            : null
        ]);
        makeDraggable(node, shell, function (p) {
          store.lineup = store.lineup || {};
          store.lineup[side] = store.lineup[side] || {};
          store.lineup[side][pkey] = unplace(p.left, p.top, isNear);
          save();
          node.classList.add('moved');
        });
        shell.appendChild(node);
      });
      // coach mini-card — near team's coach sits at the near end, far team's at the far end
      var coachCorner = vert ? (isNear ? 'bl' : 'tr') : (isNear ? 'tl' : 'tr');
      if (tm.coach && has(tm.coach.name)) {
        shell.appendChild(el('div', { class: 'card-slot ' + coachCorner }, [
          el('div', { class: 'mini-card', onclick: function () { openCoach(d, side); } }, [
            el('div', { class: 'mc-role', text: t('pitch.coach') }),
            el('div', { class: 'mc-name', text: tm.coach.name }),
            el('div', { class: 'mc-line', text: [has(tm.coach.country) ? tm.coach.country : null, has(tm.coach.age) ? t('player.ageValue', { n: tm.coach.age }) : null, effFormation(d, side)].filter(Boolean).join(' · ') })
          ])
        ]));
      } else {
        shell.appendChild(el('div', { class: 'card-slot ' + coachCorner }, [
          el('div', { class: 'mini-card add-card', onclick: function () { openEditCoach(d, side); } }, [
            el('div', { class: 'mc-name', text: t('pitch.addCoach') })
          ])
        ]));
      }
    });

    // referee — on the halfway line
    if (d.referee && has(d.referee.name)) {
      shell.appendChild(el('div', { class: 'card-slot ref ' + (vert ? 'cr' : 'bc') }, [
        el('div', { class: 'mini-card', onclick: function () { openRef(d); } }, [
          el('div', { class: 'mc-role', text: t('pitch.referee') }),
          el('div', { class: 'mc-name', text: d.referee.name }),
          el('div', { class: 'mc-line', text: [has(d.referee.country) ? d.referee.country : null, has(d.referee.ycPerMatch) ? t('pitch.ycPerMatch', { n: d.referee.ycPerMatch }) : null].filter(Boolean).join(' · ') })
        ])
      ]));
    } else {
      shell.appendChild(el('div', { class: 'card-slot ref ' + (vert ? 'cr' : 'bc') }, [
        el('div', { class: 'mini-card add-card', onclick: function () { openEditReferee(d); } }, [
          el('div', { class: 'mc-name', text: t('pitch.addReferee') })
        ])
      ]));
    }

    return el('div', { class: 'pitch-wrap' }, [matchGraphic(d), shell, benchStrip(d), subsStrip(d)]);
  }

  function matchGraphic(d) {
    var score = el('div', { class: 'match-graphic-score' }, [
      el('span', { class: 'mgs-team home', text: d.teams.home.name }),
      el('strong', { class: 'mgs-result', text: scoreFor(d, 'home') + ' – ' + scoreFor(d, 'away') }),
      el('span', { class: 'mgs-team away', text: d.teams.away.name })
    ]);
    var cornersHeading = el('div', { class: 'corner-counter-h', text: t('pitch.cornersHeading') });
    var corners = el('div', { class: 'corner-counter' });
    ['home', 'away'].forEach(function (side) {
      var c = cornerCounts(side), team = d.teams[side];
      var row = el('div', { class: 'corner-team ' + side }, [
        el('strong', { text: team.shortName || team.name }),
        el('span', { class: 'corner-total', text: t('pitch.cornerTotal', { n: c.left + c.right }) })
      ]);
      ['left', 'right'].forEach(function (flank) {
        var flankLabel = flank === 'left' ? t('pitch.left') : t('pitch.right');
        row.appendChild(el('span', { class: 'corner-cell' }, [
          el('span', { class: 'corner-label', text: flankLabel }),
          el('button', { class: 'corner-btn', title: t('pitch.cornerMinus', { side: flankLabel }), text: '−', onclick: function () { adjustCorner(d, side, flank, -1); } }),
          el('b', { text: String(c[flank]) }),
          el('button', { class: 'corner-btn', title: t('pitch.cornerPlus', { side: flankLabel }), text: '+', onclick: function () { adjustCorner(d, side, flank, 1); } })
        ]));
      });
      corners.appendChild(row);
    });
    return el('div', { class: 'match-graphic' }, [score, cornersHeading, corners]);
  }

  // The substitutes' bench, drawn on the touchline below the pitch — one row per
  // team. Chips open the player card (Schimbă tab to send them on). "＋/✎" picks
  // which squad players sit on the bench; "↺" returns to the full implicit bench.
  function benchStrip(d) {
    var wrap = el('div', { class: 'bench-strip' });
    ['home', 'away'].forEach(function (side) {
      var players = benchList(d, side);
      var explicit = !!(store.bench && store.bench[side] && store.bench[side].length);
      var squad = effSquad(d, side);
      var row = el('div', { class: 'bench-team ' + side }, [
        el('span', { class: 'bench-label', text: t('pitch.benchLabel', { team: d.teams[side].shortName || d.teams[side].name }) }),
        el('button', { class: 'bench-add', title: t('pitch.pickBench'), text: explicit ? '✎' : '＋', onclick: function () { openBenchPicker(d, side); } })
      ]);
      if (explicit) {
        row.appendChild(el('button', { class: 'bench-add', title: t('pitch.allBench'), text: '↺', onclick: function () { setBench(d, side, null); } }));
      }
      if (!players.length) {
        row.appendChild(el('span', { class: 'bench-empty', text: explicit ? t('pitch.benchNone') : '—' }));
      }
      players.forEach(function (p) {
        var full = playerByNameOrNum(squad, p);
        var st = full && full.status;
        row.appendChild(el('button', {
          class: 'bench-chip' + (st && st !== 'available' ? ' status-' + st : '') + (isCaptain(side, p) ? ' is-captain' : ''),
          title: t('pitch.nodeTitle', { name: p.name, tags: (isCaptain(side, p) ? t('pitch.captainTag') : '') + (st && st !== 'available' ? ' · ' + statusLabel(st) : '') }),
          onclick: function () { openPlayer(d, side, full); }
        }, [
          el('span', { class: 'bench-num', text: p.number != null ? String(p.number) : '' }),
          el('span', { class: 'bench-nm', text: shortName(p.name) })
        ]));
      });
      wrap.appendChild(row);
    });
    return wrap;
  }

  function openBenchPicker(d, side) {
    var back = el('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    var xiKeys = effXI(d, side).map(keyOf);
    var cand = effSquad(d, side).filter(function (p) { return xiKeys.indexOf(keyOf(p)) < 0; });
    var cur = (store.bench && store.bench[side]) || null;
    var chosen = {};
    (cur || cand.map(keyOf)).forEach(function (k) { chosen[k] = true; });

    var list = el('div', { class: 'bench-pick-list' });
    groupPick(cand).forEach(function (grp) {
      list.appendChild(el('h4', { text: grp.label }));
      grp.items.forEach(function (p) {
        var k = keyOf(p);
        var b = el('button', {
          class: 'bench-pick' + (chosen[k] ? ' on' : ''),
          text: (p.number != null ? '#' + p.number + '  ' : '') + p.name + (p.status && p.status !== 'available' ? '  ·  ' + statusLabel(p.status) : ''),
          onclick: function () { chosen[k] = !chosen[k]; b.classList.toggle('on', !!chosen[k]); }
        });
        list.appendChild(b);
      });
    });
    if (!cand.length) list.appendChild(el('p', { class: 'sub-note', text: t('bench.none') }));

    back.appendChild(el('div', { class: 'modal', style: 'max-width:400px' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: t('bench.title', { team: d.teams[side].name }) }),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]),
      el('div', { class: 'modal-body' }, [
        el('p', { class: 'sub-note', text: t('bench.hint') }),
        list,
        el('div', { class: 'notes-row' }, [
          el('button', { class: 'pick', text: t('common.save'), onclick: function () {
            var keys = Object.keys(chosen).filter(function (k) { return chosen[k]; });
            setBench(d, side, keys.length === cand.length ? null : keys);
            close();
          } })
        ])
      ])
    ]));
    document.body.appendChild(back);
  }

  // Below the pitch: one line per team listing the manual swaps, each removable.
  function subsStrip(d) {
    var strip = el('div', { class: 'subs-strip' });
    ['home', 'away'].forEach(function (side) {
      var pred = d.teams[side].predictedXI || [];
      var ov = (store.xi && store.xi[side]) || {};
      var made = [];
      pred.forEach(function (orig, i) {
        var cur = ov[i];
        if (cur && !sameP(cur, orig)) made.push({ i: i, out: orig, inn: cur });
      });
      if (!made.length) return;
      var row = el('div', { class: 'subs-team' }, [
        el('span', { class: 'subs-label', text: d.teams[side].name })
      ]);
      made.forEach(function (m) {
        var kind = (m.inn && m.inn.kind === 'sub') ? 'sub' : 'xi';
        var mm = m.inn && m.inn.minute;
        row.appendChild(el('span', { class: 'sub-chip ' + kind }, [
          el('span', { class: 'sub-kind', text: kind === 'sub' ? t('sub.badgeMatch') : t('sub.badgeLineup') }),
          (kind === 'sub' && mm != null) ? el('span', { class: 'sub-min-badge', text: mm + "'" }) : null,
          el('span', { text: shortName(m.out.name) + '  ' + (kind === 'sub' ? '↦' : '⇄') + '  ' + shortName(m.inn.name) }),
          el('button', { text: '✕', title: t('sub.cancel'), onclick: function () { clearSub(d, side, m.i); } })
        ]));
      });
      strip.appendChild(row);
    });
    return strip;
  }

  // form-guide helpers: "2026-08-29" -> "29.08"; strip the country prefix and
  // collapse friendlies for the competition label
  function fgDate(s) {
    var m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || '');
    return m ? m[3] + '.' + m[2] : (has(s) ? s : '');
  }
  function fgComp(c) {
    if (!has(c)) return '';
    if (/friendl|amical/i.test(c)) return t('panel.friendly');
    return String(c).replace(/^(France|England|Spain|Italy|Germany|Romania|Europe|Elite Club)\s+/i, '');
  }
  // full league table; the two teams in this fixture are highlighted
  function standingsTable(d) {
    var s = d.standings || {};
    var rows = s.rows || [];
    if (!rows.length) return el('div', { text: t('common.na') });
    var mine = {};
    [d.teams.home, d.teams.away].forEach(function (t) { mine[teamKey(t.name)] = true; });
    var head = el('tr', {}, [t('standings.rank'), t('standings.team'), t('standings.played'), t('standings.win'), t('standings.draw'), t('standings.loss'), t('standings.goals'), t('standings.gd'), t('standings.points')].map(function (h) {
      return el('th', { text: h });
    }));
    var tb = el('table', { class: 'mc standings' }, [head]);
    rows.forEach(function (r) {
      var gd = r.gd == null ? '' : (r.gd > 0 ? '+' + r.gd : '' + r.gd);
      tb.appendChild(el('tr', { class: mine[teamKey(r.team)] ? 'is-mine' : null }, [
        el('td', { text: r.rank == null ? '' : r.rank }),
        el('td', { class: 'st-team', text: has(r.team) ? r.team : '—' }),
        el('td', { text: r.played == null ? '' : r.played }),
        el('td', { text: r.win == null ? '' : r.win }),
        el('td', { text: r.draw == null ? '' : r.draw }),
        el('td', { text: r.loss == null ? '' : r.loss }),
        el('td', { text: (r.gf == null ? '' : r.gf) + ':' + (r.ga == null ? '' : r.ga) }),
        el('td', { text: gd }),
        el('td', { class: 'st-pts', text: r.points == null ? '' : r.points })
      ]));
    });
    return el('div', { class: 'standings-wrap' }, [tb]);
  }
  function shortName(name) {
    var parts = String(name || '').split(/\s+/).filter(Boolean);
    if (parts.length < 2) return name || '';
    // drop a trailing generational suffix (Jr., Sr., II, III)
    if (/^(jr|sr|ii|iii|iv)\.?$/i.test(parts[parts.length - 1])) parts.pop();
    var last = parts[parts.length - 1];
    return parts.length > 1 ? parts[0].charAt(0) + '. ' + last : last;
  }
  function playerByNameOrNum(squad, slot) {
    return (squad || []).filter(function (p) {
      return (slot.number != null && p.number === slot.number) || p.name === slot.name;
    })[0] || { name: slot.name, number: slot.number, pos: slot.pos, role: 'MID' };
  }

  /* ---------- panels ---------- */
  function panel(title, bodyNode, opts) {
    opts = opts || {};
    var d = el('details', { class: 'panel' + (opts.lead ? ' lead' : ''), open: opts.open ? '' : null }, [
      el('summary', { text: title }),
      el('div', { class: 'body' }, [bodyNode])
    ]);
    return d;
  }
  function toggleAll() {
    var ds = document.querySelectorAll('details.panel');
    var anyClosed = [].some.call(ds, function (x) { return !x.open; });
    [].forEach.call(ds, function (x) { x.open = anyClosed; });
  }

  function ul(items) {
    return el('ul', {}, (items || []).filter(has).map(function (t) { return el('li', { text: t }); }));
  }

  // Per-team "Informații echipă" — the old FIRE bars, moved to a column on that
  // team's flank of the pitch (see render()). null when the team has no stories.
  function teamAside(d, side) {
    var tm = d.teams[side];
    var box = el('div', { class: 'team-aside ' + side }, [
      el('div', { class: 'team-aside-title', text: t('aside.teamInfo', { team: tm.shortName || tm.name }) })
    ]);
    (tm.stories || []).forEach(function (s) {
      box.appendChild(el('div', { class: 'story-bar' }, [el('h4', { text: s.title }), ul(s.bullets)]));
    });
    box.appendChild(el('div', { class: 'ta-add-h', text: t('aside.yourNotes') }));
    box.appendChild(extrasBox('teaminfo:' + side, t('aside.addInfo', { team: tm.name })));
    return box;
  }

  function panels(d) {
    var defs = [];
    function add(key, node) { if (node) defs.push({ key: key, node: node }); }

    if (d.storyOfTheMatch && d.storyOfTheMatch.length) {
      add('story', panel(t('panel.story'), ul(d.storyOfTheMatch), { lead: true, open: true }));
    }

    // API-Football's own algorithmic model (predictions?fixture=) — computed
    // percentages from the provider, not written by a language model.
    if (d.predictions) {
      var pr = d.predictions;
      var pbody = el('div', { class: 'prediction' });
      if (pr.percent && (pr.percent.home != null || pr.percent.draw != null || pr.percent.away != null)) {
        var segs = [
          { v: pr.percent.home, cls: 'ph', label: d.teams.home.shortName || d.teams.home.name },
          { v: pr.percent.draw, cls: 'pd', label: t('panel.draw') },
          { v: pr.percent.away, cls: 'pa', label: d.teams.away.shortName || d.teams.away.name }
        ].filter(function (s) { return s.v != null; });
        var bar = el('div', { class: 'prediction-bar' });
        segs.forEach(function (s) {
          bar.appendChild(el('div', { class: 'prediction-seg ' + s.cls, style: 'flex:' + s.v, title: s.label + ': ' + s.v + '%' }));
        });
        pbody.appendChild(bar);
        pbody.appendChild(el('div', { class: 'prediction-legend' }, segs.map(function (s) {
          return el('span', { class: 'pl-dot ' + s.cls, text: s.label + ' ' + s.v + '%' });
        })));
      }
      if (has(pr.advice)) pbody.appendChild(el('p', { class: 'prediction-advice', text: pr.advice }));
      if (pr.comparison) {
        var cmpRows = [
          ['form', t('panel.cmpForm')], ['attack', t('panel.cmpAttack')], ['defense', t('panel.cmpDefense')],
          ['poisson', t('panel.cmpPoisson')], ['h2h', t('panel.cmpH2h')], ['goals', t('panel.cmpGoals')]
        ];
        var cmp = el('table', { class: 'mc prediction-cmp' });
        cmpRows.forEach(function (r) {
          var v = pr.comparison[r[0]];
          if (!v || (v.home == null && v.away == null)) return;
          cmp.appendChild(el('tr', {}, [
            el('td', { text: v.home != null ? v.home + '%' : '—' }),
            el('th', { text: r[1] }),
            el('td', { text: v.away != null ? v.away + '%' : '—' })
          ]));
        });
        if (cmp.childNodes.length) pbody.appendChild(cmp);
      }
      if (pbody.childNodes.length) add('predictions', panel(t('panel.predictions'), pbody, { open: true }));
    }

    if (d.commentatorResearch && d.commentatorResearch.length) {
      var researchBody = el('div', { class: 'research-cards' });
      d.commentatorResearch.forEach(function (card) {
        researchBody.appendChild(el('div', { class: 'research-card' }, [
          el('h4', { text: card.topic }),
          el('p', { text: card.fact }),
          card.source ? el('a', { href: card.source, target: '_blank', rel: 'noopener noreferrer', text: t('common.source') }) : null
        ]));
      });
      add('research', panel(t('panel.research'), researchBody, { open: true }));
    }

    // H2H
    if (d.h2h && ((d.h2h.recent && d.h2h.recent.length) || has(d.h2h.summary))) {
      var h = el('div');
      if (d.h2h.recent && d.h2h.recent.length) {
        var tb = el('table', { class: 'mc' }, [
          el('tr', {}, [el('th', { text: t('panel.h2hDate') }), el('th', { text: t('panel.h2hComp') }), el('th', { text: t('panel.h2hScore') })])
        ]);
        d.h2h.recent.forEach(function (r) {
          var hasDetails = (r.formation && (r.formation.home || r.formation.away)) || (r.lineups && (r.lineups.home || r.lineups.away)) ||
            (r.events && r.events.length) || has(r.referee);
          var names = /^(.*) \d+-\d+ (.*)$/.exec(r.score || '');
          tb.appendChild(el('tr', hasDetails ? {
            class: 'clickable', title: t('panel.h2hDetailsHint'),
            onclick: function () {
              openMatchHistory(r.score, [r.date, has(r.comp) ? r.comp : null].filter(has).join(' · '), r.referee,
                { key: 'home', label: names ? names[1] : t('panel.h2hScore'), formation: r.formation && r.formation.home, lineup: r.lineups && r.lineups.home },
                { key: 'away', label: names ? names[2] : '', formation: r.formation && r.formation.away, lineup: r.lineups && r.lineups.away },
                r.events);
            }
          } : {}, [el('td', { text: r.date }), el('td', { text: has(r.comp) ? r.comp : '—' }), el('td', { text: r.score })]));
        });
        h.appendChild(tb);
      }
      if (has(d.h2h.summary)) h.appendChild(el('p', { text: d.h2h.summary }));
      add('h2h', panel(t('panel.h2h'), h, { open: true }));
    }

    // Form (two-col) — OneFootball-style: W/D/L badges, a standings row, a
    // form guide (last matches with scores), plus PPG / home-away split.
    if (d.teams.home.form || d.teams.away.form) {
      add('form', panel(t('panel.form'), twoCol(d, function (tm) {
        var wrap = el('div');
        var f = tm.form || {};
        var badges = (f.last5 && f.last5.length) ? f.last5
          : (f.recent || []).slice(0, 5).map(function (r) { return r.result; }).filter(has);
        if (badges.length) {
          var b = el('div', { class: 'form-badges' });
          badges.forEach(function (r) { b.appendChild(el('span', { class: 'fb-' + r, text: r })); });
          wrap.appendChild(b);
        }
        var tbl = f.table || {};
        if (has(f.position) || has(tbl.points)) {
          var bits = [];
          if (has(f.position)) bits.push(t('panel.formRank', { n: f.position }));
          if (has(tbl.played)) bits.push(tbl.played + t('panel.formPlayedSuffix'));
          if (has(tbl.win)) bits.push(tbl.win + '-' + (tbl.draw || 0) + '-' + (tbl.loss || 0));
          if (has(tbl.gf)) bits.push(tbl.gf + '-' + tbl.ga);
          if (has(tbl.points)) bits.push(tbl.points + 'p');
          wrap.appendChild(el('div', { class: 'form-table', text: bits.join('  ·  ') }));
        }
        if (f.recent && f.recent.length) {
          var list = el('ul', { class: 'form-guide' });
          f.recent.forEach(function (r) {
            var hasDetails = (r.formation && (r.formation.us || r.formation.opp)) || (r.lineups && (r.lineups.us || r.lineups.opp)) ||
              (r.events && r.events.length) || has(r.referee);
            list.appendChild(el('li', hasDetails ? {
              class: 'clickable', title: t('panel.h2hDetailsHint'),
              onclick: function () {
                openMatchHistory(tm.name + '  ' + r.score + '  ' + (has(r.opp) ? r.opp : ''),
                  [fgDate(r.date), fgComp(r.comp)].filter(has).join(' · '), r.referee,
                  { key: 'us', label: tm.name, formation: r.formation && r.formation.us, lineup: r.lineups && r.lineups.us },
                  { key: 'opp', label: has(r.opp) ? r.opp : '', formation: r.formation && r.formation.opp, lineup: r.lineups && r.lineups.opp },
                  r.events);
              }
            } : {}, [
              el('span', { class: 'fg-res fb-' + (r.result || 'D'), text: r.result || '–' }),
              el('span', { class: 'fg-score', text: has(r.score) ? r.score : '' }),
              el('span', { class: 'fg-opp', text: (r.homeAway === 'A' ? 'la ' : r.homeAway === 'H' ? 'cu ' : '') + (has(r.opp) ? r.opp : '') }),
              el('span', { class: 'fg-meta', text: [fgDate(r.date), fgComp(r.comp)].filter(has).join(' · ') })
            ]));
          });
          wrap.appendChild(list);
        }
        if (has(f.ppg)) wrap.appendChild(el('div', { text: t('panel.formPpg', { ppg: f.ppg }) }));
        if (has(f.homeAway)) wrap.appendChild(el('div', { class: 'form-note', text: f.homeAway }));
        if (has(f.note)) wrap.appendChild(el('div', { class: 'form-note', text: f.note }));
        if (f.next && f.next.length) {
          wrap.appendChild(el('div', { class: 'form-next-h', text: t('panel.formNext') }));
          var nx = el('ul', { class: 'form-guide next' });
          f.next.forEach(function (r) {
            nx.appendChild(el('li', {}, [
              el('span', { class: 'fg-res fb-N', text: '·' }),
              el('span', { class: 'fg-opp', text: (r.homeAway === 'A' ? 'la ' : r.homeAway === 'H' ? 'cu ' : '') + (has(r.opp) ? r.opp : '?') }),
              el('span', { class: 'fg-meta', text: [fgDate(r.date), fgComp(r.comp)].filter(has).join(' · ') })
            ]));
          });
          wrap.appendChild(nx);
        }
        if (!wrap.childNodes.length) wrap.appendChild(el('div', { text: t('common.na') }));
        return wrap;
      })));
    }

    // Advanced statistics — everything from API-Football's teams/statistics
    // that the FORM panel above doesn't already surface (home/away splits,
    // biggest win/loss, penalties, goal/card-by-interval), plus a full
    // per-player stat table (shots, passes, tackles, duels, dribbles,
    // fouls) for every squad member who has actually recorded minutes.
    (function () {
      function fmtHA(total, home, away) {
        if (!has(total) && !has(home) && !has(away)) return null;
        var base = has(total) ? String(total) : '';
        var ha = [];
        if (has(home)) ha.push(t('common.home') + ' ' + home);
        if (has(away)) ha.push(t('common.away') + ' ' + away);
        if (ha.length) base += (base ? '  ' : '') + '(' + ha.join(' · ') + ')';
        return base || null;
      }
      function intervalLine(obj) {
        if (!obj) return null;
        var parts = Object.keys(obj).filter(function (k) { return obj[k] != null; }).map(function (k) { return k + ': ' + obj[k]; });
        return parts.length ? parts.join(' · ') : null;
      }
      var anyTeamStats = ['home', 'away'].some(function (s) { return d.teams[s].form && d.teams[s].form.stats; });
      var anyPlayerStats = ['home', 'away'].some(function (s) {
        return (d.teams[s].squad || []).some(function (p) { return p.stats && (p.stats.apps || p.stats.minutes); });
      });
      if (!anyTeamStats && !anyPlayerStats) return;

      var wrap = el('div');
      if (anyTeamStats) {
        wrap.appendChild(twoCol(d, function (tm) {
          var box = el('div');
          var s = (tm.form && tm.form.stats) || null;
          if (!s) { box.appendChild(el('div', { text: t('common.na') })); return box; }
          function row(label, value) {
            if (!has(value)) return;
            box.appendChild(el('div', { class: 'stat-row' }, [el('span', { class: 'stat-label', text: label }), el('span', { class: 'stat-value', text: value })]));
          }
          row(t('stats.goalsFor'), fmtHA(s.goalsForAvg, s.goalsForAvgHome, s.goalsForAvgAway));
          row(t('stats.goalsAgainst'), fmtHA(s.goalsAgainstAvg, s.goalsAgainstAvgHome, s.goalsAgainstAvgAway));
          row(t('stats.cleanSheets'), fmtHA(s.cleanSheets, s.cleanSheetsHome, s.cleanSheetsAway));
          row(t('stats.failedToScore'), fmtHA(s.failedToScore, s.failedToScoreHome, s.failedToScoreAway));
          row(t('stats.penaltyScored'), has(s.penaltyScored) ? s.penaltyScored + (has(s.penaltyScoredPct) ? ' (' + s.penaltyScoredPct + '%)' : '') : null);
          row(t('stats.penaltyMissed'), has(s.penaltyMissed) ? s.penaltyMissed + (has(s.penaltyMissedPct) ? ' (' + s.penaltyMissedPct + '%)' : '') : null);
          row(t('stats.biggestWin'), [has(s.biggestWinHome) && (t('common.home') + ' ' + s.biggestWinHome), has(s.biggestWinAway) && (t('common.away') + ' ' + s.biggestWinAway)].filter(Boolean).join('  ·  ') || null);
          row(t('stats.biggestLoss'), [has(s.biggestLossHome) && (t('common.home') + ' ' + s.biggestLossHome), has(s.biggestLossAway) && (t('common.away') + ' ' + s.biggestLossAway)].filter(Boolean).join('  ·  ') || null);
          var rec = [];
          if (has(s.winsHome) || has(s.drawsHome) || has(s.losesHome)) rec.push(t('common.home') + ' ' + (s.winsHome || 0) + '-' + (s.drawsHome || 0) + '-' + (s.losesHome || 0));
          if (has(s.winsAway) || has(s.drawsAway) || has(s.losesAway)) rec.push(t('common.away') + ' ' + (s.winsAway || 0) + '-' + (s.drawsAway || 0) + '-' + (s.losesAway || 0));
          row(t('stats.record'), rec.join('  ·  ') || null);
          if (s.biggestStreak) {
            var st = s.biggestStreak;
            row(t('stats.longestStreak'), [has(st.wins) && ('W:' + st.wins), has(st.draws) && ('D:' + st.draws), has(st.loses) && ('L:' + st.loses)].filter(Boolean).join('  ') || null);
          }
          if (s.formations && s.formations.length) {
            row(t('stats.formationsUsed'), s.formations.map(function (f) { return f.formation + (has(f.played) ? ' (' + f.played + ')' : ''); }).join('  ·  '));
          }
          var gfi = intervalLine(s.goalsForByInterval), gai = intervalLine(s.goalsAgainstByInterval);
          if (gfi || gai) {
            box.appendChild(el('div', { class: 'stat-label', text: t('stats.goalsByInterval') }));
            if (gfi) box.appendChild(el('div', { class: 'stat-sub', text: '↑ ' + gfi }));
            if (gai) box.appendChild(el('div', { class: 'stat-sub', text: '↓ ' + gai }));
          }
          var cyi = intervalLine(s.cardsYellowByInterval), cri = intervalLine(s.cardsRedByInterval);
          if (cyi || cri) {
            box.appendChild(el('div', { class: 'stat-label', text: t('stats.cardsByInterval') }));
            if (cyi) box.appendChild(el('div', { class: 'stat-sub', text: '🟨 ' + cyi }));
            if (cri) box.appendChild(el('div', { class: 'stat-sub', text: '🟥 ' + cri }));
          }
          if (!box.childNodes.length) box.appendChild(el('div', { text: t('common.na') }));
          return box;
        }));
      }
      if (anyPlayerStats) {
        ['home', 'away'].forEach(function (side) {
          var tm = d.teams[side];
          var rows = (tm.squad || [])
            .filter(function (p) { return p.stats && (p.stats.apps || p.stats.minutes); })
            .sort(function (a, b) { return ((b.stats && b.stats.minutes) || 0) - ((a.stats && a.stats.minutes) || 0); });
          if (!rows.length) return;
          wrap.appendChild(el('h4', { text: (tm.shortName || tm.name) + ' — ' + t('stats.playerTable') }));
          var head = el('tr', {}, ['', t('th.apps'), t('th.min'), t('th.goals'), t('th.assists'), t('th.rating'),
            t('th.shots'), t('th.keyPasses'), t('th.tackles'), t('th.duelsWon'), t('th.dribbles'), t('th.fouls'), t('th.cards')
          ].map(function (h) { return el('th', { text: h }); }));
          var tb = el('table', { class: 'mc playerstats' }, [head]);
          rows.forEach(function (p) {
            var s = p.stats || {};
            tb.appendChild(el('tr', {}, [
              el('td', { class: 'pst-name', text: p.name }),
              el('td', { text: has(s.apps) ? s.apps : '' }),
              el('td', { text: has(s.minutes) ? s.minutes : '' }),
              el('td', { text: has(s.goals) ? s.goals : '' }),
              el('td', { text: has(s.assists) ? s.assists : '' }),
              el('td', { text: has(s.rating) ? s.rating : '' }),
              el('td', { text: has(s.shotsTotal) ? (has(s.shotsOn) ? s.shotsOn + '/' : '') + s.shotsTotal : '' }),
              el('td', { text: has(s.passesKey) ? s.passesKey : '' }),
              el('td', { text: has(s.tacklesTotal) ? s.tacklesTotal : '' }),
              el('td', { text: has(s.duelsTotal) ? (has(s.duelsWon) ? s.duelsWon + '/' : '') + s.duelsTotal : '' }),
              el('td', { text: has(s.dribblesAttempts) ? (has(s.dribblesSuccess) ? s.dribblesSuccess + '/' : '') + s.dribblesAttempts : '' }),
              el('td', { text: has(s.foulsCommitted) ? s.foulsCommitted : '' }),
              el('td', { text: [has(s.yellow) && ('🟨' + s.yellow), has(s.red) && ('🟥' + s.red)].filter(Boolean).join(' ') })
            ]));
          });
          wrap.appendChild(el('div', { class: 'standings-wrap' }, [tb]));
        });
      }
      add('advancedStats', panel(t('panel.advancedStats'), wrap));
    })();

    // League table
    if (d.standings && d.standings.rows && d.standings.rows.length) {
      add('standings', panel(t('panel.standings') + (has(d.standings.league) ? ' · ' + d.standings.league : ''), standingsTable(d)));
    }

    // Absences + probable XI
    add('absences', panel(t('panel.absences'), twoCol(d, function (tm, side) {
      var wrap = el('div');
      wrap.appendChild(el('h4', { text: t('panel.noAbsences') }));
      if (tm.absences && tm.absences.length) {
        wrap.appendChild(ul(tm.absences.map(function (a) {
          return a.name + ' — ' + a.reason + (has(a.detail) ? ' (' + a.detail + ')' : '');
        })));
      } else { wrap.appendChild(el('div', { text: t('panel.noneReported') })); }
      wrap.appendChild(el('h4', { text: t('panel.startingXI', { formation: effFormation(d, side) }) }));
      wrap.appendChild(ul((tm.predictedXI || []).map(function (p) {
        return (p.number != null ? p.number + '. ' : '') + p.name + (has(p.pos) ? '  ' + p.pos : '');
      })));
      if (tm.substitutes && tm.substitutes.length) {
        wrap.appendChild(el('h4', { text: t('panel.confirmedSubs') }));
        wrap.appendChild(ul(tm.substitutes.map(function (p) {
          return (p.number != null ? p.number + '. ' : '') + p.name;
        })));
      }
      return wrap;
    }), { open: true }));

    // Mercato
    if (hasMercato(d)) {
      add('mercato', panel(t('panel.mercato'), twoCol(d, function (tm) {
        var wrap = el('div');
        wrap.appendChild(el('h4', { text: t('panel.mercatoIn') }));
        wrap.appendChild(ul((tm.mercatoIn || []).map(function (m) { return m.name + (has(m.from) ? ' ← ' + m.from : '') + (has(m.fee) ? ' (' + m.fee + ')' : ''); })));
        wrap.appendChild(el('h4', { text: t('panel.mercatoOut') }));
        wrap.appendChild(ul((tm.mercatoOut || []).map(function (m) { return m.name + (has(m.to) ? ' → ' + m.to : '') + (has(m.fee) ? ' (' + m.fee + ')' : ''); })));
        return wrap;
      })));
    }

    // Pre-season
    if ((d.teams.home.preseason || []).length || (d.teams.away.preseason || []).length) {
      add('preseason', panel(t('panel.preseason'), twoCol(d, function (tm) {
        return ul((tm.preseason || []).map(function (p) { return (has(p.date) ? p.date + ' · ' : '') + p.opp + ' ' + p.score; }));
      })));
    }

    // News — curated news[] from the editorial pass, plus raw RSS
    // newsCandidates[] (shown as links, flagged as un-triaged). The prefetch
    // keeps refreshing newsCandidates daily in the 3 days before kickoff even
    // after news[] is set, since those headlines are newer than whatever the
    // editorial pass saw when it ran — so both render together when present.
    var anyNews = ['home', 'away'].some(function (s) {
      return (d.teams[s].news || []).length || (d.teams[s].newsCandidates || []).length;
    });
    if (anyNews) {
      add('news', panel(t('panel.news'), twoCol(d, function (tm) {
        var parts = [];
        if ((tm.news || []).length) {
          parts.push(ul(tm.news.map(function (n) { return (has(n.date) ? '[' + n.date + '] ' : '') + n.text; })));
        }
        var cands = tm.newsCandidates || [];
        if (cands.length) {
          var list = el('ul', { class: 'news-cand' });
          cands.forEach(function (n) {
            list.appendChild(el('li', {}, [
              el('a', { href: n.url || '#', target: '_blank', rel: 'noopener noreferrer', text: n.title }),
              (n.source || n.published)
                ? el('span', { class: 'nc-meta', text: '  ' + [n.published, n.source].filter(Boolean).join(' · ') })
                : null
            ]));
          });
          parts.push(list);
          parts.push(el('p', { class: 'nc-note', text: (tm.news || []).length
            ? t('panel.newsRawEditorial')
            : t('panel.newsRaw') }));
        }
        if (!parts.length) return el('div', { text: t('common.na') });
        var wrap = el('div');
        parts.forEach(function (p) { wrap.appendChild(p); });
        return wrap;
      })));
    }

    // Venue
    if (d.venue && has(d.venue.name)) {
      var v = el('div', { class: 'kv' });
      v.appendChild(el('span', { html: '<b>' + t('panel.venue') + '</b>' + esc(d.venue.name) }));
      if (has(d.venue.city)) v.appendChild(el('span', { html: '<b>' + t('panel.city') + '</b>' + esc(d.venue.city) }));
      if (has(d.venue.capacity)) v.appendChild(el('span', { html: '<b>' + t('panel.capacity') + '</b>' + esc(d.venue.capacity) }));
      if (d.venue.weather) {
        var w = d.venue.weather;
        var wbits = [];
        if (w.tempC != null) wbits.push(Math.round(w.tempC) + '°C');
        if (has(w.condition)) wbits.push(w.condition);
        if (w.windKph != null) wbits.push(t('panel.windKph', { v: Math.round(w.windKph) }));
        if (w.precipitationMm != null && w.precipitationMm > 0) wbits.push(t('panel.precip', { v: w.precipitationMm }));
        if (wbits.length) v.appendChild(el('span', { html: '<b>' + t('panel.weatherAtKickoff') + '</b>' + esc(wbits.join(', ')) }));
      }
      var vb = el('div', {}, [v]);
      if (has(d.venue.notes)) vb.appendChild(el('p', { text: d.venue.notes }));
      if (d.venue.stories && d.venue.stories.length) {
        vb.appendChild(el('h4', { class: 'stat-h', text: t('panel.curiosities') }));
        vb.appendChild(ul(d.venue.stories));
      }
      add('venue', panel(t('panel.venue'), vb));
    }

    // Squads
    ['home', 'away'].forEach(function (side) {
      var tm = d.teams[side];
      var sq = effSquad(d, side);
      if (!sq.length) return;
      var groups = { GK: [], DEF: [], MID: [], ATT: [] };
      sq.forEach(function (p) { (groups[p.role] || groups.MID).push(p); });
      var wrap = el('div');
      ['GK', 'DEF', 'MID', 'ATT'].forEach(function (g) {
        if (!groups[g].length) return;
        wrap.appendChild(el('h4', { text: t('posGroup.' + g) }));
        var list = el('ul');
        groups[g].forEach(function (p) {
          var sl = statLine(p);
          var li = el('li', {}, [
            p.photo ? el('img', { class: 'li-photo', src: p.photo, alt: '' }) : null,
            el('a', { href: '#', onclick: function (e) { e.preventDefault(); openPlayer(d, side, p); },
              text: (p.number != null ? p.number + '. ' : '') + p.name +
                (has(p.age) || has(p.nat)
                  ? ' (' + [has(p.age) ? t('player.ageValue', { n: p.age }) : null, p.nat].filter(Boolean).join(', ') + ')' : '') +
                (sl ? ' · ' + sl : '') +
                (p.status && p.status !== 'available' ? ' · ' + statusLabel(p.status) : '') })
          ]);
          list.appendChild(li);
        });
        wrap.appendChild(list);
      });
      add('squad-' + side, panel(t('panel.squad', { team: tm.name }), wrap));
    });

    // (per-team custom info lives in the pitch-side rail — see teamAside)

    // sources
    if (d.sources && d.sources.length) {
      add('sources', panel(t('panel.sources'), ul(d.sources.map(function (s) {
        return s.name + (has(s.url) ? ' — ' + s.url : '') + (has(s.accessed) ? ' (' + s.accessed + ')' : '');
      }))));
    }

    // match events log (goals & cards added on players) — only when non-empty
    var evLog = collectEvents(d);
    if (evLog.length) {
      var evBody = el('div');
      evLog.forEach(function (row) {
        evBody.appendChild(el('div', { class: 'ev-row' }, [
          el('span', { text: (row.minute != null ? row.minute + "'  " : "—  ") + evMeta(row.type).icon + (row.type === 'owngoal' ? t('panel.ownGoalSuffix') : '') + '  ' + row.playerName + '  (' + row.teamName + ')' }),
          el('button', { text: '✕', title: t('common.delete'), onclick: row.onDel || function () { delEvent(row.side, row.player, row.id); rerenderPanels(d); rerenderPitch(d); } })
        ]));
      });
      add('events', panel(t('panel.matchEvents'), evBody, { open: true }));
    }

    // match-level notes
    add('notes', panel(t('panel.notesMatch'), notesBlock('match', t('export.matchGeneral')), { lead: true, open: true }));

    // apply the user's saved order (unknown keys keep their natural spot at the end)
    var saved = (store.panelOrder || []).filter(function (k) {
      return defs.some(function (dd) { return dd.key === k; });
    });
    defs.sort(function (a, b) {
      var ia = saved.indexOf(a.key), ib = saved.indexOf(b.key);
      if (ia < 0) ia = 1e6; if (ib < 0) ib = 1e6;
      return ia - ib;
    });

    var box = el('div', { class: 'panels' });
    defs.forEach(function (def) {
      makePanelDraggable(def.node, def.key, d, defs);
      addPanelWiden(def.node, def.key, d);
      addPanelExtras(def.node, def.key, d);
      box.appendChild(def.node);
    });
    return box;
  }

  // Reusable "add your own lines" box, stored in store.panelExtra[key]. Used both
  // at the bottom of a whole panel (addPanelExtras) and per team column (the
  // "Informații echipă" panel).
  function extrasBox(key, placeholder) {
    var box = el('div', { class: 'panel-extra' });
    function redraw() {
      box.innerHTML = '';
      var list = (store.panelExtra && store.panelExtra[key]) || [];
      list.forEach(function (it) {
        box.appendChild(el('div', { class: 'px-row' }, [
          el('span', { text: it.text }),
          el('button', { text: '✕', title: t('common.delete'), onclick: function () {
            store.panelExtra[key] = (store.panelExtra[key] || []).filter(function (x) { return x.id !== it.id; });
            if (!store.panelExtra[key].length) delete store.panelExtra[key];
            if (store.panelExtra && !Object.keys(store.panelExtra).length) delete store.panelExtra;
            save(); redraw();
          } })
        ]));
      });
      var inp = el('input', { class: 'field px-in', placeholder: placeholder || t('extras.placeholder') });
      function add() {
        var v = inp.value.trim();
        if (!v) return;
        store.panelExtra = store.panelExtra || {};
        (store.panelExtra[key] = store.panelExtra[key] || []).push({
          id: Date.now() + '' + Math.random().toString(36).slice(2, 5), text: v, ts: Date.now()
        });
        save();
        redraw();
      }
      inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') add(); });
      box.appendChild(el('div', { class: 'px-add' }, [inp, el('button', { class: 'pick', text: t('common.add'), onclick: add })]));
    }
    redraw();
    return box;
  }

  // Lets the user append their own lines to any existing panel/category. Stored
  // per panel key in store.panelExtra[key]; rendered at the bottom of the body.
  function addPanelExtras(node, key, d) {
    if (key === 'notes' || key === 'teaminfo') return;   // those have their own inputs
    var body = node.querySelector('.body');
    if (body) body.appendChild(extrasBox(key));
  }

  // Per-panel "widen" toggle: makes the panel span the full width of the grid,
  // so a cramped two-column panel (e.g. Formă) gets room. Persisted per key.
  // A few panels default to wide (their content doesn't fit a single grid
  // column at all -- the advanced-stats player table has 13 columns) unless
  // the user has explicitly toggled them, in which case that choice sticks.
  var DEFAULT_WIDE_PANELS = { advancedStats: true };
  function isPanelWide(key) {
    var pref = store.panelWide && store.panelWide[key];
    return pref !== undefined ? !!pref : !!DEFAULT_WIDE_PANELS[key];
  }
  function addPanelWiden(node, key, d) {
    if (node.classList.contains('lead')) return;   // already full-width
    var wide = isPanelWide(key);
    if (wide) node.classList.add('wide');
    var sum = node.querySelector('summary');
    if (!sum) return;
    var btn = el('span', {
      class: 'pwiden', role: 'button', tabindex: '0',
      title: wide ? t('widen.collapse') : t('widen.expand'),
      text: wide ? '⤡' : '⤢'
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      store.panelWide = store.panelWide || {};
      store.panelWide[key] = !isPanelWide(key);
      save();
      rerenderPanels(d);
    });
    var grip = sum.querySelector('.pgrip');
    sum.insertBefore(btn, grip ? grip.nextSibling : sum.firstChild);
  }

  /* ---------- drag panels to reorder ---------- */
  var panelsEl = null;
  var _pdrag = null;
  function rerenderPanels(d) {
    var next = panels(d);
    if (panelsEl) panelsEl.replaceWith(next);
    panelsEl = next;
  }
  function makePanelDraggable(node, key, d, defs) {
    var grip = el('span', { class: 'pgrip', text: '⠿', title: 'Trage pentru a reordona' });
    grip.setAttribute('draggable', 'true');
    grip.addEventListener('click', function (e) { e.preventDefault(); e.stopPropagation(); });
    grip.addEventListener('dragstart', function (e) {
      _pdrag = key;
      node.classList.add('pdragging');
      try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', key); } catch (err) {}
    });
    grip.addEventListener('dragend', function () {
      _pdrag = null;
      var pd = document.querySelectorAll('.panel');
      [].forEach.call(pd, function (x) { x.classList.remove('pdragging', 'drop-before', 'drop-after'); });
    });
    node.addEventListener('dragover', function (e) {
      if (_pdrag == null || _pdrag === key) return;
      e.preventDefault();
      try { e.dataTransfer.dropEffect = 'move'; } catch (err) {}
      var r = node.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      node.classList.toggle('drop-after', after);
      node.classList.toggle('drop-before', !after);
    });
    node.addEventListener('dragleave', function () {
      node.classList.remove('drop-before', 'drop-after');
    });
    node.addEventListener('drop', function (e) {
      if (_pdrag == null || _pdrag === key) return;
      e.preventDefault();
      var r = node.getBoundingClientRect();
      var after = e.clientY > r.top + r.height / 2;
      var order = defs.map(function (x) { return x.key; });
      var src = _pdrag;
      order = order.filter(function (k) { return k !== src; });
      var ti = order.indexOf(key);
      order.splice(after ? ti + 1 : ti, 0, src);
      store.panelOrder = order;
      save();
      rerenderPanels(d);
    });
    var sum = node.querySelector('summary');
    if (sum) sum.insertBefore(grip, sum.firstChild);
  }

  function twoCol(d, fn) {
    return el('div', { class: 'two-col' }, [
      el('div', {}, [el('h4', { text: d.teams.home.name }), fn(d.teams.home, 'home')]),
      el('div', {}, [el('h4', { text: d.teams.away.name }), fn(d.teams.away, 'away')])
    ]);
  }
  function hasMercato(d) {
    return ['home', 'away'].some(function (s) {
      var t = d.teams[s]; return (t.mercatoIn || []).length || (t.mercatoOut || []).length;
    });
  }

  /* ---------- modals ---------- */
  function modal(headNode, tabs) {
    var back = el('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    var body = el('div', { class: 'modal-body' });
    var tabBar = el('div', { class: 'modal-tabs' });
    var names = Object.keys(tabs);
    function show(name) {
      body.innerHTML = ''; body.appendChild(tabs[name](close));
      [].forEach.call(tabBar.children, function (b) { b.classList.toggle('active', b.textContent === name); });
    }
    names.forEach(function (name) { tabBar.appendChild(el('button', { text: name, onclick: function () { show(name); } })); });

    var m = el('div', { class: 'modal' }, [headNode(close), tabBar, body]);
    back.appendChild(m);
    document.body.appendChild(back);
    show(names[0]);
  }

  // Details for one past H2H / form-guide fixture: the two starting XIs,
  // the formation each side played, its referee, and its goals/cards/subs.
  // All from API-Football (see scripts/prefetch-preview.mjs's
  // getFixtureDetails and the `formation` / `lineups` / `referee` / `events`
  // fields on h2h.recent[] / teams.<side>.form.recent[] in
  // docs/data/schema.json), filled in once when that fixture first enters
  // either list — older fixtures built before this existed just have none of
  // that, in which case the caller doesn't make the row clickable at all.
  // sideA/sideB: { key, label, formation, lineup }, where `key` matches the
  // `side` tag on each event ('home'/'away' for H2H, 'us'/'opp' for a form
  // guide) and `lineup` is an array of { name, number, pos } (or falsy).
  function openMatchHistory(titleText, metaText, refereeName, sideA, sideB, events) {
    var back = el('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    var body = el('div', { class: 'modal-body' });
    if (sideA.formation || sideB.formation) {
      body.appendChild(el('div', { class: 'kv' }, [
        el('span', {}, [el('b', { text: sideA.label + ':' }), document.createTextNode(' ' + (sideA.formation || t('common.na')))]),
        el('span', {}, [el('b', { text: sideB.label + ':' }), document.createTextNode(' ' + (sideB.formation || t('common.na')))])
      ]));
    }
    if (has(refereeName)) {
      body.appendChild(el('div', { class: 'kv' }, [
        el('span', {}, [el('b', { text: t('pitch.referee') + ':' }), document.createTextNode(' ' + refereeName)])
      ]));
    }
    function lineupCol(side) {
      if (!side.lineup || !side.lineup.length) return el('div');
      return el('div', {}, [
        el('h4', { text: side.label }),
        el('ul', {}, side.lineup.map(function (p) {
          return el('li', { text: (p.number != null ? p.number + '. ' : '') + p.name + (has(p.pos) ? '  ' + p.pos : '') });
        }))
      ]);
    }
    if ((sideA.lineup && sideA.lineup.length) || (sideB.lineup && sideB.lineup.length)) {
      body.appendChild(el('div', { class: 'two-col' }, [lineupCol(sideA), lineupCol(sideB)]));
    }
    var list = el('div', { class: 'ev-list' });
    var sorted = (events || []).slice().sort(function (x, y) {
      return (x.minute == null ? 999 : x.minute) - (y.minute == null ? 999 : y.minute);
    });
    if (!sorted.length) {
      list.appendChild(el('p', { class: 'ev-empty', text: t('events.none') }));
    } else {
      sorted.forEach(function (e) {
        var meta = evMeta(e.type);
        var teamLabel = e.side === sideA.key ? sideA.label : sideB.label;
        var text = e.type === 'sub'
          ? (e.minute != null ? e.minute + "'  " : '') + meta.icon + '  ' + (e.playerOut || '?') + ' → ' + (e.playerIn || '?') + '  (' + teamLabel + ')'
          : (e.minute != null ? e.minute + "'  " : '') + meta.icon +
            (e.type === 'owngoal' ? t('panel.ownGoalSuffix') : '') + '  ' + e.player + '  (' + teamLabel + ')';
        list.appendChild(el('div', { class: 'ev-row' }, [el('span', { text: text })]));
      });
    }
    body.appendChild(list);

    var m = el('div', { class: 'modal', style: 'max-width:560px' }, [
      el('div', { class: 'modal-head' }, [
        el('div', {}, [el('h3', { text: titleText }), el('div', { class: 'sub', text: metaText })]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]),
      body
    ]);
    back.appendChild(m);
    document.body.appendChild(back);
  }

  function openPlayer(d, side, p) {
    var id = 'player:' + side + ':' + (p.number != null ? p.number : p.name);
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        avatarEl(p.photo, initials(p.name), side === 'home' ? 'var(--home)' : 'var(--away)'),
        el('div', {}, [
          el('h3', { text: (p.number != null ? '#' + p.number + '  ' : '') + p.name + (isCaptain(side, p) ? '  (C)' : '') }),
          el('div', { class: 'sub', text: [pos(p), has(p.age) ? t('player.ageValue', { n: p.age }) : null, has(p.height) ? t('player.heightValue', { n: p.height }) : null, has(p.weight) ? t('player.weightValue', { n: p.weight }) : null, footLabel(p.foot)].filter(Boolean).join('  ·  ') }),
          el('div', { class: 'sub', text: [natLabel(p), d.teams[side].name].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      [t('player.tabProfile')]: function () {
        var wrap = el('div');
        var body = el('div');
        // shirt number — editable, for when it's missing or has changed;
        // display name — editable, in case something else is preferred;
        // plus a captain toggle
        var nameIn = el('input', { class: 'field pname-in', type: 'text',
          placeholder: p._name0 !== undefined ? p._name0 : p.name, value: p.name });
        var nameSave = el('button', { class: 'pick pnum-save', text: t('common.save'), onclick: function () {
          setPlayerName(d, side, p, nameIn.value);
        } });
        var nameReset = (p._name0 !== undefined && p._name0 !== p.name)
          ? el('button', { class: 'pick pname-reset', text: '↺', title: t('player.resetResearchedName', { name: p._name0 }),
              onclick: function () { setPlayerName(d, side, p, ''); } })
          : null;
        var numIn = el('input', { class: 'field pnum-in', type: 'number', min: '1', max: '99',
          placeholder: '—', value: p.number != null ? p.number : '' });
        var numSave = el('button', { class: 'pick pnum-save', text: t('common.save'), onclick: function () {
          var v = numIn.value.trim();
          setPlayerNumber(d, side, p, v === '' ? null : parseInt(v, 10));
        } });
        var capOn = isCaptain(side, p);
        var capBtn = el('button', {
          class: 'cap-toggle' + (capOn ? ' on' : ''),
          text: capOn ? t('player.captainOn') : t('player.captainOff'),
          onclick: function () { setCaptain(d, side, p); }
        });
        wrap.appendChild(el('div', { class: 'pcard-edit' }, [
          el('label', { text: t('player.displayName') }),
          el('div', { class: 'pnum-row' }, [nameIn, nameSave, nameReset]),
          el('label', { text: t('player.number') }),
          el('div', { class: 'pnum-row' }, [numIn, numSave]),
          capBtn
        ]));
        wrap.appendChild(body);
        function fill() {
          body.innerHTML = '';
          var kv = el('div', { class: 'kv' });
          if (has(p.pronunciation)) kv.appendChild(el('span', { html: '<b>' + t('player.pronunciation') + '</b>' + esc(p.pronunciation) }));
          if (has(p.nat)) kv.appendChild(el('span', { html: '<b>' + t('player.citizenship') + '</b>' + esc(p.nat) }));
          if (has(p.natTeam)) kv.appendChild(el('span', { html: '<b>' + t('player.national') + '</b>' + esc(p.natTeam) }));
          if (has(p.birthCountry)) kv.appendChild(el('span', { html: '<b>' + t('player.bornIn') + '</b>' + esc(p.birthCountry) }));
          if (has(p.age)) kv.appendChild(el('span', { html: '<b>' + t('player.age') + '</b>' + esc(t('player.ageValue', { n: p.age })) }));
          if (has(p.height)) kv.appendChild(el('span', { html: '<b>' + t('player.height') + '</b>' + esc(t('player.heightValue', { n: p.height })) }));
          if (footLabel(p.foot)) kv.appendChild(el('span', { html: '<b>' + t('player.foot') + '</b>' + esc(footLabel(p.foot)) }));
          if (kv.childNodes.length) body.appendChild(kv);
          var posBadge = positionsBadge(p);
          if (posBadge) body.appendChild(posBadge);
          var s = p.stats || {};
          var rows = (p.role === 'GK' ? [
            [t('player.statMatches'), s.apps], [t('player.statMinutes'), s.minutes], [t('player.statGoalsConceded'), s.conceded],
            [t('player.statSaves'), s.saves], [t('player.statYellow'), s.yellow], [t('player.statRed'), s.red],
            [t('player.statRating'), s.rating]
          ] : [
            [t('player.statMatches'), s.apps], [t('player.statMinutes'), s.minutes], [t('player.statGoals'), s.goals],
            [t('player.statAssists'), s.assists], [t('player.statYellow'), s.yellow], [t('player.statRed'), s.red],
            [t('player.statRating'), s.rating]
          ]).filter(function (r) { return r[1] != null; });
          if (rows.length) {
            body.appendChild(el('h4', { class: 'stat-h', text: t('player.currentSeason') }));
            var g = el('div', { class: 'stat-grid' });
            rows.forEach(function (r) {
              g.appendChild(el('div', { class: 'stat-cell' }, [
                el('span', { class: 'sc-n', text: String(r[1]) }),
                el('span', { class: 'sc-l', text: r[0] })
              ]));
            });
            body.appendChild(g);
          }
          if (has(p.lastSeason)) body.appendChild(el('p', { html: '<b style="color:var(--color-neutral-500)">' + t('player.lastSeason') + '</b> ' + esc(p.lastSeason) }));
        }
        fill();
        return wrap;
      },
      [t('player.tabCareer')]: function () {
        return el('div', {}, [el('p', { text: has(p.career) ? p.career : t('player.careerUnavailable') })]);
      },
      [t('player.tabFunfact')]: function () {
        var wrap = el('div');
        wrap.appendChild(el('p', { text: has(p.funfact) ? p.funfact : '—' }));
        if (has(p.linkLine)) wrap.appendChild(el('p', { html: '<b style="color:var(--color-neutral-500)">' + t('player.linkLine') + '</b> ' + esc(p.linkLine) }));
        return wrap;
      },
      [t('player.tabStatus')]: function () {
        return el('div', {}, [el('p', { text: statusLabel(p.status || 'available') + (has(p.statusNote) ? ' — ' + p.statusNote : '') })]);
      },
      [t('player.tabSub')]: function (close) { return subTab(d, side, p, close); },
      [t('player.tabEvents')]: function () { return eventsTab(d, side, p); },
      [t('player.tabNotes')]: function () { return notesBlock(id, p.name); }
    });
  }

  // Record goals and yellow/red cards for a player (with optional minute).
  // Updates the pitch badges live.
  function eventsTab(d, side, p) {
    var wrap = el('div', { class: 'ev-tab' });
    var minIn = el('input', { class: 'field ev-min', type: 'number', min: '1', max: '120', placeholder: t('events.minutePlaceholder') });
    var list = el('div', { class: 'ev-list' });
    function redraw() {
      list.innerHTML = '';
      var evs = eventsFor(side, p).slice().sort(function (a, b) {
        return (a.minute == null ? 999 : a.minute) - (b.minute == null ? 999 : b.minute);
      });
      if (!evs.length) { list.appendChild(el('p', { class: 'ev-empty', text: t('events.none') })); return; }
      evs.forEach(function (e) {
        list.appendChild(el('div', { class: 'ev-row' }, [
          el('span', { text: (e.minute != null ? e.minute + "'  " : '') + evMeta(e.type).icon + ' ' + evMeta(e.type).label }),
          el('button', { text: '✕', title: t('common.delete'), onclick: function () { delEvent(side, p, e.id); redraw(); rerenderPitch(d); rerenderPanels(d); } })
        ]));
      });
    }
    var btns = el('div', { class: 'ev-btns' }, ['goal', 'owngoal', 'yellow', 'red'].map(function (type) {
      return el('button', {
        class: 'ev-add ' + type, text: evMeta(type).icon + ' ' + evMeta(type).label,
        onclick: function () { addEvent(side, p, type, minIn.value); minIn.value = ''; redraw(); rerenderPitch(d); rerenderPanels(d); }
      });
    }));
    wrap.appendChild(minIn);
    wrap.appendChild(btns);
    wrap.appendChild(list);
    redraw();
    return wrap;
  }

  // The "Schimbă" tab: send this player on/off the pitch. Works both from an
  // on-pitch player (pick a replacement from the bench) and from a bench player
  // opened via the squad panel (pick which starter they replace).
  function subTab(d, side, p, close) {
    var wrap = el('div', { class: 'sub-tab' });
    var eff = effXI(d, side);
    var pred = d.teams[side].predictedXI || [];
    var squad = effSquad(d, side);
    var slotIdx = -1;
    eff.forEach(function (s, i) { if (slotIdx < 0 && sameP(s, p)) slotIdx = i; });

    function line(pl, onClick) {
      return el('button', {
        class: 'pick' + (pl.status && pl.status !== 'available' ? ' warn' : ''),
        onclick: onClick,
        text: (pl.number != null ? '#' + pl.number + '  ' : '') + pl.name +
          (has(pl.pos) ? '  ·  ' + pl.pos : has(pl.role) ? '  ·  ' + pl.role : '') +
          (pl.status && pl.status !== 'available' ? '  ·  ' + statusLabel(pl.status) : '')
      });
    }

    // type of change: correcting the announced XI, or an in-match substitution
    var kindSel = 'xi';
    var minIn = el('input', { class: 'field sub-min', type: 'number', min: '1', max: '120', placeholder: t('sub.minutePlaceholder') });
    var minRow = el('div', { class: 'sub-min-row' }, [minIn]);
    var kindToggle = el('div', { class: 'sub-kind-toggle' });
    function setKind(k) {
      kindSel = k;
      [].forEach.call(kindToggle.children, function (b) { b.classList.toggle('active', b.getAttribute('data-k') === k); });
      minRow.hidden = (k !== 'sub');
    }
    [['xi', t('sub.optionLineup')], ['sub', t('sub.optionInMatch')]].forEach(function (pair) {
      kindToggle.appendChild(el('button', { 'data-k': pair[0], text: pair[1], onclick: function () { setKind(pair[0]); } }));
    });
    function doSub(idx, player) {
      applySub(d, side, idx, player, kindSel === 'sub' ? minIn.value : null, kindSel);
      close();
    }

    if (slotIdx >= 0) {
      var origName = pred[slotIdx] ? pred[slotIdx].name : null;
      var swapped = !!(store.xi && store.xi[side] && store.xi[side][slotIdx]);
      wrap.appendChild(el('p', { class: 'sub-head', text: t('sub.whoComesOn', { name: p.name }) }));
      wrap.appendChild(kindToggle);
      wrap.appendChild(minRow);
      if (swapped && origName) {
        wrap.appendChild(line({ name: t('sub.revertTo', { name: origName }) },
          function () { clearSub(d, side, slotIdx); close(); }));
      }
      var onKeys = eff.map(keyOf);
      var bench = squad.filter(function (x) { return onKeys.indexOf(keyOf(x)) < 0; });
      groupPick(bench).forEach(function (grp) {
        wrap.appendChild(el('h4', { text: grp.label }));
        grp.items.forEach(function (b) {
          wrap.appendChild(line(b, function () { doSub(slotIdx, b); }));
        });
      });
      if (!bench.length) wrap.appendChild(el('p', { text: t('sub.noBench') }));
    } else {
      wrap.appendChild(el('p', { class: 'sub-head', text: t('sub.whoReplaces', { name: p.name }) }));
      wrap.appendChild(kindToggle);
      wrap.appendChild(minRow);
      eff.forEach(function (s, i) {
        if (!has(s.name)) return; // empty slot — fill it directly via the pitch, not from here
        var full = playerByNameOrNum(squad, s);
        wrap.appendChild(line(full, function () { doSub(i, p); }));
      });
    }
    wrap.appendChild(el('p', { class: 'sub-note', text: t('sub.hint') }));
    setKind('xi');
    return wrap;
  }

  function groupPick(list) {
    var g = { GK: [], DEF: [], MID: [], ATT: [] };
    list.forEach(function (p) { (g[p.role] || g.MID).push(p); });
    return ['GK', 'DEF', 'MID', 'ATT'].filter(function (k) { return g[k].length; })
      .map(function (k) { return { label: t('posGroup.' + k), items: g[k] }; });
  }

  // Fill an empty pitch slot by hand: creates the player (added to the manual
  // squad, so they also show up in the squad panel and as a future substitute)
  // and places them straight into that slot.
  function openAddPlayer(d, side, idx) {
    var back = el('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);

    // players available to drop into this slot: the full squad minus whoever is
    // already on the pitch (so the live-loaded lot feeds the XI directly)
    var onKeys = effXI(d, side).map(keyOf);
    var avail = effSquad(d, side).filter(function (x) { return onKeys.indexOf(keyOf(x)) < 0; });

    var searchIn = el('input', { class: 'field', type: 'search', placeholder: t('benchPicker.search') });
    var pickList = el('div', { class: 'pick-list' });
    function drawPicks() {
      var q = searchIn.value.trim().toLowerCase();
      pickList.innerHTML = '';
      var rows = avail.filter(function (p) { return !q || String(p.name).toLowerCase().indexOf(q) >= 0; });
      groupPick(rows).forEach(function (grp) {
        pickList.appendChild(el('h4', { text: grp.label }));
        grp.items.forEach(function (p) {
          pickList.appendChild(el('button', {
            class: 'pick',
            onclick: function () { applySub(d, side, idx, p); close(); },
            text: (p.number != null ? '#' + p.number + '  ' : '') + p.name +
              (has(p.pos) ? '  ·  ' + p.pos : has(p.role) ? '  ·  ' + p.role : '') +
              (has(p.age) ? '  ·  ' + t('player.ageValue', { n: p.age }) : '') +
              (p.stats && (p.stats.goals || p.stats.assists) ? '  ·  ' + (p.stats.goals || 0) + 'G/' + (p.stats.assists || 0) + 'A' : '') +
              (p.status && p.status !== 'available' ? '  ·  ' + statusLabel(p.status) : '')
          }));
        });
      });
      if (!rows.length) pickList.appendChild(el('p', { class: 'sub-note', text: avail.length ? t('benchPicker.noMatch') : t('benchPicker.noSquadYet') }));
    }
    searchIn.addEventListener('input', drawPicks);

    var numIn = el('input', { class: 'field', type: 'number', min: '1', max: '99', placeholder: t('benchPicker.numberPlaceholder') });
    var nameIn = el('input', { class: 'field', placeholder: t('benchPicker.namePlaceholder') });
    var roleSel = el('select', { class: 'field' }, ['GK', 'DEF', 'MID', 'ATT'].map(function (r) {
      return el('option', { value: r, text: t('posShort.' + r) });
    }));
    var posIn = el('input', { class: 'field', placeholder: t('benchPicker.posPlaceholder') });
    function submit() {
      var name = nameIn.value.trim();
      if (!name) { nameIn.focus(); return; }
      var player = {
        number: numIn.value ? parseInt(numIn.value, 10) : null,
        name: name, role: roleSel.value, pos: posIn.value.trim() || null, status: 'available'
      };
      addManualPlayer(side, player);
      applySub(d, side, idx, player);
      close();
    }
    nameIn.addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    var manual = el('details', { class: 'add-manual' }, [
      el('summary', { text: t('benchPicker.addManually') }),
      el('div', {}, [
        numIn, nameIn, roleSel, posIn,
        el('div', { class: 'notes-row' }, [el('button', { class: 'pick', text: t('benchPicker.addToPitch'), onclick: submit })])
      ])
    ]);
    var m = el('div', { class: 'modal', style: 'max-width:380px' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: t('benchPicker.pickForSlot') }),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]),
      el('div', { class: 'modal-body' }, [
        avail.length ? searchIn : null,
        pickList,
        manual
      ])
    ]);
    back.appendChild(m);
    document.body.appendChild(back);
    drawPicks();
    if (avail.length) searchIn.focus(); else { manual.open = true; nameIn.focus(); }
  }

  // Small "fill in by hand" forms for the fields the live feed doesn't cover
  // (coach, referee, venue). Each saves to store.manual and re-renders.
  function quickForm(title, fields, onSave) {
    var back = el('div', { class: 'modal-back', onclick: function (e) { if (e.target === back) close(); } });
    function close() { back.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    var inputs = fields.map(function (f) {
      return el('input', { class: 'field', type: f.type || 'text', placeholder: f.label });
    });
    function submit() {
      var vals = inputs.map(function (inp) { return inp.value.trim(); });
      if (!vals[0]) { inputs[0].focus(); return; }
      onSave(vals);
      close();
    }
    inputs[0].addEventListener('keydown', function (e) { if (e.key === 'Enter') submit(); });
    back.appendChild(el('div', { class: 'modal', style: 'max-width:320px' }, [
      el('div', { class: 'modal-head' }, [el('h3', { text: title }), el('button', { class: 'modal-close', text: '✕', onclick: close })]),
      el('div', { class: 'modal-body' }, inputs.concat([
        el('div', { class: 'notes-row' }, [el('button', { class: 'pick', text: t('common.save'), onclick: submit })])
      ]))
    ]));
    document.body.appendChild(back);
    inputs[0].focus();
  }
  function openEditCoach(d, side) {
    quickForm(t('quickAdd.coachTitle', { team: d.teams[side].name }),
      [{ label: t('quickAdd.coachName') }, { label: t('quickAdd.country') }, { label: t('quickAdd.age'), type: 'number' }],
      function (v) {
        store.manual = store.manual || {}; store.manual.coach = store.manual.coach || {};
        store.manual.coach[side] = { name: v[0], country: v[1] || null, age: v[2] ? parseInt(v[2], 10) : null, tenureFrom: null, career: [] };
        save(); render(d);
      });
  }
  function openEditReferee(d) {
    quickForm(t('quickAdd.refereeTitle'),
      [{ label: t('quickAdd.refereeName') }, { label: t('quickAdd.country') }],
      function (v) {
        store.manual = store.manual || {};
        store.manual.referee = { name: v[0], country: v[1] || null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null };
        save(); render(d);
      });
  }
  function openEditVenue(d) {
    quickForm(t('quickAdd.venueTitle'),
      [{ label: t('quickAdd.venueName') }, { label: t('quickAdd.city') }, { label: t('quickAdd.capacity'), type: 'number' }],
      function (v) {
        store.manual = store.manual || {};
        store.manual.venue = { name: v[0], city: v[1] || null, capacity: v[2] ? parseInt(v[2], 10) : null, notes: null };
        save(); render(d);
      });
  }

  function openCoach(d, side) {
    var c = d.teams[side].coach, id = 'coach:' + side;
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        avatarEl(c.photo, initials(c.name), side === 'home' ? 'var(--home)' : 'var(--away)'),
        el('div', {}, [
          el('h3', { text: c.name }),
          el('div', { class: 'sub', text: [t('coach.notesLabel', { team: d.teams[side].name }), has(c.country) ? c.country : null, has(c.age) ? t('player.ageValue', { n: c.age }) : null, has(c.tenureFrom) ? t('coach.tenureFromPrefix', { date: c.tenureFrom }) : null].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      [t('coach.tabCareer')]: function () {
        if (!c.career || !c.career.length) return el('p', { text: t('common.na') });
        var tbl = el('table', { class: 'mc' }, [el('tr', {}, [el('th', { text: t('coach.club') }), el('th', { text: t('coach.period') }), el('th', { text: t('coach.note') })])]);
        c.career.forEach(function (r) { tbl.appendChild(el('tr', {}, [el('td', { text: r.club }), el('td', { text: r.period }), el('td', { text: has(r.note) ? r.note : '—' })])); });
        return tbl;
      },
      [t('coach.tabTrophies')]: function () {
        if (!c.trophies || !c.trophies.length) return el('p', { text: t('common.na') });
        var tbl = el('table', { class: 'mc' }, [el('tr', {}, [el('th', { text: t('coach.competition') }), el('th', { text: t('coach.season') }), el('th', { text: t('coach.result') })])]);
        c.trophies.forEach(function (r) {
          tbl.appendChild(el('tr', {}, [
            el('td', { text: has(r.country) ? r.competition + ' (' + r.country + ')' : r.competition }),
            el('td', { text: has(r.season) ? r.season : '—' }),
            el('td', { text: r.place })
          ]));
        });
        return tbl;
      },
      [t('coach.tabNotes')]: function () { return notesBlock(id, t('coach.notesLabel', { team: d.teams[side].name })); }
    });
  }

  function openRef(d) {
    var r = d.referee, id = 'ref:main';
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        el('div', { class: 'avatar', style: 'background:#555', text: initials(r.name) }),
        el('div', {}, [
          el('h3', { text: r.name }),
          el('div', { class: 'sub', text: [t('pitch.referee'), has(r.country) ? r.country : null, has(r.age) ? t('player.ageValue', { n: r.age }) : null].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      [t('referee.tabProfile')]: function () {
        var kv = el('div', { class: 'kv' });
        if (has(r.apps)) kv.appendChild(el('span', { html: '<b>' + t('referee.apps') + '</b>' + esc(r.apps) }));
        if (has(r.ycPerMatch)) kv.appendChild(el('span', { html: '<b>' + t('referee.ycPerMatchLabel') + '</b>' + esc(r.ycPerMatch) }));
        if (has(r.rcPerMatch)) kv.appendChild(el('span', { html: '<b>' + t('referee.rcPerMatch') + '</b>' + esc(r.rcPerMatch) }));
        var wrap = el('div', {}, [kv]);
        if (has(r.history)) wrap.appendChild(el('p', { text: r.history }));
        return wrap;
      },
      [t('referee.tabNotes')]: function () { return notesBlock(id, t('referee.notesLabel')); }
    });
  }

  function pos(p) { return has(p.pos) ? p.pos : t('posShort.' + p.role) || ''; }
  function positionLabel(v) {
    var code = String(v || '').toUpperCase();
    if (['GK', 'DEF', 'MID', 'ATT'].indexOf(code) >= 0) return t('posShort.' + code);
    var key = 'posFull.' + code;
    var found = t(key);
    return found === key ? (v || t('common.na')) : found;
  }
  // Read-only: every position API-Football has reported for this player across
  // competitions (scripts/prefetch-preview.mjs positionsFrom). Not user-editable —
  // the point is to show what the data actually says, not to collect opinions.
  function positionsBadge(p) {
    var seen = {};
    var list = (p.positions || []).filter(function (v) {
      var u = String(v || '').trim().toUpperCase();
      if (!u || seen[u]) return false;
      seen[u] = true; return true;
    });
    if (list.length < 2) return null;
    var wrap = el('div', { class: 'position-card' });
    wrap.appendChild(el('h4', { class: 'stat-h', text: t('player.positionsApiTitle') }));
    var chips = el('div', { class: 'pos-chips' });
    list.forEach(function (v, i) {
      chips.appendChild(el('span', { class: 'pos-chip' + (i === 0 ? ' main' : ''), text: positionLabel(v) }));
    });
    wrap.appendChild(chips);
    return wrap;
  }
  function footLabel(f) { return f ? t('foot.' + f) : null; }
  function statusLabel(s) { return s ? t('status.' + s) : null; }
  function natLabel(p) {
    var a = [];
    if (has(p.nat)) a.push(p.nat);
    if (has(p.natTeam) && p.natTeam !== p.nat) a.push('(' + p.natTeam + ')');
    return a.join(' ');
  }
})();
