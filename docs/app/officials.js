/* Reads an "Officials" block pasted by the user (e.g. copied by hand from a league's match sheet) into the referee and
   crew shown on the match page. Nothing is fetched: the text is whatever the user pasted. Accepted shapes, per person:
     Ruddy BUQUET            Ruddy Buquet (Main official)          VAR: Cyril Gringore
     (Main official)
   Roles are understood in English, French and Romanian. Lines without a recognised role are ignored, so pasting a
   bit too much of the page does no harm. Used by app/match.js; tested by tests/officials.test.mjs. */
(function (root) {
  'use strict';

  function plain(s) { return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[’']/g, ' ').replace(/\s+/g, ' ').trim(); }

  // -> 'main' | 'assistant' | 'reserve' | 'var' | 'avar' | 'observer' | 'delegate' | null
  function role(text) {
    var s = plain(text).replace(/[.:]+$/, '');
    if (!s || s.length > 60) return null;
    var has = function (re) { return re.test(s); };
    if (has(/\bavar\b|assistant video assistant|assistant (de l )?(arbitre )?video\b.*assist|adjoint.*video|video.*adjoint|asistent var\b|assistant var\b/)) return 'avar';
    if (has(/\bvar\b|\bvideo\b/)) return 'var';
    if (has(/\bfourth\b|\b4th\b|\bquatrieme\b|\b4e(me)? arbitre|\brezerva\b|\ba4\b/)) return 'reserve';
    if (has(/\bdelegates?\b|\bdelegue|\bdelegat\b/)) return has(/^delegates$|^delegues$/) ? null : 'delegate';
    if (has(/\bobserver\b|\bobservateur\b|\bobservator\b/)) return 'observer';
    if (has(/\bassistants?\b|\basistent\b|\btouche\b/)) return 'assistant';
    if (has(/\b(main|centre|center) (official|referee)\b|^referee$|^arbitre( central| principal)?$|^arbitru( central| principal)?$|\bmain official\b|\bmain referee\b/)) return 'main';
    return null;
  }

  var HEADING = /^(officials?|match officials|officiels|arbitres?|arbitrage|delegates|delegues|brigada|arbitri|informations?)$/;
  function looksLikeName(s) {
    var t = String(s || '').trim();
    return t.length >= 3 && t.length <= 60 && /[A-Za-zÀ-ɏ]{2}/.test(t) && !/\d|https?:|@|[()]/.test(t) && t.split(/\s+/).length <= 6 && !HEADING.test(plain(t));
  }
  function isName(s) { return looksLikeName(s) && !role(s); }
  // "Ruddy BUQUET" -> "Ruddy Buquet"; words already in mixed case are left as they are.
  function niceName(s) {
    return String(s).trim().replace(/\s+/g, ' ').replace(/[A-Za-zÀ-ɏ]+/g, function (w) {
      return w.length > 1 && w === w.toUpperCase() ? w.charAt(0) + w.slice(1).toLowerCase() : w;
    });
  }

  // -> { name: string|null, crew: { assistant1, assistant2, reserve, var, avar, observer, delegate }, count }
  function parse(text) {
    var people = [];
    var pending = null;
    var lines = String(text || '').split(/\r?\n/).map(function (l) { return l.replace(/\t+/g, ' ').trim(); }).filter(Boolean);
    lines.forEach(function (line, i) {
      var m, r;
      // the line above a role in brackets is the name, even if it happens to contain a role word
      var next = (lines[i + 1] || '').match(/^\(([^()]+)\)$/);
      if (next && role(next[1]) && looksLikeName(line)) { pending = line; return; }
      // a role alone, in brackets, under the name
      if ((m = line.match(/^\(([^()]+)\)$/)) && (r = role(m[1]))) {
        if (pending) people.push({ role: r, name: pending });
        pending = null; return;
      }
      // "Name (role)"
      if ((m = line.match(/^(.+?)\s*\(([^()]+)\)$/)) && (r = role(m[2])) && isName(m[1])) { people.push({ role: r, name: m[1] }); pending = null; return; }
      // "Role: Name" / "Role - Name"
      if ((m = line.match(/^([^:]{2,50}?)\s*(?::|\s[-–]\s)\s*(.+)$/)) && (r = role(m[1]))) {
        m[2].split(/\s*[,;]\s*/).forEach(function (n) { if (isName(n)) people.push({ role: r, name: n }); });
        pending = null; return;
      }
      // a role alone on its line, without brackets, under the name
      if ((r = role(line))) { if (pending) people.push({ role: r, name: pending }); pending = null; return; }
      pending = isName(line) ? line : null;
    });

    var out = { name: null, crew: {}, count: 0 };
    var assistants = 0;
    people.forEach(function (p) {
      var n = niceName(p.name);
      if (p.role === 'main') { if (!out.name) { out.name = n; out.count++; } return; }
      var key = p.role;
      if (key === 'assistant') { assistants++; if (assistants > 2) return; key = 'assistant' + assistants; }
      if (key === 'delegate' && out.crew.delegate) { out.crew.delegate += ', ' + n; out.count++; return; }
      if (!out.crew[key]) { out.crew[key] = n; out.count++; }
    });
    return out;
  }

  root.MC_OFFICIALS = { parse: parse, role: role };
})(typeof window !== 'undefined' ? window : globalThis);
