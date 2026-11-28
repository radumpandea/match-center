/* Match Center — "cards" screen: one broadcast-style board for a live match, everything as cards. The second format of
   the match page (switch "Clasic | Carduri", remembered in localStorage `mc:view`; the classic page stays).
   It only READS the match pack, the live tables and the user's work on the classic page (line-up changes, bench,
   formation, numbers, names, noted events, pasted referee crew); it changes none of them. Its quick note has its own key.
   Laid out on a canvas 960 px high and 1560-2200 px wide, scaled to the window (desktop / tablet). Romanian only. */
(function () {
  'use strict';
  var H = 960, W = 1680, SIDE = 206;   // W follows the window's shape (see fit)
  var board = document.getElementById('board');
  var slug = (new URLSearchParams(location.search).get('m') || '').trim();
  var d = null, fx = null, live = { fx: null, events: [], timer: null }, scale = 1;
  var ZOOMS = [1, 1.15, 1.3, 1.5], zoom = (function () { try { var z = Number(localStorage.getItem('mc:cardsZoom')); return ZOOMS.indexOf(z) >= 0 ? z : 1; } catch (e) { return 1; } })();
  function setZoom(step) {
    zoom = ZOOMS[Math.max(0, Math.min(ZOOMS.length - 1, ZOOMS.indexOf(zoom) + step))];
    try { localStorage.setItem('mc:cardsZoom', String(zoom)); } catch (e) {}
    fit(); hidePop();
  }
  var nodes = {};                      // containers that are refreshed when live data arrives
  var cardByPlayer = {};               // 'home:<apiId|name>' -> badge container on the pitch card

  /* ---------- small helpers ---------- */
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (attrs[k] == null || attrs[k] === false) return;
      if (k === 'class') n.className = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') n.addEventListener(k.slice(2), attrs[k]);
      else n.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { if (c != null && c !== false) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function has(v) { return v != null && v !== '' && v !== 'n/d'; }
  function num(v) { return has(v) ? v : '–'; }
  function norm(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z\s-]/g, ' ').replace(/\s+/g, ' ').trim(); }
  function read(key) { try { return JSON.parse(localStorage.getItem(key)) || {}; } catch (e) { return {}; } }
  function ink(hex) {
    var h = /^#[0-9a-f]{6}$/i.test(hex || '') ? hex : '#1c2740';
    var b = (parseInt(h.slice(1, 3), 16) * 299 + parseInt(h.slice(3, 5), 16) * 587 + parseInt(h.slice(5, 7), 16) * 114) / 1000;
    return b > 150 ? '#10131a' : '#fff';
  }
  function color(side) { var c = d.teams[side].colors && d.teams[side].colors.primary; return /^#[0-9a-f]{6}$/i.test(c || '') ? c : (side === 'home' ? '#c8102e' : '#1d4ed8'); }
  // "Lucas Simon Pierre Tousart" -> { first: "Lucas", last: "Tousart" }; particles stay with the surname
  function nameParts(name) {
    var p = String(name || '').split(/\s+/).filter(Boolean);
    if (p.length < 2) return { first: '', last: name || '' };
    var i = p.length - 1;
    if (/^(jr|sr|ii|iii|iv)\.?$/i.test(p[i]) && i > 1) i--;
    while (i > 1 && /^(van|von|der|den|de|da|do|dos|di|del|le|la|el|al|ben|ter)$/i.test(p[i - 1])) i--;
    return { first: p[0], last: p.slice(i).join(' ') };
  }
  // The name a commentator uses: API-Football's squad gives civil names ("Bradley Locko Banzouzi"), its match sheets the
  // football one ("B. Locko"). Taken from the team's recent line-ups when shirt number and first initial agree.
  function callName(side, p, number) {
    var guide = (side && d.teams[side].form && d.teams[side].form.recent) || [];
    var n = number != null ? number : p.number, initial = norm(p.name).charAt(0), full = " " + norm(p.name).replace(/-/g, " ") + " ";
    for (var i = 0; i < guide.length; i++) {
      var xi = (guide[i].lineups && guide[i].lineups.us) || [];
      for (var j = 0; j < xi.length; j++) {
        var m = /^(\S)\.\s+(.+)$/.exec(xi[j].name || '');
        if (!m || xi[j].number !== n || norm(m[1]) !== initial) continue;
        if (full.indexOf(" " + norm(m[2]).replace(/-/g, " ") + " ") >= 0) return m[2];
      }
    }
    return nameParts(p.name).last;
  }
  // the same for someone known only by apiId or name (events)
  function shortOf(id, name) {
    var out = null;
    ["home", "away"].forEach(function (s) {
      (d.teams[s].squad || []).forEach(function (p) { if (!out && ((id != null && p.apiId === id) || (id == null && name && norm(p.name) === norm(name)))) out = callName(s, p); });
    });
    return out || nameParts(name).last;
  }
  function avatar(photo, name, cls) {
    var box = el('div', { class: 'ava ' + (cls || '') });
    var initials = String(name || '?').split(/\s+/).map(function (x) { return x.charAt(0); }).join('').slice(0, 2).toUpperCase();
    if (!photo) { box.textContent = initials; return box; }
    var img = el('img', { src: photo, alt: '', loading: 'lazy' });
    img.addEventListener('error', function () { box.textContent = initials; });
    box.appendChild(img);
    return box;
  }

  /* ---------- who plays: the pack, then everything the user changed on the classic page (read only) ---------- */
  function shared() { return read('mc:' + slug); }             // numbers, manually added players, noted events
  function own() { return read('mc:' + slug + ':me'); }        // this device: line-up, bench, formation, names
  function keyOf(p) { return !p ? 's' : p.apiId != null ? 'a' + p.apiId : p.number != null ? 'n' + p.number : 's' + p.name; }
  function squadOf(side) { var m = shared().manualSquad; return (d.teams[side].squad || []).concat((m && m[side]) || []); }
  function findPlayer(side, slot) {
    var sq = squadOf(side);
    var hit = slot.apiId != null ? sq.filter(function (p) { return p.apiId === slot.apiId; })[0] : null;
    if (!hit && slot.name) hit = sq.filter(function (p) { return norm(p.name) === norm(slot.name); })[0];
    if (!hit && slot.number != null && slot.name) {
      var last = norm(slot.name).split(' ').pop();
      hit = sq.filter(function (p) { return p.number === slot.number && norm(p.name).split(' ').indexOf(last) >= 0; })[0];
    }
    return hit || { name: slot.name, number: slot.number, apiId: slot.apiId, pos: slot.pos, stats: null };
  }
  // one entry of the eleven or the bench, with the user's number and name overrides
  function entry(side, slot) {
    var p = findPlayer(side, slot), numbers = shared().pnum, names = own().pname;
    var number = slot.number != null ? slot.number : p.number;
    if (numbers && numbers[side] && Object.prototype.hasOwnProperty.call(numbers[side], p.name)) number = numbers[side][p.name];
    var renamed = names && names[side] ? names[side][keyOf(p)] || names[side][keyOf(slot)] : null;
    return { slot: slot, p: p, number: number, renamed: renamed || null };
  }
  function apiLineup(side) { var a = own().apiLineup; return a && a[side] && a[side].xi && a[side].xi.length === 11 ? a[side] : null; }
  function lineupKind(side) { var t = d.teams[side]; return apiLineup(side) || (t.confirmedXI || []).length === 11 ? 'confirmed' : (t.predictedXI || []).length === 11 ? 'predicted' : 'none'; }
  function changedByUser(side) { var x = own().xi; return !!(x && x[side] && Object.keys(x[side]).length); }
  function formationOf(side) { var f = own().formation, a = apiLineup(side); return (f && f[side]) || (a && a.formation) || d.teams[side].formation || '4-4-2'; }
  var xiCache = {};   // rebuilt on every render
  function xiOf(side) {
    if (xiCache[side]) return xiCache[side];
    var t = d.teams[side], a = apiLineup(side);
    var slots = a ? a.xi : (t.confirmedXI || []).length === 11 ? t.confirmedXI : (t.predictedXI || []).length === 11 ? t.predictedXI : null;
    if (!slots) {   // no eleven in the pack: the eleven with the most minutes, so the board is not empty
      var order = { GK: 0, DEF: 1, MID: 2, ATT: 3 };
      slots = (t.squad || []).slice().sort(function (x, y) { return ((y.stats && y.stats.minutes) || 0) - ((x.stats && x.stats.minutes) || 0); }).slice(0, 11)
        .sort(function (x, y) { return (order[x.role] || 0) - (order[y.role] || 0); });
    }
    var mine = own().xi, over = (mine && mine[side]) || {};
    xiCache[side] = slots.map(function (slot, i) { return entry(side, over[i] || slot); });
    return xiCache[side];
  }
  function benchOf(side) {
    var t = d.teams[side], a = apiLineup(side), onPitch = {};
    xiOf(side).forEach(function (x) { onPitch[keyOf(x.p)] = 1; });
    var picked = own().bench, list;
    if (picked && picked[side] && picked[side].length) {
      var sq = squadOf(side);
      list = picked[side].map(function (k) { return sq.filter(function (p) { return keyOf(p) === k; })[0]; }).filter(Boolean).map(function (p) { return entry(side, p); });
    } else {
      var subs = a && a.subs && a.subs.length ? a.subs : t.substitutes;
      list = (subs || []).length ? subs.map(function (x) { return entry(side, x); })
        : squadOf(side).filter(function (p) { return p.status !== 'out' && p.status !== 'suspended'; })
          .sort(function (x, y) { return ((y.stats && y.stats.minutes) || 0) - ((x.stats && x.stats.minutes) || 0); })
          .map(function (p) { return entry(side, p); });
    }
    return list.filter(function (x) { return !onPitch[keyOf(x.p)]; }).slice(0, 12);
  }

  /* ---------- positions: same rules as the normal match page (own left at the top for the team attacking right) ---------- */
  var LAT = { LWB: -4, LB: -4, LM: -4, LW: -4, LCB: -2, LCM: -2, LF: -2, LST: -2, CB: 0, DM: 0, CM: 0, CAM: 0, ST: 0, RCB: 2, RCM: 2, RF: 2, RST: 2, RB: 4, RWB: 4, RM: 4, RW: 4 };
  function spots(xi, formation) {
    var counts = [1].concat(String(formation || '4-4-2').split('-').map(function (x) { return parseInt(x, 10) || 0; }).filter(Boolean));
    var out = new Array(xi.length), start = 0;
    counts.forEach(function (n, row) {
      var idx = []; for (var k = 0; k < n; k++) idx.push(start + k);
      if (n > 1) {
        var ranks = idx.map(function (i) { return xi[i] && LAT[String(xi[i].slot.pos || '').toUpperCase()]; });
        if (ranks.every(function (r) { return r !== undefined; })) idx.sort(function (a, b) { return ranks[a - start] - ranks[b - start] || a - b; });
        else idx.reverse();
      }
      var depth = 0.054 + (row / Math.max(1, counts.length - 1)) * 0.39;
      idx.forEach(function (slot, j) { out[slot] = { d: depth, w: n === 1 ? 0.5 : (j + 0.5) / n, line: n, cols: counts.length }; });
      start += n;
    });
    return out;
  }

  /* ---------- live data + what the user noted on the normal page ---------- */
  function sideOf(teamId) { return fx && teamId === fx.homeId ? 'home' : fx && teamId === fx.awayId ? 'away' : null; }
  function inXI(id) { return id != null && ['home', 'away'].some(function (s) { return xiOf(s).some(function (x) { return x.p.apiId === id; }); }); }
  // One flat list: { minute, side, kind: goal|owngoal|miss|yellow|red|sub|var, name, id, inName, inId, mine, removed }
  function events() {
    var out = [];
    live.events.forEach(function (e) {
      var side = sideOf(e.team_id), kind = null, ev = { minute: e.minute, extra: e.extra, side: side, name: e.player_name, id: e.player_id, removed: e.present === false, mine: false };
      if (e.type === 'Goal') kind = e.detail === 'Own Goal' ? 'owngoal' : e.detail === 'Missed Penalty' ? 'miss' : 'goal';
      else if (e.type === 'Card') kind = /red|second yellow/i.test(e.detail || '') ? 'red' : 'yellow';
      else if (e.type === 'Var') { kind = 'var'; ev.name = (e.detail || 'VAR') + (e.player_name ? ' · ' + e.player_name : ''); }
      else if (e.type === 'subst') {
        kind = 'sub';
        // the API's "player" / "assist" are the one going off and the one coming on; if the eleven says otherwise, swap
        var off = { id: e.player_id, name: e.player_name }, on = { id: e.assist_id, name: e.assist_name };
        if (inXI(on.id) && !inXI(off.id)) { var t = off; off = on; on = t; }
        ev.name = off.name; ev.id = off.id; ev.inName = on.name; ev.inId = on.id;
      }
      if (!kind) return;
      ev.kind = kind; out.push(ev);
    });
    var mine = read('mc:' + slug).events || {};
    Object.keys(mine).forEach(function (k) {
      var i = k.indexOf(':'), side = k.slice(0, i), ref = k.slice(i + 1);
      if (!d.teams[side]) return;
      var p = (d.teams[side].squad || []).filter(function (x) { return ref === 'a' + x.apiId || ref === 'n' + x.number || ref === 's' + x.name; })[0];
      (mine[k] || []).forEach(function (e) {
        out.push({ minute: e.minute, side: side, kind: e.type, name: p ? p.name : ref, id: p ? p.apiId : null, mine: true, removed: false });
      });
    });
    return out.sort(function (a, b) { return (a.minute == null ? 999 : a.minute) - (b.minute == null ? 999 : b.minute) || (a.extra || 0) - (b.extra || 0); });
  }
  var ICON = { goal: '⚽', owngoal: '⚽', miss: '❌', yellow: '🟨', red: '🟥', sub: '🔄', 'var': '📺' };
  function minuteText(e) { return e.minute == null ? '—' : e.minute + (e.extra ? '+' + e.extra : '') + "'"; }
  var STATUS = { NS: 'Neînceput', '1H': 'Repriza 1', HT: 'Pauză', '2H': 'Repriza 2', ET: 'Prelungiri', BT: 'Pauză', P: 'Penalty-uri', FT: 'Final', AET: 'Final (prel.)', PEN: 'Final (pen.)', SUSP: 'Suspendat', INT: 'Întrerupt', PST: 'Amânat' };
  function clockText() {
    var f = live.fx;
    if (!f) return fx && fx.ko ? 'Start ' + fx.ko : 'Neînceput';
    var s = STATUS[f.status] || f.status || '';
    return /^(1H|2H|ET)$/.test(f.status) && f.elapsed != null ? f.elapsed + (f.extra ? '+' + f.extra : '') + "' · " + s : s;
  }

  /* ---------- drawer (details) and hover popover ---------- */
  function closeDrawer() { var x = board.querySelector('.drawer-back'); if (x) x.remove(); }
  function drawer(title, sub, kids, accent) {
    closeDrawer(); hidePop();
    var back = el('div', { class: 'drawer-back', onclick: function (e) { if (e.target === back) closeDrawer(); } }, [
      el('aside', { class: 'drawer', style: accent ? '--accent:' + accent : null }, [
        el('header', {}, [el('div', {}, [el('h2', { text: title }), sub ? el('p', { text: sub }) : null]), el('button', { class: 'x', text: '✕', onclick: closeDrawer })]),
        el('div', { class: 'drawer-body' }, kids)
      ])
    ]);
    board.appendChild(back);
  }
  function list(items) { var l = (items || []).filter(has); return l.length ? el('ul', {}, l.map(function (x) { return el('li', { text: x }); })) : el('p', { class: 'dim', text: 'Nimic în pachet.' }); }
  function section(title, node) { return el('section', {}, [el('h3', { text: title }), node]); }
  function table(head, rows) {
    return el('table', {}, [el('tr', {}, head.map(function (h) { return el('th', { text: h }); }))].concat(rows.map(function (r) {
      return el('tr', { class: r.cls || null }, (r.cells || r).map(function (c) { return el('td', { text: c == null ? '' : String(c) }); }));
    })));
  }
  function twoTeams(fn) { return el('div', { class: 'two' }, ['home', 'away'].map(function (s) { return el('div', {}, [el('h4', { text: d.teams[s].name }), fn(d.teams[s], s)]); })); }

  // The player's last matches (from the team's form guide): started / came on, goals, cards
  function recentRows(side, p) {
    var guide = (d.teams[side].form && d.teams[side].form.recent) || [], me = norm(p.name).split(' ');
    function same(n) { var x = norm(n).split(' '); return !!x[0] && x[x.length - 1] === me[me.length - 1] && x[0].charAt(0) === me[0].charAt(0); }
    return guide.map(function (r) {
      var xi = (r.lineups && r.lineups.us) || [], row = { r: r, started: xi.some(function (x) { return same(x.name); }), on: null, goals: 0, yellow: 0, red: 0 };
      (r.events || []).forEach(function (e) {
        if (e.side !== 'us') return;
        if (e.type === 'sub') { if (same(e.playerIn)) row.on = e.minute; }
        else if (same(e.player)) { if (e.type === 'goal') row.goals++; if (e.type === 'yellow') row.yellow++; if (e.type === 'red') row.red++; }
      });
      return row;
    });
  }
  function hidePop() { var x = board.querySelector('.pop'); if (x) x.remove(); }
  function showPop(anchor, side, p, what) {
    hidePop();
    var label = what === 'goals' ? 'Goluri' : 'Cartonașe galbene';
    var total = p.stats ? p.stats[what === 'goals' ? 'goals' : 'yellow'] : null;
    var rows = recentRows(side, p).filter(function (x) { return what === 'goals' ? x.goals : x.yellow; });
    var pop = el('div', { class: 'pop' }, [
      el('strong', { text: p.name }),
      el('div', { class: 'pop-head' }, [el('b', { text: label }), el('span', { text: num(total) + ' în acest sezon' })])
    ].concat(rows.length ? rows.map(function (x) {
      var n = what === 'goals' ? x.goals : x.yellow;
      return el('div', { class: 'pop-row' }, [
        el('span', { text: String(x.r.date || '').slice(8, 10) + '.' + String(x.r.date || '').slice(5, 7) + (x.r.homeAway === 'A' ? ' @ ' : ' vs ') + (x.r.opp || '') }),
        el('span', { text: (n > 1 ? '×' + n + '  ' : '') + (x.r.result || '') + ' ' + (x.r.score || '') })
      ]);
    }) : [el('div', { class: 'dim', text: 'Niciunul în ultimele meciuri din pachet.' })]));
    board.appendChild(pop);
    var b = board.getBoundingClientRect(), a = anchor.getBoundingClientRect();
    var x = (a.right - b.left) / scale + 8, y = (a.top - b.top) / scale - 20;
    if (x + 330 > W) x = (a.left - b.left) / scale - 338;
    pop.style.left = Math.max(4, x) + 'px';
    pop.style.top = Math.max(4, Math.min(y, H - pop.offsetHeight - 6)) + 'px';
  }

  function openPlayer(side, p, number) {
    var s = p.stats || {};
    var facts = [p.age ? p.age + ' ani' : null, p.natTeam || p.nat, p.height ? p.height + ' cm' : null, p.weight ? p.weight + ' kg' : null, p.foot, p.birthCountry].filter(has).join(' · ');
    var rec = recentRows(side, p);
    drawer((number != null ? number + '. ' : '') + p.name, [d.teams[side].name, p.pos || p.role, facts].filter(has).join(' · '), [
      has(p.pronunciation) ? el('p', { class: 'pron', text: 'Pronunție: ' + p.pronunciation }) : null,
      has(p.statusNote) || (p.status && p.status !== 'available') ? el('p', { class: 'warn', text: (p.status || '') + (p.statusNote ? ' — ' + p.statusNote : '') }) : null,
      has(p.linkLine) ? el('p', { class: 'link-line', text: p.linkLine }) : null,
      section('Fapte', list(p.funfacts && p.funfacts.length ? p.funfacts : [p.funfact])),
      section('Sezon', table(['Meciuri', 'Min', 'G', 'A', '🟨', '🟥', 'Șuturi (pe poartă)', 'Pase %', 'Dueluri', 'Notă'], [[
        num(s.apps), num(s.minutes), num(s.goals), num(s.assists), num(s.yellow), s.red || 0, num(s.shotsTotal) + ' (' + num(s.shotsOn) + ')', num(s.passesAccuracy), num(s.duelsWon) + '/' + num(s.duelsTotal), num(s.rating)]])),
      rec.length ? section('Ultimele meciuri', table(['Data', 'Adversar', 'Scor', 'Rol', 'G', '🟨', '🟥'], rec.map(function (x) {
        return [String(x.r.date || '').slice(5), (x.r.homeAway === 'A' ? '@ ' : '') + (x.r.opp || ''), (x.r.score || '') + ' ' + (x.r.result || ''), x.started ? 'titular' : x.on != null ? 'intrat ' + x.on + "'" : '—', x.goals || '', x.yellow || '', x.red || ''];
      }))) : null,
      section('Carieră', list(String(p.career || '').split(' · '))),
      (p.honours || []).length ? section('Palmares (de verificat)', list(p.honours.map(function (h) { return typeof h === 'string' ? h : [h.title || h.name, h.season].filter(has).join(' · '); }))) : null
    ], color(side));
  }
  function openCoach(side) {
    var c = d.teams[side].coach || {};
    drawer(c.name || 'Antrenor', [d.teams[side].name, c.age ? c.age + ' ani' : null, c.country, c.tenureFrom ? 'din ' + c.tenureFrom : null].filter(has).join(' · '), [
      section('Fapte', list(c.funfacts)),
      section('Carieră', list((c.career || []).map(function (x) { return x.club + ' (' + x.period + ')' + (x.note ? ' — ' + x.note : ''); })))
    ], color(side));
  }
  function referee() {
    var r = d.referee || {}, pasted = read('mc:' + slug + ':me').refCrew;
    if (pasted) r = { name: pasted.name || r.name, crew: pasted.crew, funfacts: r.funfacts, country: r.country };
    return r;
  }
  function refereeBody() {
    var r = referee(), cr = r.crew || {};
    var names = { assistant1: 'Asistent', assistant2: 'Asistent', reserve: 'Rezervă', 'var': 'VAR', avar: 'AVAR', observer: 'Observator', delegate: 'Delegat' };
    return [
      section('Brigada', list(Object.keys(names).filter(function (k) { return has(cr[k]); }).map(function (k) { return names[k] + ': ' + cr[k]; }))),
      section('Fapte', list(r.funfacts)),
      has(r.history) ? el('p', { text: r.history }) : null
    ];
  }

  /* ---------- top menu ---------- */
  function squadTop(key, n, filter) {
    var all = [];
    ['home', 'away'].forEach(function (s) { (d.teams[s].squad || []).forEach(function (p) { if (p.stats && p.stats[key] > 0 && (!filter || filter(p))) all.push({ p: p, side: s, v: p.stats[key] }); }); });
    return all.sort(function (a, b) { return b.v - a.v; }).slice(0, n);
  }
  var MENU = [
    ['📌 Povestea', function () { return [list(d.storyOfTheMatch)]; }],
    ['🔎 Cercetare', function () { return [list((d.commentatorResearch || []).map(function (c) { return c.topic + ': ' + c.fact; }))]; }],
    ['⚽ Marcatori', function () { return [table(['Jucător', 'Echipă', 'G', 'A', 'Meciuri'], squadTop('goals', 14).map(function (x) { return [x.p.name, d.teams[x.side].name, x.v, x.p.stats.assists || 0, x.p.stats.apps]; }))]; }],
    ['🧤 Portari', function () {
      return [twoTeams(function (t) { return table(['Portar', 'Meciuri', 'Primite', 'Parade', 'Pen. apărate'], (t.squad || []).filter(function (p) { return p.role === 'GK' && p.stats && p.stats.apps; }).map(function (p) { return [p.name, p.stats.apps, p.stats.conceded, p.stats.saves, p.stats.penaltySaved || 0]; })); })];
    }],
    ['🎯 Penalty', function () {
      return [twoTeams(function (t) {
        var st = (t.form && t.form.stats) || {};
        return el('div', {}, [el('p', { text: 'Echipa: ' + (st.penaltyScored || 0) + ' transformate, ' + (st.penaltyMissed || 0) + ' ratate' }),
          table(['Jucător', 'Marcate', 'Ratate'], (t.squad || []).filter(function (p) { return p.stats && (p.stats.penaltyScored || p.stats.penaltyMissed); }).map(function (p) { return [p.name, p.stats.penaltyScored || 0, p.stats.penaltyMissed || 0]; }))]);
      })];
    }],
    ['🚑 Absenți', function () { return [twoTeams(function (t) { return list((t.absences || []).map(function (a) { return a.name + (a.detail ? ' — ' + a.detail : a.reason ? ' — ' + a.reason : ''); })); }),
      section('Atenție la cartonașe', twoTeams(function (t) { return list((t.watch || []).map(function (w) { return w.name + (w.yellows != null ? ': ' + w.yellows + ' galbene' + (w.threshold ? ' (suspendare la ' + w.threshold + ')' : '') : ''); })); }))]; }],
    ['🤝 Cap la cap', function () { return [el('p', { text: (d.h2h && d.h2h.summary) || '' }), table(['Data', 'Competiție', 'Scor'], ((d.h2h && d.h2h.recent) || []).map(function (m) { return [m.date, m.comp, m.score]; }))]; }],
    ['🏆 Clasament', function () { return [table(['#', 'Echipă', 'J', 'V', 'E', 'Î', 'GM', 'GP', 'P'], ((d.standings && d.standings.rows) || []).map(function (r) { return { cls: isOurs(r) ? 'ours' : null, cells: [r.rank, r.team, r.played, r.win, r.draw, r.loss, r.gf, r.ga, r.points] }; }))]; }],
    ['🏟 Stadion', function () { var v = d.venue || {}; return [el('p', { text: [v.name, v.city, v.capacity ? v.capacity.toLocaleString('ro-RO') + ' locuri' : null].filter(has).join(' · ') }), list(v.stories), section('Oraș', list([].concat(v.cityInfo || []).map(function (x) { return typeof x === 'string' ? x : ''; })))]; }],
    ['🧑‍⚖️ Arbitru', function () { return refereeBody(); }],
    ['🛡 Cluburi', function () { return [twoTeams(function (t) { return list(t.clubFacts); })]; }]
  ];
  function isOurs(r) { return fx && (r.teamId === fx.homeId || r.teamId === fx.awayId); }

  /* ---------- board ---------- */
  function widget(title, body, cls) { return el('div', { class: 'widget ' + (cls || '') }, [el('h5', { text: title }), el('div', { class: 'widget-body' }, [].concat(body))]); }
  function miniRow(rank, name, side, value) {
    return el('div', { class: 'mini-row' }, [el('i', { style: 'background:' + color(side) }), el('span', { class: 'rk', text: rank }), el('span', { class: 'nm', text: shortOf(null, name) }), el('b', { text: value })]);
  }
  function leftColumn() {
    var note = el('textarea', { placeholder: 'Notiță rapidă…' });
    note.value = (read('mc:cards:' + slug).note) || '';
    note.addEventListener('input', function () { try { localStorage.setItem('mc:cards:' + slug, JSON.stringify({ note: note.value })); } catch (e) {} });
    var v = d.venue || {}, wx = v.weather;
    var xiPass = [];
    ['home', 'away'].forEach(function (s) { xiOf(s).forEach(function (x) { var st = x.p.stats; if (st && st.passesTotal >= 80 && st.passesAccuracy != null) xiPass.push({ p: x.p, side: s, v: st.passesAccuracy }); }); });
    xiPass.sort(function (a, b) { return b.v - a.v; });
    var scorers = squadTop('goals', 5);
    return el('div', { class: 'col' }, [
      widget('Notițe live', note, 'grow'),
      widget('Stadion', [el('strong', { text: v.name || '—' }), el('div', { class: 'dim', text: [v.city, v.capacity ? v.capacity.toLocaleString('ro-RO') + ' locuri' : null].filter(has).join(' · ') }),
        wx ? el('div', { class: 'weather', text: Math.round(wx.tempC) + '°C · ' + (wx.condition || '') + (wx.windKph != null ? ' · vânt ' + Math.round(wx.windKph) + ' km/h' : '') }) : null]),
      widget('Golgheteri', scorers.length ? scorers.map(function (x, i) { return miniRow(i + 1, x.p.name, x.side, x.v); }) : el('div', { class: 'dim', text: '—' })),
      widget('Precizie pase (primul 11)', xiPass.length ? xiPass.slice(0, 6).map(function (x, i) { return miniRow(i + 1, x.p.name, x.side, x.v + '%'); }) : el('div', { class: 'dim', text: '—' }))
    ]);
  }
  function compare(label, a, b, lowerIsBetter) {
    var x = Number(a) || 0, y = Number(b) || 0, tot = x + y || 1;
    var sa = lowerIsBetter ? y : x, sb = lowerIsBetter ? x : y;
    return el('div', { class: 'cmp' }, [
      el('div', { class: 'cmp-top' }, [el('b', { text: num(a) }), el('span', { text: label }), el('b', { text: num(b) })]),
      el('div', { class: 'cmp-bar' }, [el('i', { style: 'width:' + (100 * sa / tot) + '%;background:' + color('home') }), el('i', { style: 'width:' + (100 * sb / tot) + '%;background:' + color('away') })])
    ]);
  }
  function rightColumn() {
    var h = d.teams.home.form || {}, a = d.teams.away.form || {}, hs = h.stats || {}, as = a.stats || {};
    var rows = (d.standings && d.standings.rows) || [];
    var near = {};
    rows.forEach(function (r, i) { if (isOurs(r)) [i - 1, i, i + 1].forEach(function (j) { if (rows[j]) near[j] = 1; }); });
    var shown = Object.keys(near).map(Number).sort(function (x, y) { return x - y; }).map(function (i) { return rows[i]; }).slice(0, 6);
    nodes.events = el('div', { class: 'ev-list' });
    var rated = [];
    ['home', 'away'].forEach(function (s) { (d.teams[s].squad || []).forEach(function (p) { if (p.stats && p.stats.rating && p.stats.minutes >= 270) rated.push({ p: p, side: s, v: p.stats.rating }); }); });
    rated.sort(function (x, y) { return y.v - x.v; });
    return el('div', { class: 'col' }, [
      widget('Statistici rapide', [
        compare('Loc', h.position, a.position, true), compare('Puncte', h.table && h.table.points, a.table && a.table.points),
        compare('Goluri / meci', hs.goalsForAvg, as.goalsForAvg), compare('Primite / meci', hs.goalsAgainstAvg, as.goalsAgainstAvg, true),
        compare('Fără gol primit', hs.cleanSheets, as.cleanSheets)
      ]),
      widget('Clasament', shown.length ? shown.map(function (r) {
        return el('div', { class: 'mini-row' + (isOurs(r) ? ' ours' : '') }, [el('span', { class: 'rk', text: r.rank }), el('span', { class: 'nm', text: r.team }), el('span', { class: 'dim', text: r.played }), el('b', { text: r.points })]);
      }) : el('div', { class: 'dim', text: '—' })),
      widget('Evenimente', nodes.events, 'grow'),
      widget('Note de sezon', rated.slice(0, 4).map(function (x, i) { return miniRow(i + 1, x.p.name, x.side, x.v.toFixed(2)); }))
    ]);
  }

  function statCell(label, value, extra, cls) { return el('span', Object.assign({ class: 'cell' + (cls ? ' ' + cls : '') }, extra || {}), [el('i', { text: label }), el('b', { text: String(num(value)) })]); }
  // pitch width in canvas pixels, and the card width that leaves a gap between two lines of the same team
  function pitchWidth() { return W - 12 - 2 * SIDE - 12; }
  function cardWidth(cols) { return Math.round(Math.max(98, Math.min(136, (0.39 / Math.max(1, cols - 1)) * pitchWidth() - 3))); }
  function playerCard(side, x, spot) {
    var p = x.p, s = p.stats || {}, c = color(side);
    var nm = x.renamed ? { first: '', last: x.renamed } : { first: nameParts(p.name).first, last: callName(side, p, x.number) };
    var badges = el('div', { class: 'badges' });
    cardByPlayer[side + ':' + (p.apiId != null ? p.apiId : p.name)] = badges;
    var hover = function (what) { return { onmouseenter: function (e) { showPop(e.currentTarget, side, p, what); }, onmouseleave: hidePop }; };
    var fact = (p.funfacts && p.funfacts[0]) || p.linkLine || p.funfact;
    var left = side === 'home' ? spot.d : 1 - spot.d, top = side === 'home' ? spot.w : 1 - spot.w;
    var len = String(nm.last || '').length;
    var cards = el('span', { class: 'cell', onmouseenter: function (e) { showPop(e.currentTarget, side, p, 'yellow'); }, onmouseleave: hidePop }, [
      el('i', { text: '🟨 / 🟥' }), el('b', { text: s.apps != null ? (s.yellow || 0) + ' / ' + (s.red || 0) : '–' })
    ]);
    return el('div', { class: 'card ' + side + (spot.line >= 5 ? ' compact' : ''), style: 'left:' + (left * 100) + '%;top:' + (top * 100) + '%;width:' + cardWidth(spot.cols) + 'px;--team:' + c + ';--ink:' + ink(c), tabindex: '0',
      onclick: function () { openPlayer(side, p, x.number); }, onkeydown: function (e) { if (e.key === 'Enter') openPlayer(side, p, x.number); } }, [
      badges,
      el('div', { class: 'card-head' }, [
        el('div', { class: 'who' }, [el('span', { class: 'no', text: x.number != null ? x.number : '' }), el('span', { class: 'first', text: nm.first }),
          el('span', { class: 'last' + (len > 13 ? ' xlong' : len > 9 ? ' long' : ''), text: nm.last })]),
        avatar(p.photo, p.name)
      ]),
      el('div', { class: 'meta' }, [el('span', { class: 'nat', text: p.natTeam || p.nat || '—' }), el('span', { text: [p.age ? p.age + ' ani' : null, p.height ? p.height + ' cm' : null].filter(Boolean).join(' · ') })]),
      el('div', { class: 'grid' }, [
        statCell('MECI', s.apps), statCell('GOL', s.goals, hover('goals')), statCell('PASĂ', s.assists), cards,
        statCell('MIN', s.minutes), p.role === 'GK' ? statCell('PAR.', s.saves) : statCell('ȘUT', s.shotsOn), p.role === 'GK' ? statCell('PRIM.', s.conceded) : statCell('PAS%', s.passesAccuracy), statCell('NOTĂ', s.rating, null, 'rating')
      ]),
      fact ? el('div', { class: 'fact', text: fact }) : null
    ]);
  }
  function coachCard(side) {
    var c = d.teams[side].coach;
    if (!c || !has(c.name)) return null;
    return el('div', { class: 'coach ' + side, style: '--team:' + color(side) + ';--ink:' + ink(color(side)), onclick: function () { openCoach(side); } }, [
      el('div', {}, [el('span', { class: 'role', text: 'ANTRENOR' }), el('span', { class: 'last', text: nameParts(c.name).last }), el('span', { class: 'dim', text: [c.age ? c.age + ' ani' : null, c.tenureFrom ? 'din ' + String(c.tenureFrom).slice(0, 4) : null].filter(Boolean).join(' · ') })]),
      avatar(c.photo, c.name)
    ]);
  }
  function pitch() {
    var box = el('div', { class: 'pitch' }, [
      el('div', { class: 'line half' }), el('div', { class: 'line circle' }), el('div', { class: 'line area l' }), el('div', { class: 'line area r' }), el('div', { class: 'line goal l' }), el('div', { class: 'line goal r' })
    ]);
    ['home', 'away'].forEach(function (side) {
      var xi = xiOf(side), at = spots(xi, formationOf(side));
      xi.forEach(function (x, i) { if (at[i]) box.appendChild(playerCard(side, x, at[i])); });
      var c = coachCard(side); if (c) box.appendChild(c);
    });
    var r = referee();
    if (has(r.name)) box.appendChild(el('div', { class: 'ref', onclick: function () { drawer(r.name, 'Arbitru' + (r.country ? ' · ' + r.country : ''), refereeBody()); } }, [
      el('span', { class: 'role', text: 'ARBITRU' }), el('span', { class: 'last', text: r.name })
    ]));
    return box;
  }
  function benchRow(side) {
    var row = el('div', { class: 'bench ' + side });
    nodes['bench-' + side] = row;
    benchOf(side).forEach(function (x) {
      row.appendChild(el('button', { class: 'chip', style: '--team:' + color(side) + ';--ink:' + ink(color(side)), 'data-id': x.p.apiId, onclick: function () { openPlayer(side, x.p, x.number); } }, [
        el('b', { text: x.number != null ? x.number : '·' }), el('span', { text: x.renamed || callName(side, x.p, x.number) })
      ]));
    });
    return row;
  }
  function teamHead(side) {
    var t = d.teams[side], kind = lineupKind(side);
    var bits = [
      t.logo ? el('img', { class: 'crest', src: t.logo, alt: '' }) : null,
      el('div', { class: 'tn' }, [el('strong', { text: t.name }), el('span', { text: [formationOf(side), kind === 'confirmed' ? 'echipă oficială' : kind === 'predicted' ? 'echipă probabilă' : 'după minute jucate', changedByUser(side) ? 'modificată de tine' : null].filter(has).join(' · ') })])
    ];
    return el('div', { class: 'team-head ' + side, style: '--team:' + color(side) }, side === 'home' ? bits : bits.reverse());
  }

  function paintLive() {
    var f = live.fx, all = events();
    if (nodes.score) {
      nodes.score.textContent = f && f.home_goals != null ? f.home_goals + ' : ' + f.away_goals : 'vs';
      nodes.clock.textContent = clockText();
      nodes.clock.className = 'clock' + (f && !f.finished && /^(1H|2H|ET|P|HT|BT|LIVE)$/.test(f.status) ? ' on' : '');
      ['home', 'away'].forEach(function (side) {
        nodes['goals-' + side].textContent = all.filter(function (e) { return !e.removed && !e.mine && (e.kind === 'goal' || e.kind === 'owngoal') && e.side === side; })
          .map(function (e) { return (e.name ? shortOf(e.id, e.name) : '(neconfirmat)') + ' ' + minuteText(e) + (e.kind === 'owngoal' ? ' (ag)' : ''); }).join(', ');
      });
    }
    // marks on the cards and on the bench
    Object.keys(cardByPlayer).forEach(function (k) { cardByPlayer[k].textContent = ''; });
    [].forEach.call(board.querySelectorAll('.chip'), function (c) { c.classList.remove('on-pitch'); });
    var seen = {};
    all.forEach(function (e) {
      if (e.removed) return;
      function mark(id, name, text) {
        var node = null;
        ['home', 'away'].forEach(function (s) {
          xiOf(s).forEach(function (x) { if (!node && ((id != null && x.p.apiId === id) || (id == null && name && norm(x.p.name) === norm(name)))) node = cardByPlayer[s + ':' + (x.p.apiId != null ? x.p.apiId : x.p.name)]; });
        });
        // the same goal noted by the user and reported by the API is shown once
        var key = (id != null ? id : name) + '|' + text + '|' + e.minute;
        if (node && !seen[key]) { seen[key] = 1; node.appendChild(el('span', { class: e.mine ? 'mine' : null, text: text })); }
      }
      if (e.kind === 'sub') {
        mark(e.id, e.name, '▼' + minuteText(e));
        var chip = e.inId != null ? board.querySelector('.chip[data-id="' + e.inId + '"]') : null;
        if (chip) chip.classList.add('on-pitch');
      } else if (e.kind === 'goal' || e.kind === 'owngoal' || e.kind === 'yellow' || e.kind === 'red') mark(e.id, e.name, ICON[e.kind] + (e.kind === 'owngoal' ? 'ag' : ''));
    });
    // event list, newest first
    if (nodes.events) {
      nodes.events.textContent = '';
      if (!all.length) nodes.events.appendChild(el('div', { class: 'dim', text: f ? 'Niciun eveniment încă.' : 'Apar aici în timpul meciului.' }));
      all.slice().reverse().forEach(function (e) {
        nodes.events.appendChild(el('div', { class: 'ev' + (e.removed ? ' removed' : '') }, [
          el('i', { style: 'background:' + (e.side ? color(e.side) : '#666') }), el('b', { text: minuteText(e) }), el('span', { text: ICON[e.kind] || '•' }),
          el('span', { class: 'nm', text: e.kind === 'sub' ? '▲ ' + (e.inName ? shortOf(e.inId, e.inName) : '?') + '  ▼ ' + (e.name ? shortOf(e.id, e.name) : '?') : (e.name ? (e.kind === 'var' ? e.name : shortOf(e.id, e.name)) : 'fără jucător, neconfirmat') }),
          e.removed ? el('em', { text: 'anulat' }) : e.mine ? el('em', { text: 'tu' }) : null
        ]));
      });
    }
    // timeline
    if (nodes.line) {
      nodes.line.textContent = '';
      var end = Math.max(95, (f && f.elapsed || 0) + 3);
      [0, 15, 30, 45, 60, 75, 90].forEach(function (m) { nodes.line.appendChild(el('span', { class: 'tick', style: 'left:' + (100 * m / end) + '%', text: m + "'" })); });
      if (f && f.elapsed != null) nodes.line.appendChild(el('span', { class: 'progress', style: 'width:' + (100 * Math.min(end, f.elapsed) / end) + '%' }));
      all.forEach(function (e) {
        if (e.minute == null || e.kind === 'var') return;
        nodes.line.appendChild(el('span', { class: 'dot ' + (e.side || '') + (e.removed ? ' removed' : ''), style: 'left:' + (100 * Math.min(end, e.minute + (e.extra || 0)) / end) + '%;--team:' + (e.side ? color(e.side) : '#888'),
          title: minuteText(e) + ' ' + (e.name || '') + (e.removed ? ' (anulat)' : ''), text: ICON[e.kind] }));
      });
    }
  }

  function render() {
    cardByPlayer = {}; nodes = {}; xiCache = {};
    board.textContent = '';
    var comp = d.competition || {};
    nodes.score = el('div', { class: 'score', text: 'vs' });
    nodes.clock = el('div', { class: 'clock' });
    nodes['goals-home'] = el('div', { class: 'scorers home' });
    nodes['goals-away'] = el('div', { class: 'scorers away' });
    nodes.line = el('div', { class: 'line-track' });
    board.appendChild(el('nav', { class: 'menu' }, [
      el('a', { class: 'brand', href: 'index.html', title: 'Lista de meciuri' }, [el('strong', { text: 'MATCH CENTER' })]),
      el('div', { class: 'menu-items' }, MENU.map(function (m) { return el('button', { text: m[0], onclick: function () { drawer(m[0], d.teams.home.name + ' – ' + d.teams.away.name, m[1]()); } }); })),
      el('div', { class: 'menu-tools' }, [
        el('button', { title: 'Micșorează', text: 'A−', onclick: function () { setZoom(-1); } }),
        el('button', { title: 'Mărește textul și cardurile (apoi derulezi)', text: 'A+', onclick: function () { setZoom(1); } }),
        el('button', { title: 'Reîncarcă datele', text: '↻', onclick: load }),
        el('button', { title: 'Ecran complet', text: '⛶', onclick: function () { if (document.fullscreenElement) document.exitFullscreen(); else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen(); } }),
        el('div', { class: 'switch', role: 'group', 'aria-label': 'Format' }, [
          el('button', { text: 'Clasic', title: 'Pagina clasică a meciului (reține alegerea)', onclick: function () { try { localStorage.setItem('mc:view', 'classic'); } catch (e) {} location.href = 'match.html?m=' + encodeURIComponent(slug); } }),
          el('button', { class: 'on', text: 'Carduri', 'aria-pressed': 'true', onclick: function () { try { localStorage.setItem('mc:view', 'cards'); } catch (e) {} } })
        ])
      ])
    ]));
    board.appendChild(el('div', { class: 'scorebar' }, [
      teamHead('home'), nodes['goals-home'],
      el('div', { class: 'center' }, [el('div', { class: 'comp', text: [comp.name, comp.round].filter(has).join(' · ') }), nodes.score, nodes.clock]),
      nodes['goals-away'], teamHead('away')
    ]));
    board.appendChild(el('div', { class: 'benches' }, [benchRow('home'), benchRow('away')]));
    board.appendChild(el('div', { class: 'main' }, [leftColumn(), pitch(), rightColumn()]));
    board.appendChild(el('div', { class: 'timeline' }, [el('span', { class: 'tl-label', text: 'CRONOLOGIE' }), nodes.line]));
    paintLive();
  }

  /* ---------- fit the canvas to the window ---------- */
  // Height is always 960; the width follows the window (1560..2200), so a wide screen gets a wider pitch, not bars.
  function fit() {
    var w = Math.round(Math.max(1560, Math.min(2200, H * window.innerWidth / Math.max(1, window.innerHeight))));
    var changed = Math.abs(w - W) > 24;
    if (changed) W = w;
    // the zoom is the user's: above 100 % the board is larger than the window and scrolls
    scale = Math.max(0.45, Math.min(window.innerWidth / W, window.innerHeight / H)) * zoom;
    board.style.width = W + 'px';
    board.style.transform = 'scale(' + scale + ')';
    var st = document.getElementById('stage');
    st.style.width = (W * scale) + 'px';
    st.style.height = (H * scale) + 'px';
    return changed;
  }

  /* ---------- data ---------- */
  function inWindow() { var ko = fx && Date.parse(fx.kickoff); return !!ko && Date.now() > ko - 30 * 60000 && Date.now() < ko + 4 * 3600000; }
  function poll() {
    clearTimeout(live.timer);
    if (!fx || fx.eventId == null || !window.MC_COLLAB || !window.MC_COLLAB.fetchLive) return;
    var again = function () {
      if (inWindow() || (live.fx && !live.fx.finished)) live.timer = setTimeout(function () { if (document.hidden) again(); else poll(); }, 15000);
    };
    window.MC_COLLAB.fetchLive(fx.eventId).then(function (r) {
      if (r && r.ok) { live.fx = r.fixture; live.events = r.events || []; paintLive(); }
    }).catch(function () {}).then(again);
  }
  function message(text) { board.textContent = ''; board.appendChild(el('div', { class: 'loading' }, [text + ' ', el('a', { href: 'index.html', text: 'Lista de meciuri' })])); }
  function load() {
    if (!slug) { message('Lipsește meciul din adresă (cards.html?m=…).'); return; }
    Promise.all([
      fetch('data/fixtures.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : []; }),
      fetch('data/matches/' + encodeURIComponent(slug) + '.json', { cache: 'no-cache' }).then(function (r) { return r.ok ? r.json() : null; })
    ]).then(function (res) {
      fx = res[0].filter(function (f) { return f.slug === slug; })[0] || null;
      d = res[1];
      if (!d) { message('Meciul nu are încă pachet.'); return; }
      document.title = d.teams.home.name + ' – ' + d.teams.away.name + ' · Carduri';
      render();
      poll();
    }).catch(function () { message('Datele nu au putut fi citite.'); });
  }

  var resizeTimer = null;
  window.addEventListener('resize', function () { if (fit() && d) { clearTimeout(resizeTimer); resizeTimer = setTimeout(render, 150); } });
  window.addEventListener('keydown', function (e) { if (e.key === 'Escape') { closeDrawer(); hidePop(); } });
  // something changed on the classic page in another tab (line-up, numbers, noted events): draw it again
  window.addEventListener('storage', function (e) { if (d && e.key && e.key.indexOf('mc:' + slug) === 0) render(); });
  fit();
  load();
})();
