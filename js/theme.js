// js/theme.js  -  classic (blocking) script in <head> so the saved theme applies before first paint
(function () {
  try {
    var t = localStorage.getItem('myfiles.theme');
    if (t === 'dark' || t === 'light') document.documentElement.setAttribute('data-theme', t);
  } catch (e) { /* ignore */ }
})();
