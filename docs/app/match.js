/* Match Center — read-only render of docs/data/matches/<slug>.json + a local notes layer.
   Vanilla JS, no build step. Interactivity (pitch drag, formation switch, prep
   checklist) is deliberately out of scope for this pass. */
(function () {
  'use strict';

  var $ = function (sel, el) { return (el || document).querySelector(sel); };
  var root = $('#root');

  var params = new URLSearchParams(location.search);
  var slug = (params.get('m') || '').trim();
  if (!slug) { fail('Lipsește parametrul ?m=<slug>. Deschide un meci din <a href="index.html">listă</a>.'); return; }

  fetch('data/matches/' + encodeURIComponent(slug) + '.json', { cache: 'no-cache' })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) { render(data); })
    .catch(function (e) {
      fail('Nu am putut încărca datele pentru <code>' + esc(slug) + '</code> (' + esc(e.message) +
        ').<br>Poate ecranul nu e încă generat. Înapoi la <a href="index.html">listă</a>.');
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

  /* ---------- notes (localStorage) ---------- */
  var NKEY = 'mc:' + slug;
  var store = load();
  function load() {
    try { return JSON.parse(localStorage.getItem(NKEY)) || {}; } catch (e) { return {}; }
  }
  function save() {
    try { localStorage.setItem(NKEY, JSON.stringify(store)); } catch (e) {}
  }
  function notesFor(id) { return (store.notes && store.notes[id]) || []; }
  function addNote(id, text) {
    if (!text.trim()) return;
    store.notes = store.notes || {};
    (store.notes[id] = store.notes[id] || []).push({ id: Date.now() + '' + Math.random().toString(36).slice(2, 6), text: text.trim(), ts: Date.now() });
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
    function redraw() {
      list.innerHTML = '';
      notesFor(id).forEach(function (n) {
        list.appendChild(el('div', { class: 'note' }, [
          el('span', { text: n.text }),
          el('span', {}, [
            el('time', { text: new Date(n.ts).toLocaleString('ro-RO', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) }),
            el('button', { text: '✕', title: 'Șterge', onclick: function () { delNote(id, n.id); redraw(); } })
          ])
        ]));
      });
    }
    var ta = el('textarea', { placeholder: 'Notiță — ' + (label || id) + '…' });
    var addBtn = el('button', { text: 'Adaugă notiță', onclick: function () { addNote(id, ta.value); ta.value = ''; redraw(); } });
    ta.addEventListener('keydown', function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { addNote(id, ta.value); ta.value = ''; redraw(); }
    });
    wrap.appendChild(list);
    wrap.appendChild(ta);
    wrap.appendChild(el('div', { class: 'notes-row' }, [addBtn]));
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
        var t = data.teams[p[1]]; var pl = t && (t.squad || []).filter(function (x) { return String(x.number) === p[2] || x.name === p[2]; })[0];
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
        lines.push('- ' + note.text + '  \n  _' + new Date(note.ts).toLocaleString('ro-RO') + '_');
      });
      lines.push('');
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/markdown' });
    var a = el('a', { href: URL.createObjectURL(blob), download: 'notite-' + slug + '.md' });
    document.body.appendChild(a); a.click(); a.remove();
  }

  /* ---------- pitch view (orientation + which team is nearest the viewer) ---------- */
  var view = (store.view && typeof store.view === 'object')
    ? { orientation: store.view.orientation === 'v' ? 'v' : 'h', swapped: !!store.view.swapped }
    : { orientation: 'h', swapped: false };
  function saveView() { store.view = { orientation: view.orientation, swapped: view.swapped }; save(); }

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

  /* ---------- render ---------- */
  var pitchEl = null;
  function rerenderPitch(data) {
    var next = pitch(data);
    if (pitchEl) pitchEl.replaceWith(next);
    pitchEl = next;
  }

  function render(data) {
    document.title = data.teams.home.name + ' – ' + data.teams.away.name + ' · Match Center';
    root.innerHTML = '';
    pitchEl = null;

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

    // header
    var head = el('div', { class: 'mc-head' }, [
      el('a', { class: 'mc-back', href: 'index.html', text: '← toate meciurile' }),
      el('div', { class: 'mc-teams' }, [
        el('span', { text: data.teams.home.name }),
        el('span', { class: 'vs', text: 'vs' }),
        el('span', { text: data.teams.away.name })
      ]),
      el('div', { class: 'mc-meta', text: metaLine(data) }),
      el('div', { class: 'mc-toolbar' }, [
        swapBtn,
        orientBtn,
        el('button', { text: '🖨 Print', onclick: function () { window.print(); } }),
        el('button', { text: '⭳ Export notițe', onclick: function () { exportNotes(data); } }),
        el('button', { text: '⇕ Extinde / restrânge', onclick: toggleAll }),
        el('button', { text: '🗑 Șterge notițele acestui meci', onclick: function () {
          if (confirm('Ștergi toate notițele pentru acest meci?')) { store = {}; save(); render(data); }
        } })
      ])
    ]);
    root.appendChild(head);

    pitchEl = pitch(data);
    root.appendChild(pitchEl);
    root.appendChild(panels(data));
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
    return bits.join('  ·  ');
  }

  function pitch(d) {
    var vert = view.orientation === 'v';
    var nearKey = view.swapped ? 'away' : 'home';
    var shell = el('div', { class: 'pitch-shell' + (vert ? ' vertical' : '') }, [
      el('div', { class: 'pitch-lines' }),
      el('div', { class: 'pitch-box a' }),
      el('div', { class: 'pitch-box b' })
    ]);

    ['home', 'away'].forEach(function (side) {
      var t = d.teams[side];
      var isNear = side === nearKey;
      var xi = t.predictedXI && t.predictedXI.length ? t.predictedXI : [];
      var pts = layout(t.formation);
      xi.forEach(function (slot, i) {
        var pos = place(pts[i] || { d: 0.03, w: 0.05 + i * 0.08 }, isNear);
        var full = playerByNameOrNum(t, slot);
        var stat = full && full.status;
        var node = el('div', {
          class: 'node ' + side + (stat && stat !== 'available' ? ' status-' + stat : ''),
          style: 'left:' + pos.left.toFixed(2) + '%;top:' + pos.top.toFixed(2) + '%',
          onclick: function () { if (full) openPlayer(d, side, full); }
        }, [
          el('div', { class: 'disc', text: slot.number != null ? String(slot.number) : (slot.pos || '') }),
          el('div', { class: 'lbl', text: shortName(slot.name) })
        ]);
        shell.appendChild(node);
      });
      // coach mini-card — near team's coach sits at the near end, far team's at the far end
      if (t.coach && has(t.coach.name)) {
        var corner = vert
          ? (isNear ? 'bl' : 'tr')
          : (isNear ? 'tl' : 'tr');
        shell.appendChild(el('div', { class: 'card-slot ' + corner }, [
          el('div', { class: 'mini-card', onclick: function () { openCoach(d, side); } }, [
            el('div', { class: 'mc-role', text: 'Antrenor' }),
            el('div', { class: 'mc-name', text: t.coach.name }),
            el('div', { class: 'mc-line', text: [has(t.coach.country) ? t.coach.country : null, has(t.coach.age) ? t.coach.age + ' ani' : null, has(t.formation) ? t.formation : null].filter(Boolean).join(' · ') })
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
    }
    return shell;
  }

  function shortName(name) {
    var parts = String(name || '').split(/\s+/).filter(Boolean);
    if (parts.length < 2) return name || '';
    // drop a trailing generational suffix (Jr., Sr., II, III)
    if (/^(jr|sr|ii|iii|iv)\.?$/i.test(parts[parts.length - 1])) parts.pop();
    var last = parts[parts.length - 1];
    return parts.length > 1 ? parts[0].charAt(0) + '. ' + last : last;
  }
  function playerByNameOrNum(team, slot) {
    var sq = team.squad || [];
    return sq.filter(function (p) {
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

  function panels(d) {
    var box = el('div', { class: 'panels' });

    if (d.storyOfTheMatch && d.storyOfTheMatch.length) {
      box.appendChild(panel('Story of the match', ul(d.storyOfTheMatch), { lead: true, open: true }));
    }

    // per-team stories
    ['home', 'away'].forEach(function (side) {
      var t = d.teams[side];
      if (t.stories && t.stories.length) {
        var wrap = el('div');
        t.stories.forEach(function (s) {
          wrap.appendChild(el('div', { class: 'story-bar' }, [
            el('h4', { text: s.title }),
            ul(s.bullets)
          ]));
        });
        box.appendChild(panel('Fire — ' + t.name, wrap));
      }
    });

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
      box.appendChild(panel('Cap la cap', h, { open: true }));
    }

    // Form (two-col)
    if (d.teams.home.form || d.teams.away.form) {
      box.appendChild(panel('Formă', twoCol(d, function (t) {
        var wrap = el('div');
        var f = t.form || {};
        if (f.last5 && f.last5.length) {
          var badges = el('div', { class: 'form-badges' });
          f.last5.forEach(function (r) { badges.appendChild(el('span', { class: 'fb-' + r, text: r })); });
          wrap.appendChild(badges);
        }
        if (has(f.ppg)) wrap.appendChild(el('div', { text: 'PPG: ' + f.ppg }));
        if (has(f.homeAway)) wrap.appendChild(el('div', { text: f.homeAway }));
        if (!wrap.childNodes.length) wrap.appendChild(el('div', { text: 'n/d' }));
        return wrap;
      })));
    }

    // Absences + probable XI
    box.appendChild(panel('Absențe și primul 11 probabil', twoCol(d, function (t) {
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
      box.appendChild(panel('Mercato — vară', twoCol(d, function (t) {
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
      box.appendChild(panel('Pregătirea de vară', twoCol(d, function (t) {
        return ul((t.preseason || []).map(function (p) { return (has(p.date) ? p.date + ' · ' : '') + p.opp + ' ' + p.score; }));
      })));
    }

    // News
    if ((d.teams.home.news || []).length || (d.teams.away.news || []).length) {
      box.appendChild(panel('Top știri', twoCol(d, function (t) {
        return ul((t.news || []).map(function (n) { return (has(n.date) ? '[' + n.date + '] ' : '') + n.text; }));
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
      box.appendChild(panel('Stadion', vb));
    }

    // Squads
    ['home', 'away'].forEach(function (side) {
      var t = d.teams[side];
      if (!t.squad || !t.squad.length) return;
      var groups = { GK: [], DEF: [], MID: [], ATT: [] };
      t.squad.forEach(function (p) { (groups[p.role] || groups.MID).push(p); });
      var wrap = el('div');
      ['GK', 'DEF', 'MID', 'ATT'].forEach(function (g) {
        if (!groups[g].length) return;
        wrap.appendChild(el('h4', { text: ({ GK: 'Portari', DEF: 'Fundași', MID: 'Mijlocași', ATT: 'Atacanți' })[g] }));
        var list = el('ul');
        groups[g].forEach(function (p) {
          var li = el('li', {}, [
            el('a', { href: '#', onclick: function (e) { e.preventDefault(); openPlayer(d, side, p); },
              text: (p.number != null ? p.number + '. ' : '') + p.name +
                (has(p.age) ? ' · ' + p.age : '') + (has(p.nat) ? ' · ' + p.nat : '') +
                (p.status && p.status !== 'available' ? ' · ' + p.status : '') })
          ]);
          list.appendChild(li);
        });
        wrap.appendChild(list);
      });
      box.appendChild(panel('Lot — ' + t.name, wrap));
    });

    // sources
    if (d.sources && d.sources.length) {
      box.appendChild(panel('Surse', ul(d.sources.map(function (s) {
        return s.name + (has(s.url) ? ' — ' + s.url : '') + (has(s.accessed) ? ' (' + s.accessed + ')' : '');
      }))));
    }

    // match-level notes
    box.appendChild(panel('Notițe — general meci', notesBlock('match', 'general meci'), { lead: true, open: true }));

    return box;
  }

  function twoCol(d, fn) {
    return el('div', { class: 'two-col' }, [
      el('div', {}, [el('h4', { text: d.teams.home.name }), fn(d.teams.home)]),
      el('div', {}, [el('h4', { text: d.teams.away.name }), fn(d.teams.away)])
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
      body.innerHTML = ''; body.appendChild(tabs[name]());
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
          el('h3', { text: (p.number != null ? '#' + p.number + '  ' : '') + p.name }),
          el('div', { class: 'sub', text: [pos(p), has(p.age) ? p.age + ' ani' : null, has(p.height) ? p.height + ' cm' : null, has(p.weight) ? p.weight + ' kg' : null, footLabel(p.foot)].filter(Boolean).join('  ·  ') }),
          el('div', { class: 'sub', text: [natLabel(p), d.teams[side].name].filter(Boolean).join('  ·  ') })
        ]),
        el('button', { class: 'modal-close', text: '✕', onclick: close })
      ]);
    }, {
      'Profil': function () {
        var wrap = el('div');
        var kv = el('div', { class: 'kv' });
        if (has(p.pronunciation)) kv.appendChild(el('span', { html: '<b>Pronunție</b>' + esc(p.pronunciation) }));
        if (has(p.nat)) kv.appendChild(el('span', { html: '<b>Cetățenie</b>' + esc(p.nat) }));
        if (has(p.natTeam)) kv.appendChild(el('span', { html: '<b>Națională</b>' + esc(p.natTeam) }));
        if (has(p.birthCountry)) kv.appendChild(el('span', { html: '<b>Născut în</b>' + esc(p.birthCountry) }));
        if (kv.childNodes.length) wrap.appendChild(kv);
        if (has(p.lastSeason)) wrap.appendChild(el('p', { html: '<b style="color:var(--color-neutral-500)">Sezonul trecut:</b> ' + esc(p.lastSeason) }));
        if (!wrap.childNodes.length) wrap.appendChild(el('p', { text: 'Fără detalii suplimentare.' }));
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
      'Notițe': function () { return notesBlock(id, p.name); }
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
