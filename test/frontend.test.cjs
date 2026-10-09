'use strict';
// Tests de las funciones puras del frontend (app/pure.js).
// Uso: node test/frontend.test.cjs
const path = require('path');
const { md, esc, displayTitle, partKey } = require(path.join(__dirname, '..', 'app', 'pure.js'));

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

console.log('\n' + pass + ' ok, ' + fail + ' fail');
process.exit(fail ? 1 : 0);
