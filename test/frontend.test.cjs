'use strict';
// Tests de las funciones puras del frontend (app/pure.js).
// Uso: node test/frontend.test.cjs
const path = require('path');
const vm = require('vm');
const { readFileSync } = require('fs');
const ctx = vm.createContext({});
vm.runInContext(readFileSync(path.join(__dirname, '..', 'app', 'pure.js'), 'utf8'), ctx, { filename: 'pure.js' });
const { md, esc, displayTitle, partKey, humanSize } = ctx;

let pass = 0;
let fail = 0;
function check(name, ok) {
  if (ok) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name); }
}

check('esc escapa < > " \'', esc('<a "x">&\'') === '&lt;a &quot;x&quot;&gt;&amp;&#39;');
check('md inline code', md('hola `x`') === 'hola <code>x</code>');
check('md bold', md('**b**') === '<strong>b</strong>');
check('md fence', md('```js\nconst a=1\n```') === '<pre class="code">const a=1</pre>');
check('md vacío', md('') === '');
check('displayTitle vacío', displayTitle({ title: '' }) === 'Nuevo chat');
check('displayTitle default de opencode', displayTitle({ title: 'New session - 2026-01-01' }) === 'Nuevo chat');
check('displayTitle real', displayTitle({ title: 'Hola mundo' }) === 'Hola mundo');
check('partKey por id', partKey({ id: 'p1' }) === 'p1');
check('partKey por callID', partKey({ type: 'tool', callID: 'c1' }) === 'tool:c1');
check('humanSize bytes', humanSize(512) === '512 B');
check('humanSize KB', humanSize(2048) === '2 KB');
check('humanSize MB', humanSize(3 * 1024 * 1024) === '3.0 MB');

console.log('\n' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
