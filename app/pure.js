'use strict';
// Funciones puras de la app (sin DOM), compartidas con los tests.
(function (root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else for (const k in api) root[k] = api[k];
})(typeof self !== 'undefined' ? self : this, function () {
  function esc(s) {
    return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(ts) {
    if (!ts) return '';
    try {
      return new Date(ts).toLocaleString([], { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return ''; }
  }
  function md(raw) {
    if (!raw) return '';
    const parts = String(raw).split(/```/);
    let out = '';
    for (let i = 0; i < parts.length; i++) {
      if (i % 2 === 1) {
        let code = parts[i];
        const nl = code.indexOf('\n');
        if (nl > -1) code = code.slice(nl + 1);
        out += '<pre class="code">' + esc(code.replace(/\n$/, '')) + '</pre>';
      } else {
        let t = esc(parts[i]);
        t = t.replace(/`([^`\n]+)`/g, '<code>$1</code>');
        t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
        out += t;
      }
    }
    return out;
  }
  function displayTitle(s) {
    const t = s && s.title ? String(s.title) : '';
    if (!t || /^new session - /i.test(t)) return 'Nuevo chat';
    return t;
  }
  function partKey(part) {
    return part.id || (part.type + ':' + (part.callID || ''));
  }
  return { esc, fmtTime, md, displayTitle, partKey };
});
