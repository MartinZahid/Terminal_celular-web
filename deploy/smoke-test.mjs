// Smoke test E2E de la capa de proxy de Terminal Celular.
//
// Uso:
//   node deploy/smoke-test.mjs
//
// Variables (opcionales):
//   WTS_DIR   directorio del proyecto Whatsapp-teamSync (default /home/martin/Whatsapp-teamSync)
//   EMAIL     email autorizado para crear la sesión de prueba
//
// El almacén de sesiones de WTS es en memoria y por proceso, así que este test
// levanta un servidor HTTP efímero que usa el MISMO módulo handleAppRequest y
// crea la sesión en el mismo proceso. Así prueba auth, allowlist, saneo de
// credenciales, CRUD de sesiones y SSE real contra `opencode serve`.
//
// La cadena completa (coffecode-web :8080 -> WTS :3001) requiere una sesión
// iniciada con Google; se comprueba aparte con una petición sin cookie (302/401).

import http from 'http'

const WTS_DIR = process.env.WTS_DIR || '/home/martin/Whatsapp-teamSync'
const EMAIL = process.env.EMAIL || 'martinzahidpro@gmail.com'
const UA = 'tc-smoke'
const OC_HOST = process.env.OC_HOST || '127.0.0.1'
const OC_PORT = Number(process.env.OC_PORT || 4096)
const FRONT = process.env.FRONT || 'http://127.0.0.1:8080'

process.env.DB_PATH = process.env.DB_PATH || WTS_DIR + '/server/data/metrics.db'
process.env.APP_DIR = process.env.APP_DIR || '/home/martin/terminal-celular/app'

const auth = await import(WTS_DIR + '/server/dist/server/src/auth.js')
const { handleAppRequest } = await import(WTS_DIR + '/server/dist/server/src/opencode-app.js')

let pass = 0
let fail = 0
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name + (extra ? ' -> ' + extra : '')) }
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url || '/', 'http://localhost')
  if (handleAppRequest(req, res, url, url.pathname)) return
  res.writeHead(404)
  res.end('not found')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const BASE = 'http://127.0.0.1:' + server.address().port

function req(path, opts = {}) {
  return fetch(BASE + path, { ...opts, headers: { 'user-agent': UA, ...(opts.headers || {}) } })
}

async function sseFirstEvent(cookie) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), 6000)
  try {
    const r = await fetch(BASE + '/oc/event', { headers: { cookie, 'user-agent': UA }, signal: ac.signal })
    const reader = r.body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buf += dec.decode(value, { stream: true })
      if (buf.includes('\n')) break
    }
    return { status: r.status, ct: r.headers.get('content-type') || '', buf }
  } finally {
    clearTimeout(t)
    ac.abort()
  }
}

const token = auth.createSession(EMAIL, '127.0.0.1', UA)
const cookie = auth.sessionCookie(token, false).split(';')[0]

console.log('Proxy en ' + BASE + '  ->  opencode ' + OC_HOST + ':' + OC_PORT)

try {
  // Sin sesión
  const anonApp = await req('/app', { redirect: 'manual' })
  check('/app sin sesión -> 302', anonApp.status === 302, 'status ' + anonApp.status)
  const anonOc = await req('/oc/session')
  check('/oc sin sesión -> 401', anonOc.status === 401, 'status ' + anonOc.status)

  // App autenticada
  const app = await req('/app', { headers: { cookie }, redirect: 'manual' })
  const appBody = await app.text()
  check('/app con sesión -> 200 html', app.status === 200 && (app.headers.get('content-type') || '').includes('text/html'), 'status ' + app.status)
  check('/app sirve el shell (#chat)', appBody.includes('id="chat"'))

  // Endpoints permitidos
  const agents = await req('/oc/agent', { headers: { cookie } })
  check('/oc/agent -> 200', agents.status === 200, 'status ' + agents.status)

  const prov = await req('/oc/config/providers', { headers: { cookie } })
  const provData = await prov.json().catch(() => ({}))
  const leaked = (provData.providers || []).some((p) => p && 'key' in p)
  check('/oc/config/providers sin API keys', prov.status === 200 && !leaked, 'status ' + prov.status + ' leaked=' + leaked)

  // Allowlist
  const b1 = await req('/oc/provider', { headers: { cookie } })
  check('/oc/provider -> 403', b1.status === 403, 'status ' + b1.status)
  const b2 = await req('/oc/config', { headers: { cookie } })
  check('/oc/config -> 403', b2.status === 403, 'status ' + b2.status)

  // CRUD de sesiones
  const created = await req('/oc/session', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ title: 'smoke-test' }) })
  const sess = await created.json().catch(() => ({}))
  check('POST /oc/session -> 200', created.status === 200 && !!sess.id, 'status ' + created.status)

  const list = await req('/oc/session', { headers: { cookie } })
  const arr = await list.json().catch(() => [])
  check('GET /oc/session incluye la nueva', list.status === 200 && Array.isArray(arr) && arr.some((s) => s.id === sess.id))

  if (sess.id) {
    const msgs = await req('/oc/session/' + sess.id + '/message?limit=5', { headers: { cookie } })
    check('GET /oc/session/{id}/message -> 200', msgs.status === 200, 'status ' + msgs.status)

    try {
      const sse = await sseFirstEvent(cookie)
      const isEvent = /(^|\n)data:\s*\{/.test(sse.buf)
      check('/oc/event -> text/event-stream + evento', sse.status === 200 && sse.ct.includes('text/event-stream') && isEvent, 'ct=' + sse.ct)
    } catch (e) {
      check('/oc/event -> text/event-stream + evento', false, String(e && e.message))
    }

    const del = await req('/oc/session/' + sess.id, { method: 'DELETE', headers: { cookie } })
    check('DELETE /oc/session/{id} -> 200', del.status === 200, 'status ' + del.status)
  }

  // Cadena frontal (coffecode-web) reachability, sin sesión
  if (FRONT) {
    try {
      const f1 = await fetch(FRONT + '/app', { redirect: 'manual' })
      const f2 = await fetch(FRONT + '/oc/session')
      check('frontal /app sin sesión -> 302', f1.status === 302, 'status ' + f1.status)
      check('frontal /oc sin sesión -> 401', f2.status === 401, 'status ' + f2.status)
    } catch (e) {
      check('frontal alcanzable', false, String(e && e.message))
    }
  }
} finally {
  auth.destroySession(token)
  server.close()
}

console.log('\n' + pass + ' ok, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
