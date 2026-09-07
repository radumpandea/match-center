/* Match Center — render of docs/data/matches/<slug>.json when it exists;
   otherwise a skeleton built from docs/data/fixtures.json, best-effort filled
   from a client-side call to the live football feed, with the rest fillable
   by hand. Vanilla JS, no build step. */
(function () {
  'use strict';

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var root = $('#root');

  var params = new URLSearchParams(location.search);
  var slug = (params.get('m') || '').trim();
  if (!slug) { fail('Lipsește parametrul ?m=<slug>. Deschide un meci din <a href="index.html">listă</a>.'); return; }

  Promise.all([
    fetch('data/fixtures.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : []; }).catch(function () { return []; }),
    fetch('data/matches/' + encodeURIComponent(slug) + '.json', { cache: 'no-cache' })
      .then(function (r) { return r.ok ? r.json() : null; }).catch(function () { return null; })
  ]).then(function (results) {
    var fixtures = results[0] || [];
    var prep = results[1];
    var fixture = fixtures.filter(function (f) { return f.slug === slug; })[0];
    if (!prep && !fixture) {
      fail('Nu găsesc meciul <code>' + esc(slug) + '</code> — nici date pregătite, nici în fixtures.<br>Înapoi la <a href="index.html">listă</a>.');
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
            el('button', { text: '✕', title: 'Șterge', onclick: function () { delNote(id, n.id); redraw(); } })
          ])
        ]));
      });
    }
    var ta = el('textarea', { placeholder: 'Notiță — ' + (label || id) + '… (o linie pe rând; „- " = punct, „-- " sau indentare = subpunct)' });
    function commit() { addNote(id, ta.value, curKind); ta.value = ''; redraw(); ta.focus(); }
    var kindBtns = ['text', 'bullet', 'sub'].map(function (k) {
      return el('button', {
        class: 'note-kind' + (k === curKind ? ' on' : ''),
        title: { text: 'Text', bullet: 'Punct', sub: 'Subpunct' }[k],
        text: { text: '¶', bullet: '•', sub: '–' }[k],
        onclick: function () {
          curKind = k;
          [].forEach.call(kindRow.children, function (b, i) { b.classList.toggle('on', ['text', 'bullet', 'sub'][i] === k); });
          ta.focus();
        }
      });
    });
    var kindRow = el('span', { class: 'note-kinds' }, kindBtns);
    var addBtn = el('button', { text: 'Adaugă', onclick: commit });
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
    var lines = ['# Notițe — ' + data.teams.home.name + ' vs ' + data.teams.away.name,
      '', '_' + (data.competition.name || '') + ' · ' + (data.competition.round || '') + ' · exportat ' + new Date().toLocaleString('ro-RO') + '_', ''];
    var n = store.notes || {};
    function nameOf(id) {
      var p = id.split(':');
      if (p[0] === 'match') return 'General meci';
      if (p[0] === 'team') return data.teams[p[1]] ? data.teams[p[1]].name : p[1];
      if (p[0] === 'player') {
        var t = data.teams[p[1]]; var pl = t && effSquad(data, p[1]).filter(function (x) { return String(x.number) === p[2] || x.name === p[2]; })[0];
        return (pl ? pl.name : p[2]) + ' (' + (t ? t.name : p[1]) + ')';
      }
      if (p[0] === 'coach') return 'Antrenor ' + (data.teams[p[1]] ? data.teams[p[1]].name : p[1]);
      if (p[0] === 'ref') return 'Arbitru';
      return id;
    }
    Object.keys(n).forEach(function (id) {
      if (!n[id] || !n[id].length) return;
      lines.push('## ' + nameOf(id));
      n[id].forEach(function (note) {
        var ind = note.kind === 'sub' ? '  ' : '';
        lines.push(ind + '- ' + note.text + '  \n  ' + ind + '_' + new Date(note.ts).toLocaleString('ro-RO') + '_');
      });
      lines.push('');
    });
    var px = store.panelExtra || {};
    var pxKeys = Object.keys(px).filter(function (k) { return px[k] && px[k].length; });
    if (pxKeys.length) {
      lines.push('## Informații adăugate');
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
  function applyDiscColors(d) {
    document.documentElement.style.setProperty('--home', resolveDisc(d, 'home'));
    document.documentElement.style.setProperty('--away', resolveDisc(d, 'away'));
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
  var EV_META = {
    goal: { icon: '⚽', label: 'Gol' },
    owngoal: { icon: '⚽', label: 'Autogol' },
    yellow: { icon: '🟨', label: 'Cartonaș galben' },
    red: { icon: '🟥', label: 'Cartonaș roșu' },
    sub: { icon: '🔄', label: 'Schimbare' }
  };
  function evKey(side, p) { return side + ':' + (p && p.number != null ? p.number : (p && p.name)); }
  function eventsFor(side, p) { return (store.events && store.events[evKey(side, p)]) || []; }
  function addEvent(side, p, type, minute) {
    if (!EV_META[type]) return;
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
    applyDiscColors(data);
    document.title = data.teams.home.name + ' – ' + data.teams.away.name + ' · Match Center';
    root.innerHTML = '';
    pitchEl = null;
    panelsEl = null;

    var orientBtn = el('button', {
      text: view.orientation === 'v' ? '⤢ Vedere orizontală' : '⤢ Vedere verticală',
      onclick: function () {
        view.orientation = view.orientation === 'v' ? 'h' : 'v';
        orientBtn.textContent = view.orientation === 'v' ? '⤢ Vedere orizontală' : '⤢ Vedere verticală';
        saveView();
        rerenderPitch(data);
      }
    });
    var swapBtn = el('button', {
      text: '⇄ Schimbă părțile',
      onclick: function () { view.swapped = !view.swapped; saveView(); rerenderPitch(data); }
    });
    var resetPosBtn = el('button', {
      text: '↺ Resetează pozițiile',
      onclick: function () {
        if (store.lineup) { delete store.lineup; save(); rerenderPitch(data); }
      }
    });
    var namesBtn = el('button', {
      text: view.fullNames ? '🔤 Nume scurte' : '🔤 Nume complete',
      onclick: function () {
        view.fullNames = !view.fullNames;
        namesBtn.textContent = view.fullNames ? '🔤 Nume scurte' : '🔤 Nume complete';
        saveView();
        rerenderPitch(data);
      }
    });
    var SIZE_LABELS = ['M', 'L', 'XL'];
    var fontBtn = el('button', {
      text: '🔠 Text jucători: ' + SIZE_LABELS[view.labelSize],
      onclick: function () {
        view.labelSize = (view.labelSize + 1) % 3;
        fontBtn.textContent = '🔠 Text jucători: ' + SIZE_LABELS[view.labelSize];
        saveView();
        rerenderPitch(data);
      }
    });
    var resetOrderBtn = el('button', {
      text: '↕ Aspect implicit panouri',
      title: 'Resetează ordinea și lățimea panourilor',
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
        title: 'Culoarea bulinelor — ' + data.teams[side].name,
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
      text: '↺ Culori', title: 'Culori implicite pentru buline',
      onclick: function () {
        if (store.discColors) { delete store.discColors; save(); render(data); }
      }
    });
    var favBtn = el('button', {
      text: (window.MC_COLLAB && window.MC_COLLAB.isFavourite(slug)) ? '★ Favorit' : '☆ Favorit',
      title: 'Păstrează acest meci în lista ta de favorite',
      onclick: async function () {
        if (!window.MC_COLLAB) return;
        try {
          var yes = await window.MC_COLLAB.toggleFavourite(slug);
          favBtn.textContent = yes ? '★ Favorit' : '☆ Favorit';
        } catch (e) { openCollaboration(data); }
      }
    });
    var collabBtn = el('button', {
      text: (window.MC_COLLAB && window.MC_COLLAB.status().online) ? '👥 Conectat: ' + (window.MC_COLLAB.status().name || 'utilizator') : '👥 Conectează-te',
      title: 'Conectare, sincronizare și modificările echipei',
      onclick: function () { openCollaboration(data); }
    });

    // header
    var metaWrap = el('div', { class: 'mc-meta' }, [document.createTextNode(metaLine(data))]);
    if (!has(data.venue && data.venue.name)) {
      metaWrap.appendChild(el('button', { class: 'meta-add', text: '+ adaugă stadion', onclick: function () { openEditVenue(data); } }));
    }
    var head = el('div', { class: 'mc-head' }, [
      el('a', { class: 'mc-back', href: 'index.html', text: '← toate meciurile' }),
      el('div', { class: 'mc-teams' }, [
        el('span', { text: data.teams.home.name }),
        el('span', { class: 'vs', text: 'vs' }),
        el('span', { text: data.teams.away.name })
      ]),
      metaWrap,
      (data._skeleton || data._partial) ? skeletonBanner(data) : null,
      el('div', { class: 'mc-toolbar' }, [
        swapBtn,
        orientBtn,
        namesBtn,
        fontBtn,
        discSwatch('home'),
        discSwatch('away'),
        discReset,
        favBtn,
        collabBtn,
        resetPosBtn,
        resetOrderBtn,
        el('button', { text: '🖨 Print', onclick: function () { window.print(); } }),
        el('button', { text: '⭳ Export notițe', onclick: function () { exportNotes(data); } }),
        el('button', { text: '⇕ Extinde / restrânge', onclick: toggleAll }),
        el('button', { text: '🗑 Șterge notițele acestui meci', onclick: function () {
          if (confirm('Ștergi toate notițele pentru acest meci?')) { delete store.notes; save(); render(data); }
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
  }

  function openCollaboration(data) {
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        el('div', { class: 'avatar', text: '👥' }),
        el('div', {}, [el('h3', { text: 'Colaborare' }), el('div', { class: 'sub', text: 'Schimbările sunt salvate cu numele persoanei care le-a făcut.' })]),
        el('button', { class: 'modal-close', text: '×', onclick: close })
      ]);
    }, {
      'Profil': function () {
        var s = window.MC_COLLAB ? window.MC_COLLAB.status() : { configured: false };
        var field = el('input', { class: 'field', value: s.name || '', placeholder: 'Numele tău (ex. Radu)' });
        var msg = el('div', { class: 'ev-empty', text: s.configured ? (s.online ? 'Conectat. Datele tale se sincronizează între dispozitive.' : 'Conectează-te cu emailul pentru a-ți păstra datele și favoritele pe orice dispozitiv.') : 'Mod local activ. Pentru colaborare, completează configurația Supabase din app/config.js.' });
        var saveName = el('button', { class: 'pick', text: 'Salvează numele', onclick: async function () {
          if (!window.MC_COLLAB) return;
          await window.MC_COLLAB.setName(field.value); msg.textContent = 'Numele a fost salvat: ' + (window.MC_COLLAB.status().name || 'Utilizator') + '.';
        } });
        var email = el('input', { class: 'field', type: 'email', placeholder: 'emailul-tău@exemplu.ro' });
        var sendLink = el('button', { class: 'pick', text: 'Trimite link de conectare', onclick: async function () {
          try { var to = await window.MC_COLLAB.sendMagicLink(email.value); msg.textContent = 'Am trimis un link de conectare la ' + to + '. Deschide-l pe orice dispozitiv pentru a intra în același cont.'; } catch (e) { msg.textContent = e.message || 'Nu am putut trimite linkul.'; }
        } });
        var logout = el('button', { class: 'pick', text: 'Deconectează-mă', onclick: async function () { await window.MC_COLLAB.signOut(); close(); render(data); } });
        var auth = s.configured && !s.online
          ? el('div', {}, [el('p', { text: 'Introdu adresa ta; primești un link fără parolă. Folosește același email pe telefon, laptop sau orice alt dispozitiv.' }), email, el('div', { class: 'ev-btns' }, [sendLink])])
          : (s.online ? el('div', { class: 'ev-btns' }, [logout]) : null);
        return el('div', {}, [el('p', { text: 'Numele apare în jurnalul comun atunci când modifici primul 11, notițele, rezervele sau evenimentele.' }), field, el('div', { class: 'ev-btns' }, [saveName]), auth, msg]);
      },
      'Activitate': function () {
        var wrap = el('div', {}, [el('div', { class: 'ev-empty', text: 'Se încarcă activitatea…' })]);
        if (!window.MC_COLLAB || !window.MC_COLLAB.configured()) { wrap.firstChild.textContent = 'Activitatea comună devine disponibilă după configurarea Supabase.'; return wrap; }
        window.MC_COLLAB.changes(slug).then(function (items) {
          wrap.innerHTML = '';
          if (!items.length) { wrap.appendChild(el('div', { class: 'ev-empty', text: 'Încă nu există modificări comune pentru acest meci.' })); return; }
          items.forEach(function (item) { wrap.appendChild(el('div', { class: 'ev-row' }, [el('span', { text: item.display_name + ' — ' + item.summary }), el('time', { text: new Date(item.changed_at).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) })])); });
        });
        return wrap;
      }
    });
  }

  function skeletonBanner(d) {
    var haveSquads = (d.teams.home.squad || []).length && (d.teams.away.squad || []).length;
    var lead = d._partial
      ? '⚠ Date parțiale (preîncărcare automată din API-Football): loturi cu statistici, antrenor, formă, clasament, cap la cap, accidentări, arbitru și stadion. Primul 11 probabil, fire narative, funfacts și pronunție vin cu pachetul editorial complet.'
      : '⚠ Fără pachet de pregătire pentru acest meci încă.' +
        (haveSquads ? ' Loturile sunt încărcate — ' : ' ') +
        'completează manual restul.';
    var tail = haveSquads
      ? ' Click pe un slot gol de pe teren ca să alegi primul 11 din lot; „+ adaugă…” lângă antrenor / arbitru / stadion pentru rest.'
      : ' Click pe un slot gol de pe teren, sau pe „+ adaugă…” de lângă antrenor / arbitru / stadion.';
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
      bits.push(isNaN(dt) ? d.kickoff : dt.toLocaleString('ro-RO', { weekday: 'long', day: '2-digit', month: 'long', hour: '2-digit', minute: '2-digit' }));
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
      var t = d.teams[side];
      var isNear = side === nearKey;
      var xi = effXI(d, side);
      var pts = layout(t.formation);
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
          title: isEmpty ? 'Click pentru a adăuga un jucător aici' : 'Trage pentru a repoziționa · click pentru fișă, schimbări, goluri/cartonașe',
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
          el('div', { class: 'lbl', text: isEmpty ? 'Adaugă' : (view.fullNames ? (slot.name || '') : shortName(slot.name)) })
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
      if (t.coach && has(t.coach.name)) {
        shell.appendChild(el('div', { class: 'card-slot ' + coachCorner }, [
          el('div', { class: 'mini-card', onclick: function () { openCoach(d, side); } }, [
            el('div', { class: 'mc-role', text: 'Antrenor' }),
            el('div', { class: 'mc-name', text: t.coach.name }),
            el('div', { class: 'mc-line', text: [has(t.coach.country) ? t.coach.country : null, has(t.coach.age) ? t.coach.age + ' ani' : null, has(t.formation) ? t.formation : null].filter(Boolean).join(' · ') })
          ])
        ]));
      } else {
        shell.appendChild(el('div', { class: 'card-slot ' + coachCorner }, [
          el('div', { class: 'mini-card add-card', onclick: function () { openEditCoach(d, side); } }, [
            el('div', { class: 'mc-name', text: '+ Adaugă antrenor' })
          ])
        ]));
      }
    });

    // referee — on the halfway line
    if (d.referee && has(d.referee.name)) {
      shell.appendChild(el('div', { class: 'card-slot ref ' + (vert ? 'cr' : 'bc') }, [
        el('div', { class: 'mini-card', onclick: function () { openRef(d); } }, [
          el('div', { class: 'mc-role', text: 'Arbitru' }),
          el('div', { class: 'mc-name', text: d.referee.name }),
          el('div', { class: 'mc-line', text: [has(d.referee.country) ? d.referee.country : null, has(d.referee.ycPerMatch) ? d.referee.ycPerMatch + ' galbene/meci' : null].filter(Boolean).join(' · ') })
        ])
      ]));
    } else {
      shell.appendChild(el('div', { class: 'card-slot ref ' + (vert ? 'cr' : 'bc') }, [
        el('div', { class: 'mini-card add-card', onclick: function () { openEditReferee(d); } }, [
          el('div', { class: 'mc-name', text: '+ Adaugă arbitru' })
        ])
      ]));
    }

    return el('div', { class: 'pitch-wrap' }, [shell, benchStrip(d), subsStrip(d)]);
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
        el('span', { class: 'bench-label', text: (d.teams[side].shortName || d.teams[side].name) + ' · rezerve' }),
        el('button', { class: 'bench-add', title: 'Alege rezervele', text: explicit ? '✎' : '＋', onclick: function () { openBenchPicker(d, side); } })
      ]);
      if (explicit) {
        row.appendChild(el('button', { class: 'bench-add', title: 'Toate rezervele', text: '↺', onclick: function () { setBench(d, side, null); } }));
      }
      if (!players.length) {
        row.appendChild(el('span', { class: 'bench-empty', text: explicit ? 'nicio rezervă aleasă' : '—' }));
      }
      players.forEach(function (p) {
        var full = playerByNameOrNum(squad, p);
        var st = full && full.status;
        row.appendChild(el('button', {
          class: 'bench-chip' + (st && st !== 'available' ? ' status-' + st : '') + (isCaptain(side, p) ? ' is-captain' : ''),
          title: p.name + (isCaptain(side, p) ? ' · căpitan' : '') + (st && st !== 'available' ? ' · ' + st : '') + ' — click pentru fișă / schimbare',
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
          text: (p.number != null ? '#' + p.number + '  ' : '') + p.name + (p.status && p.status !== 'available' ? '  ·  ' + p.status : ''),
          onclick: function () { chosen[k] = !chosen[k]; b.classList.toggle('on', !!chosen[k]); }
        });
        list.appendChild(b);
      });
    });
    if (!cand.length) list.appendChild(el('p', { class: 'sub-note', text: 'Nu există jucători în afara primului 11.' }));

    back.appendChild(el('div', { class: 'modal', style: 'max-width:400px' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: 'Rezerve — ' + d.teams[side].name }),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]),
      el('div', { class: 'modal-body' }, [
        el('p', { class: 'sub-note', text: 'Bifează cine stă pe bancă. Toți bifați = bancă implicită (tot lotul din afara primului 11).' }),
        list,
        el('div', { class: 'notes-row' }, [
          el('button', { class: 'pick', text: 'Salvează', onclick: function () {
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
          el('span', { class: 'sub-kind', text: kind === 'sub' ? 'MECI' : 'PRIM 11' }),
          (kind === 'sub' && mm != null) ? el('span', { class: 'sub-min-badge', text: mm + "'" }) : null,
          el('span', { text: shortName(m.out.name) + '  ' + (kind === 'sub' ? '↦' : '⇄') + '  ' + shortName(m.inn.name) }),
          el('button', { text: '✕', title: 'Anulează', onclick: function () { clearSub(d, side, m.i); } })
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
    if (/friendl|amical/i.test(c)) return 'amical';
    return String(c).replace(/^(France|England|Spain|Italy|Germany|Romania|Europe|Elite Club)\s+/i, '');
  }
  // full league table; the two teams in this fixture are highlighted
  function standingsTable(d) {
    var s = d.standings || {};
    var rows = s.rows || [];
    if (!rows.length) return el('div', { text: 'n/d' });
    var mine = {};
    [d.teams.home, d.teams.away].forEach(function (t) { mine[teamKey(t.name)] = true; });
    var head = el('tr', {}, ['#', 'Echipă', 'M', 'V', 'E', 'Î', 'GM:GP', '+/-', 'P'].map(function (h) {
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
    var t = d.teams[side];
    var box = el('div', { class: 'team-aside ' + side }, [
      el('div', { class: 'team-aside-title', text: (t.shortName || t.name) + ' · informații echipă' })
    ]);
    (t.stories || []).forEach(function (s) {
      box.appendChild(el('div', { class: 'story-bar' }, [el('h4', { text: s.title }), ul(s.bullets)]));
    });
    box.appendChild(el('div', { class: 'ta-add-h', text: 'Notele tale' }));
    box.appendChild(extrasBox('teaminfo:' + side, '＋ informație despre ' + t.name));
    return box;
  }

  function panels(d) {
    var defs = [];
    function add(key, node) { if (node) defs.push({ key: key, node: node }); }

    if (d.storyOfTheMatch && d.storyOfTheMatch.length) {
      add('story', panel('Story of the match', ul(d.storyOfTheMatch), { lead: true, open: true }));
    }

    // H2H
    if (d.h2h && ((d.h2h.recent && d.h2h.recent.length) || has(d.h2h.summary))) {
      var h = el('div');
      if (d.h2h.recent && d.h2h.recent.length) {
        var tb = el('table', { class: 'mc' }, [
          el('tr', {}, [el('th', { text: 'Data' }), el('th', { text: 'Competiție' }), el('th', { text: 'Scor' })])
        ]);
        d.h2h.recent.forEach(function (r) {
          tb.appendChild(el('tr', {}, [el('td', { text: r.date }), el('td', { text: has(r.comp) ? r.comp : '—' }), el('td', { text: r.score })]));
        });
        h.appendChild(tb);
      }
      if (has(d.h2h.summary)) h.appendChild(el('p', { text: d.h2h.summary }));
      add('h2h', panel('Cap la cap', h, { open: true }));
    }

    // Form (two-col) — OneFootball-style: W/D/L badges, a standings row, a
    // form guide (last matches with scores), plus PPG / home-away split.
    if (d.teams.home.form || d.teams.away.form) {
      add('form', panel('Formă', twoCol(d, function (t) {
        var wrap = el('div');
        var f = t.form || {};
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
          if (has(f.position)) bits.push('Loc ' + f.position);
          if (has(tbl.played)) bits.push(tbl.played + ' M');
          if (has(tbl.win)) bits.push(tbl.win + '-' + (tbl.draw || 0) + '-' + (tbl.loss || 0));
          if (has(tbl.gf)) bits.push(tbl.gf + '-' + tbl.ga);
          if (has(tbl.points)) bits.push(tbl.points + 'p');
          wrap.appendChild(el('div', { class: 'form-table', text: bits.join('  ·  ') }));
        }
        if (f.recent && f.recent.length) {
          var list = el('ul', { class: 'form-guide' });
          f.recent.forEach(function (r) {
            list.appendChild(el('li', {}, [
              el('span', { class: 'fg-res fb-' + (r.result || 'D'), text: r.result || '–' }),
              el('span', { class: 'fg-score', text: has(r.score) ? r.score : '' }),
              el('span', { class: 'fg-opp', text: (r.homeAway === 'A' ? 'la ' : r.homeAway === 'H' ? 'cu ' : '') + (has(r.opp) ? r.opp : '') }),
              el('span', { class: 'fg-meta', text: [fgDate(r.date), fgComp(r.comp)].filter(has).join(' · ') })
            ]));
          });
          wrap.appendChild(list);
        }
        if (has(f.ppg)) wrap.appendChild(el('div', { text: 'PPG: ' + f.ppg }));
        if (has(f.homeAway)) wrap.appendChild(el('div', { class: 'form-note', text: f.homeAway }));
        if (has(f.note)) wrap.appendChild(el('div', { class: 'form-note', text: f.note }));
        if (f.next && f.next.length) {
          wrap.appendChild(el('div', { class: 'form-next-h', text: 'Următoarele' }));
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
        if (!wrap.childNodes.length) wrap.appendChild(el('div', { text: 'n/d' }));
        return wrap;
      })));
    }

    // League table
    if (d.standings && d.standings.rows && d.standings.rows.length) {
      add('standings', panel('Clasament' + (has(d.standings.league) ? ' · ' + d.standings.league : ''), standingsTable(d)));
    }

    // Absences + probable XI
    add('absences', panel('Absențe și primul 11 probabil', twoCol(d, function (t) {
      var wrap = el('div');
      wrap.appendChild(el('h4', { text: 'Absenți' }));
      if (t.absences && t.absences.length) {
        wrap.appendChild(ul(t.absences.map(function (a) {
          return a.name + ' — ' + a.reason + (has(a.detail) ? ' (' + a.detail + ')' : '');
        })));
      } else { wrap.appendChild(el('div', { text: 'niciun absent semnalat' })); }
      wrap.appendChild(el('h4', { text: 'Primul 11 (' + (has(t.formation) ? t.formation : 'n/d') + ')' }));
      wrap.appendChild(ul((t.predictedXI || []).map(function (p) {
        return (p.number != null ? p.number + '. ' : '') + p.name + (has(p.pos) ? '  ' + p.pos : '');
      })));
      return wrap;
    }), { open: true }));

    // Mercato
    if (hasMercato(d)) {
      add('mercato', panel('Mercato — vară', twoCol(d, function (t) {
        var wrap = el('div');
        wrap.appendChild(el('h4', { text: 'Veniri' }));
        wrap.appendChild(ul((t.mercatoIn || []).map(function (m) { return m.name + (has(m.from) ? ' ← ' + m.from : '') + (has(m.fee) ? ' (' + m.fee + ')' : ''); })));
        wrap.appendChild(el('h4', { text: 'Plecări' }));
        wrap.appendChild(ul((t.mercatoOut || []).map(function (m) { return m.name + (has(m.to) ? ' → ' + m.to : '') + (has(m.fee) ? ' (' + m.fee + ')' : ''); })));
        return wrap;
      })));
    }

    // Pre-season
    if ((d.teams.home.preseason || []).length || (d.teams.away.preseason || []).length) {
      add('preseason', panel('Pregătirea de vară', twoCol(d, function (t) {
        return ul((t.preseason || []).map(function (p) { return (has(p.date) ? p.date + ' · ' : '') + p.opp + ' ' + p.score; }));
      })));
    }

    // News — curated news[] when present, otherwise the raw RSS newsCandidates[]
    // that the prefetch drops in (shown as links, flagged as un-triaged)
    var anyNews = ['home', 'away'].some(function (s) {
      return (d.teams[s].news || []).length || (d.teams[s].newsCandidates || []).length;
    });
    if (anyNews) {
      add('news', panel('Top știri', twoCol(d, function (t) {
        if ((t.news || []).length) {
          return ul(t.news.map(function (n) { return (has(n.date) ? '[' + n.date + '] ' : '') + n.text; }));
        }
        var cands = t.newsCandidates || [];
        if (!cands.length) return el('div', { text: 'n/d' });
        var wrap = el('div');
        var list = el('ul', { class: 'news-cand' });
        cands.forEach(function (n) {
          list.appendChild(el('li', {}, [
            el('a', { href: n.url || '#', target: '_blank', rel: 'noopener noreferrer', text: n.title }),
            (n.source || n.published)
              ? el('span', { class: 'nc-meta', text: '  ' + [n.published, n.source].filter(Boolean).join(' · ') })
              : null
          ]));
        });
        wrap.appendChild(list);
        wrap.appendChild(el('p', { class: 'nc-note', text: 'Titluri brute din RSS — încă netriate.' }));
        return wrap;
      })));
    }

    // Venue
    if (d.venue && has(d.venue.name)) {
      var v = el('div', { class: 'kv' });
      v.appendChild(el('span', { html: '<b>Stadion</b>' + esc(d.venue.name) }));
      if (has(d.venue.city)) v.appendChild(el('span', { html: '<b>Oraș</b>' + esc(d.venue.city) }));
      if (has(d.venue.capacity)) v.appendChild(el('span', { html: '<b>Capacitate</b>' + esc(d.venue.capacity) }));
      var vb = el('div', {}, [v]);
      if (has(d.venue.notes)) vb.appendChild(el('p', { text: d.venue.notes }));
      add('venue', panel('Stadion', vb));
    }

    // Squads
    ['home', 'away'].forEach(function (side) {
      var t = d.teams[side];
      var sq = effSquad(d, side);
      if (!sq.length) return;
      var groups = { GK: [], DEF: [], MID: [], ATT: [] };
      sq.forEach(function (p) { (groups[p.role] || groups.MID).push(p); });
      var wrap = el('div');
      ['GK', 'DEF', 'MID', 'ATT'].forEach(function (g) {
        if (!groups[g].length) return;
        wrap.appendChild(el('h4', { text: ({ GK: 'Portari', DEF: 'Fundași', MID: 'Mijlocași', ATT: 'Atacanți' })[g] }));
        var list = el('ul');
        groups[g].forEach(function (p) {
          var li = el('li', {}, [
            el('a', { href: '#', onclick: function (e) { e.preventDefault(); openPlayer(d, side, p); },
              text: (p.number != null ? p.number + '. ' : '') + p.name +
                (has(p.age) ? ' · ' + p.age + ' ani' : '') + (has(p.nat) ? ' · ' + p.nat : '') +
                (p.stats && (p.stats.goals || p.stats.assists)
                  ? ' · ' + (p.stats.goals || 0) + 'G/' + (p.stats.assists || 0) + 'A' : '') +
                (p.status && p.status !== 'available' ? ' · ' + p.status : '') })
          ]);
          list.appendChild(li);
        });
        wrap.appendChild(list);
      });
      add('squad-' + side, panel('Lot — ' + t.name, wrap));
    });

    // (per-team custom info lives in the pitch-side rail — see teamAside)

    // sources
    if (d.sources && d.sources.length) {
      add('sources', panel('Surse', ul(d.sources.map(function (s) {
        return s.name + (has(s.url) ? ' — ' + s.url : '') + (has(s.accessed) ? ' (' + s.accessed + ')' : '');
      }))));
    }

    // match events log (goals & cards added on players) — only when non-empty
    var evLog = collectEvents(d);
    if (evLog.length) {
      var evBody = el('div');
      evLog.forEach(function (row) {
        evBody.appendChild(el('div', { class: 'ev-row' }, [
          el('span', { text: (row.minute != null ? row.minute + "'  " : "—  ") + EV_META[row.type].icon + (row.type === 'owngoal' ? ' (autogol)' : '') + '  ' + row.playerName + '  (' + row.teamName + ')' }),
          el('button', { text: '✕', title: 'Șterge', onclick: row.onDel || function () { delEvent(row.side, row.player, row.id); rerenderPanels(d); rerenderPitch(d); } })
        ]));
      });
      add('events', panel('Evenimente meci', evBody, { open: true }));
    }

    // match-level notes
    add('notes', panel('Notițe — general meci', notesBlock('match', 'general meci'), { lead: true, open: true }));

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
          el('button', { text: '✕', title: 'Șterge', onclick: function () {
            store.panelExtra[key] = (store.panelExtra[key] || []).filter(function (x) { return x.id !== it.id; });
            if (!store.panelExtra[key].length) delete store.panelExtra[key];
            if (store.panelExtra && !Object.keys(store.panelExtra).length) delete store.panelExtra;
            save(); redraw();
          } })
        ]));
      });
      var inp = el('input', { class: 'field px-in', placeholder: placeholder || '＋ adaugă o informație aici' });
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
      box.appendChild(el('div', { class: 'px-add' }, [inp, el('button', { class: 'pick', text: 'Adaugă', onclick: add })]));
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
  function addPanelWiden(node, key, d) {
    if (node.classList.contains('lead')) return;   // already full-width
    var wide = !!(store.panelWide && store.panelWide[key]);
    if (wide) node.classList.add('wide');
    var sum = node.querySelector('summary');
    if (!sum) return;
    var btn = el('span', {
      class: 'pwiden', role: 'button', tabindex: '0',
      title: wide ? 'Restrânge caseta' : 'Extinde caseta pe toată lățimea',
      text: wide ? '⤡' : '⤢'
    });
    btn.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      store.panelWide = store.panelWide || {};
      if (store.panelWide[key]) delete store.panelWide[key]; else store.panelWide[key] = true;
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

  function openPlayer(d, side, p) {
    var id = 'player:' + side + ':' + (p.number != null ? p.number : p.name);
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        el('div', { class: 'avatar', style: 'background:' + (side === 'home' ? 'var(--home)' : 'var(--away)'), text: initials(p.name) }),
        el('div', {}, [
          el('h3', { text: (p.number != null ? '#' + p.number + '  ' : '') + p.name + (isCaptain(side, p) ? '  (C)' : '') }),
          el('div', { class: 'sub', text: [pos(p), has(p.age) ? p.age + ' ani' : null, has(p.height) ? p.height + ' cm' : null, has(p.weight) ? p.weight + ' kg' : null, footLabel(p.foot)].filter(Boolean).join('  ·  ') }),
          el('div', { class: 'sub', text: [natLabel(p), d.teams[side].name].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      'Profil': function () {
        var wrap = el('div');
        var body = el('div');
        // shirt number — editable, for when it's missing or has changed;
        // plus a captain toggle
        var numIn = el('input', { class: 'field pnum-in', type: 'number', min: '1', max: '99',
          placeholder: '—', value: p.number != null ? p.number : '' });
        var numSave = el('button', { class: 'pick pnum-save', text: 'Salvează', onclick: function () {
          var v = numIn.value.trim();
          setPlayerNumber(d, side, p, v === '' ? null : parseInt(v, 10));
        } });
        var capOn = isCaptain(side, p);
        var capBtn = el('button', {
          class: 'cap-toggle' + (capOn ? ' on' : ''),
          text: capOn ? '★ Căpitan' : '☆ Fă căpitan',
          onclick: function () { setCaptain(d, side, p); }
        });
        wrap.appendChild(el('div', { class: 'pcard-edit' }, [
          el('label', { text: 'Număr' }),
          el('div', { class: 'pnum-row' }, [numIn, numSave]),
          capBtn
        ]));
        wrap.appendChild(body);
        function fill() {
          body.innerHTML = '';
          var kv = el('div', { class: 'kv' });
          if (has(p.pronunciation)) kv.appendChild(el('span', { html: '<b>Pronunție</b>' + esc(p.pronunciation) }));
          if (has(p.nat)) kv.appendChild(el('span', { html: '<b>Cetățenie</b>' + esc(p.nat) }));
          if (has(p.natTeam)) kv.appendChild(el('span', { html: '<b>Națională</b>' + esc(p.natTeam) }));
          if (has(p.birthCountry)) kv.appendChild(el('span', { html: '<b>Născut în</b>' + esc(p.birthCountry) }));
          if (has(p.age)) kv.appendChild(el('span', { html: '<b>Vârstă</b>' + esc(p.age + ' ani') }));
          if (has(p.height)) kv.appendChild(el('span', { html: '<b>Înălțime</b>' + esc(p.height + ' cm') }));
          if (footLabel(p.foot)) kv.appendChild(el('span', { html: '<b>Picior</b>' + esc(footLabel(p.foot)) }));
          if (kv.childNodes.length) body.appendChild(kv);
          var s = p.stats || {};
          var rows = [
            ['Meciuri', s.apps], ['Minute', s.minutes], ['Goluri', s.goals],
            ['Pase decisive', s.assists], ['Galbene', s.yellow], ['Roșii', s.red],
            ['Rating', s.rating]
          ].filter(function (r) { return r[1] != null; });
          if (rows.length) {
            body.appendChild(el('h4', { class: 'stat-h', text: 'Sezonul curent' }));
            var g = el('div', { class: 'stat-grid' });
            rows.forEach(function (r) {
              g.appendChild(el('div', { class: 'stat-cell' }, [
                el('span', { class: 'sc-n', text: String(r[1]) }),
                el('span', { class: 'sc-l', text: r[0] })
              ]));
            });
            body.appendChild(g);
          }
          if (has(p.lastSeason)) body.appendChild(el('p', { html: '<b style="color:var(--color-neutral-500)">Sezonul trecut:</b> ' + esc(p.lastSeason) }));
        }
        fill();
        return wrap;
      },
      'Carieră': function () { return el('div', {}, [el('p', { text: has(p.career) ? p.career : 'n/d' })]); },
      'Funfact': function () {
        var wrap = el('div');
        wrap.appendChild(el('p', { text: has(p.funfact) ? p.funfact : '—' }));
        if (has(p.linkLine)) wrap.appendChild(el('p', { html: '<b style="color:var(--color-neutral-500)">Legătură directă:</b> ' + esc(p.linkLine) }));
        return wrap;
      },
      'Status': function () {
        return el('div', {}, [el('p', { text: (p.status || 'available') + (has(p.statusNote) ? ' — ' + p.statusNote : '') })]);
      },
      'Schimbă': function (close) { return subTab(d, side, p, close); },
      'Goluri / cartonașe': function () { return eventsTab(d, side, p); },
      'Notițe': function () { return notesBlock(id, p.name); }
    });
  }

  // Record goals and yellow/red cards for a player (with optional minute).
  // Updates the pitch badges live.
  function eventsTab(d, side, p) {
    var wrap = el('div', { class: 'ev-tab' });
    var minIn = el('input', { class: 'field ev-min', type: 'number', min: '1', max: '120', placeholder: 'Minut (opțional)' });
    var list = el('div', { class: 'ev-list' });
    function redraw() {
      list.innerHTML = '';
      var evs = eventsFor(side, p).slice().sort(function (a, b) {
        return (a.minute == null ? 999 : a.minute) - (b.minute == null ? 999 : b.minute);
      });
      if (!evs.length) { list.appendChild(el('p', { class: 'ev-empty', text: 'Niciun eveniment.' })); return; }
      evs.forEach(function (e) {
        list.appendChild(el('div', { class: 'ev-row' }, [
          el('span', { text: (e.minute != null ? e.minute + "'  " : '') + EV_META[e.type].icon + ' ' + EV_META[e.type].label }),
          el('button', { text: '✕', title: 'Șterge', onclick: function () { delEvent(side, p, e.id); redraw(); rerenderPitch(d); rerenderPanels(d); } })
        ]));
      });
    }
    var btns = el('div', { class: 'ev-btns' }, ['goal', 'owngoal', 'yellow', 'red'].map(function (type) {
      return el('button', {
        class: 'ev-add ' + type, text: EV_META[type].icon + ' ' + EV_META[type].label,
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
          (pl.status && pl.status !== 'available' ? '  ·  ' + pl.status : '')
      });
    }

    // type of change: correcting the announced XI, or an in-match substitution
    var kindSel = 'xi';
    var minIn = el('input', { class: 'field sub-min', type: 'number', min: '1', max: '120', placeholder: "Minut" });
    var minRow = el('div', { class: 'sub-min-row' }, [minIn]);
    var kindToggle = el('div', { class: 'sub-kind-toggle' });
    function setKind(k) {
      kindSel = k;
      [].forEach.call(kindToggle.children, function (b) { b.classList.toggle('active', b.getAttribute('data-k') === k); });
      minRow.hidden = (k !== 'sub');
    }
    [['xi', 'Corectură primul 11'], ['sub', 'Schimbare în meci']].forEach(function (pair) {
      kindToggle.appendChild(el('button', { 'data-k': pair[0], text: pair[1], onclick: function () { setKind(pair[0]); } }));
    });
    function doSub(idx, player) {
      applySub(d, side, idx, player, kindSel === 'sub' ? minIn.value : null, kindSel);
      close();
    }

    if (slotIdx >= 0) {
      var origName = pred[slotIdx] ? pred[slotIdx].name : null;
      var swapped = !!(store.xi && store.xi[side] && store.xi[side][slotIdx]);
      wrap.appendChild(el('p', { class: 'sub-head', text: 'Îl scoate pe ' + p.name + '. Cine intră?' }));
      wrap.appendChild(kindToggle);
      wrap.appendChild(minRow);
      if (swapped && origName) {
        wrap.appendChild(line({ name: '↩ Revino la ' + origName + ' (din predicție)' },
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
      if (!bench.length) wrap.appendChild(el('p', { text: 'Nu există jucători de rezervă în date.' }));
    } else {
      wrap.appendChild(el('p', { class: 'sub-head', text: p.name + ' e pe bancă. Pe cine înlocuiește?' }));
      wrap.appendChild(kindToggle);
      wrap.appendChild(minRow);
      eff.forEach(function (s, i) {
        if (!has(s.name)) return; // empty slot — fill it directly via the pitch, not from here
        var full = playerByNameOrNum(squad, s);
        wrap.appendChild(line(full, function () { doSub(i, p); }));
      });
    }
    wrap.appendChild(el('p', { class: 'sub-note', text: '„Corectură primul 11" = alinierea anunțată era greșită. „Schimbare în meci" = schimbare la minutul indicat, apare în jurnalul meciului. Se salvează local.' }));
    setKind('xi');
    return wrap;
  }

  function groupPick(list) {
    var g = { GK: [], DEF: [], MID: [], ATT: [] };
    list.forEach(function (p) { (g[p.role] || g.MID).push(p); });
    var labels = { GK: 'Portari', DEF: 'Fundași', MID: 'Mijlocași', ATT: 'Atacanți' };
    return ['GK', 'DEF', 'MID', 'ATT'].filter(function (k) { return g[k].length; })
      .map(function (k) { return { label: labels[k], items: g[k] }; });
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

    var searchIn = el('input', { class: 'field', type: 'search', placeholder: 'Caută în lot…' });
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
              (has(p.age) ? '  ·  ' + p.age + ' ani' : '') +
              (p.stats && (p.stats.goals || p.stats.assists) ? '  ·  ' + (p.stats.goals || 0) + 'G/' + (p.stats.assists || 0) + 'A' : '') +
              (p.status && p.status !== 'available' ? '  ·  ' + p.status : '')
          }));
        });
      });
      if (!rows.length) pickList.appendChild(el('p', { class: 'sub-note', text: avail.length ? 'Nimeni nu se potrivește căutării.' : 'Lotul nu e încărcat încă — adaugă jucătorul manual mai jos.' }));
    }
    searchIn.addEventListener('input', drawPicks);

    var numIn = el('input', { class: 'field', type: 'number', min: '1', max: '99', placeholder: 'Număr (opțional)' });
    var nameIn = el('input', { class: 'field', placeholder: 'Nume jucător' });
    var roleSel = el('select', { class: 'field' }, ['GK', 'DEF', 'MID', 'ATT'].map(function (r) {
      return el('option', { value: r, text: ({ GK: 'Portar', DEF: 'Fundaș', MID: 'Mijlocaș', ATT: 'Atacant' })[r] });
    }));
    var posIn = el('input', { class: 'field', placeholder: 'Poziție (ex. CB, CAM) — opțional' });
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
      el('summary', { text: 'Adaugă manual un jucător nou' }),
      el('div', {}, [
        numIn, nameIn, roleSel, posIn,
        el('div', { class: 'notes-row' }, [el('button', { class: 'pick', text: 'Adaugă pe teren', onclick: submit })])
      ])
    ]);
    var m = el('div', { class: 'modal', style: 'max-width:380px' }, [
      el('div', { class: 'modal-head' }, [
        el('h3', { text: 'Alege jucătorul pentru acest post' }),
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
        el('div', { class: 'notes-row' }, [el('button', { class: 'pick', text: 'Salvează', onclick: submit })])
      ]))
    ]));
    document.body.appendChild(back);
    inputs[0].focus();
  }
  function openEditCoach(d, side) {
    quickForm('Adaugă antrenor — ' + d.teams[side].name,
      [{ label: 'Nume antrenor' }, { label: 'Țară (opțional)' }, { label: 'Vârstă (opțional)', type: 'number' }],
      function (v) {
        store.manual = store.manual || {}; store.manual.coach = store.manual.coach || {};
        store.manual.coach[side] = { name: v[0], country: v[1] || null, age: v[2] ? parseInt(v[2], 10) : null, tenureFrom: null, career: [] };
        save(); render(d);
      });
  }
  function openEditReferee(d) {
    quickForm('Adaugă arbitru',
      [{ label: 'Nume arbitru' }, { label: 'Țară (opțional)' }],
      function (v) {
        store.manual = store.manual || {};
        store.manual.referee = { name: v[0], country: v[1] || null, age: null, apps: null, ycPerMatch: null, rcPerMatch: null, history: null };
        save(); render(d);
      });
  }
  function openEditVenue(d) {
    quickForm('Adaugă stadion',
      [{ label: 'Nume stadion' }, { label: 'Oraș (opțional)' }, { label: 'Capacitate (opțional)', type: 'number' }],
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
        el('div', { class: 'avatar', style: 'background:' + (side === 'home' ? 'var(--home)' : 'var(--away)'), text: initials(c.name) }),
        el('div', {}, [
          el('h3', { text: c.name }),
          el('div', { class: 'sub', text: ['Antrenor · ' + d.teams[side].name, has(c.country) ? c.country : null, has(c.age) ? c.age + ' ani' : null, has(c.tenureFrom) ? 'din ' + c.tenureFrom : null].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      'Carieră': function () {
        if (!c.career || !c.career.length) return el('p', { text: 'n/d' });
        var t = el('table', { class: 'mc' }, [el('tr', {}, [el('th', { text: 'Club' }), el('th', { text: 'Perioadă' }), el('th', { text: 'Note' })])]);
        c.career.forEach(function (r) { t.appendChild(el('tr', {}, [el('td', { text: r.club }), el('td', { text: r.period }), el('td', { text: has(r.note) ? r.note : '—' })])); });
        return t;
      },
      'Notițe': function () { return notesBlock(id, 'antrenor ' + d.teams[side].name); }
    });
  }

  function openRef(d) {
    var r = d.referee, id = 'ref:main';
    modal(function (close) {
      return el('div', { class: 'modal-head' }, [
        el('div', { class: 'avatar', style: 'background:#555', text: initials(r.name) }),
        el('div', {}, [
          el('h3', { text: r.name }),
          el('div', { class: 'sub', text: ['Arbitru', has(r.country) ? r.country : null, has(r.age) ? r.age + ' ani' : null].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      'Profil': function () {
        var kv = el('div', { class: 'kv' });
        if (has(r.apps)) kv.appendChild(el('span', { html: '<b>Aparții</b>' + esc(r.apps) }));
        if (has(r.ycPerMatch)) kv.appendChild(el('span', { html: '<b>Galbene/meci</b>' + esc(r.ycPerMatch) }));
        if (has(r.rcPerMatch)) kv.appendChild(el('span', { html: '<b>Roșii/meci</b>' + esc(r.rcPerMatch) }));
        var wrap = el('div', {}, [kv]);
        if (has(r.history)) wrap.appendChild(el('p', { text: r.history }));
        return wrap;
      },
      'Notițe': function () { return notesBlock(id, 'arbitru'); }
    });
  }

  function pos(p) { return has(p.pos) ? p.pos : ({ GK: 'Portar', DEF: 'Fundaș', MID: 'Mijlocaș', ATT: 'Atacant' })[p.role] || ''; }
  function footLabel(f) { return { L: 'stângul', R: 'dreptul', B: 'ambele' }[f] || null; }
  function natLabel(p) {
    var a = [];
    if (has(p.nat)) a.push(p.nat);
    if (has(p.natTeam) && p.natTeam !== p.nat) a.push('(' + p.natTeam + ')');
    return a.join(' ');
  }
})();
