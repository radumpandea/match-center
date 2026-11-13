/* Match Center — light/dark background toggle. All colours in match.css and
   index.html's inline <style> are driven by CSS variables under :root, with a
   second set of values under :root[data-theme="light"] — so switching themes
   is just flipping the `data-theme` attribute on <html>, no re-render needed.
   The choice persists in localStorage (key `mc:theme`) and is shared across
   index.html / match.html, same pattern as app/i18n.js's language switcher.
   A tiny inline script in each page's <head> applies the stored/detected
   theme before first paint, so this file only needs to expose the toggle. */
(function () {
  'use strict';

  var THEMES = ['dark', 'light'];

  function readStored() {
    try { return localStorage.getItem('mc:theme'); } catch (e) { return null; }
  }
  function detectDefault() {
    try {
      return (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) ? 'light' : 'dark';
    } catch (e) { return 'dark'; }
  }

  var current = readStored();
  if (THEMES.indexOf(current) < 0) current = detectDefault();
  document.documentElement.setAttribute('data-theme', current);

  function getTheme() { return current; }
  function setTheme(theme) {
    if (THEMES.indexOf(theme) < 0) return;
    current = theme;
    try { localStorage.setItem('mc:theme', theme); } catch (e) {}
    document.documentElement.setAttribute('data-theme', theme);
  }

  // Small reusable toggle button, mirroring app/i18n.js's switcherEl(): the
  // label describes the action (switch to the OTHER theme), not the state.
  function toggleEl(onChange) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'mc-theme-toggle';
    function draw() {
      var t = (window.MC_I18N && window.MC_I18N.t) || function (k, v) { return k; };
      btn.textContent = current === 'light' ? '🌙' : '☀️';
      btn.title = current === 'light' ? t('theme.toDark') : t('theme.toLight');
      btn.setAttribute('aria-label', btn.title);
    }
    draw();
    btn.onclick = function () {
      setTheme(current === 'light' ? 'dark' : 'light');
      draw();
      if (onChange) onChange(current);
    };
    return btn;
  }

  // Visual style ("skin"): default | studio | paper (app/skins.css). Stored in localStorage `mc:skin`.
  var SKINS = ['default', 'studio', 'paper'];
  var skin = 'default';
  try { var sv = localStorage.getItem('mc:skin'); if (SKINS.indexOf(sv) >= 0) skin = sv; } catch (e) {}
  function applySkin() {
    if (skin === 'default') document.documentElement.removeAttribute('data-skin');
    else document.documentElement.setAttribute('data-skin', skin);
  }
  applySkin();
  function skinEl() {
    var t = (window.MC_I18N && window.MC_I18N.t) || function (k) { return k; };
    var sel = document.createElement('select');
    sel.className = 'mc-skin';
    sel.title = t('skin.title');
    sel.setAttribute('aria-label', t('skin.title'));
    SKINS.forEach(function (k) {
      var o = document.createElement('option');
      o.value = k; o.textContent = t('skin.' + k);
      if (k === skin) o.selected = true;
      sel.appendChild(o);
    });
    sel.onchange = function () {
      skin = sel.value;
      try { localStorage.setItem('mc:skin', skin); } catch (e) {}
      applySkin();
    };
    return sel;
  }

  window.MC_THEME = { THEMES: THEMES.slice(), getTheme: getTheme, setTheme: setTheme, toggleEl: toggleEl, skinEl: skinEl };
})();
