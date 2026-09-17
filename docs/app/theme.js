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

  window.MC_THEME = { THEMES: THEMES.slice(), getTheme: getTheme, setTheme: setTheme, toggleEl: toggleEl };
})();
