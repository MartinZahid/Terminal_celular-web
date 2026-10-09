// Suite de integración de handleAppRequest contra un upstream FALSO que
// simula opencode (no hace falta que opencode esté corriendo).
// Uso: node test/proxy.test.mjs
// Requiere el WTS compilado (server/dist); ubícalo con $WTS_DIR o ~/Whatsapp-teamSync.
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const WTS = process.env.WTS_DIR || path.join(os.homedir(), 'Whatsapp-teamSync')

// --- Upstream falso: registra lo que recibe y responde como opencode ---
const calls = []
const upstream = http.createServer((req, res) => {
  calls.push({ path: req.url, headers: req.headers })
  if (req.url.startsWith('/event')) {
    res.writeHead(200, { 'content-type': 'text/event-stream' })
    res.write('data: {"type":"server.connected"}\n\n')
    res.end()
    return
  }
  if (req.url.startsWith('/config/providers')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ providers: [{ id: 'a', key: 'SECRET', options: { apiKey: 'X', baseURL: 'u' } }] }))
    return
  }
  if (req.url.startsWith('/session')) {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.write(JSON.stringify([{ id: 's1', title: 't' }])) // chunked (sin content-length)
    res.end()
    return
  }
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end('{}')
})
await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
const UP_PORT = upstream.address().port

// --- Env ANTES de importar el módulo (lee OC_*/APP_DIR/DB_PATH al cargar) ---
process.env.OC_KEEPALIVE = '0' // no abrir la suscripción persistente a opencode
process.env.OC_HOST = '127.0.0.1'
process.env.OC_PORT = String(UP_PORT)
process.env.OC_PASSWORD = 'testpw'
process.env.APP_DIR = path.join(__dirname, '..', 'app')
process.env.DB_PATH = path.join(os.tmpdir(), 'tc-proxy-test-' + process.pid + '.db')
delete process.env.ALLOWED_ORIGINS

const auth = await import(pathToFileURL(path.join(WTS, 'server/dist/server/src/auth.js')).href)
const { handleAppRequest } = await import(pathToFileURL(path.join(WTS, 'server/dist/server/src/opencode-app.js')).href)

const EMAIL = 'test@example.com'
const UA = 'tc-proxy-test'
const token = auth.createSession(EMAIL, '127.0.0.1', UA)
const sess = auth.getSession(token, '127.0.0.1', UA)
if (sess) sess.pinVerified = true
const COOKIE = auth.sessionCookie(token, false).split(';')[0]

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://' + (req.headers.host || 'x'))
  if (handleAppRequest(req, res, url, url.pathname)) return
  res.writeHead(404)
  res.end('nope')
})
await new Promise((r) => server.listen(0, '127.0.0.1', r))
const PORT = server.address().port

function call(pathname, opts = {}) {
  return new Promise((resolve, reject) => {
    const headers = { 'user-agent': UA, ...(opts.headers || {}) }
    if (opts.cookie) headers.cookie = COOKIE
    const req = http.request(
      { host: '127.0.0.1', port: PORT, path: pathname, method: opts.method || 'GET', headers },
      (res) => {
        let body = ''
        res.on('data', (c) => (body += c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
      }
    )
    req.on('error', reject)
    if (opts.body) req.write(opts.body)
    req.end()
  })
}

let pass = 0
let fail = 0
function check(name, ok) {
  if (ok) { pass++; console.log('  ok   ' + name) }
  else { fail++; console.log('  FAIL ' + name) }
}

try {
  let r = await call('/oc/session')
  check('/oc sin sesión -> 401', r.status === 401)

  r = await call('/oc/provider', { cookie: true })
  check('/oc/provider (fuera de allowlist) -> 403', r.status === 403)

  r = await call('/oc/session', { method: 'POST', cookie: true, headers: { origin: 'https://evil.example' }, body: '{}' })
  check('CSRF origen ajeno -> 403', r.status === 403)

  r = await call('/oc/session', { method: 'POST', cookie: true, headers: { origin: 'http://127.0.0.1:' + PORT }, body: '{}' })
  check('CSRF mismo origen -> 200', r.status === 200)

  calls.length = 0
  r = await call('/oc/session', { cookie: true, headers: { 'accept-encoding': 'gzip' } })
  check('GET /oc/session -> 200', r.status === 200)
  const last = calls[calls.length - 1]
  check('reenvía Basic a opencode', !!last && last.headers.authorization === 'Basic ' + Buffer.from('opencode:testpw').toString('base64'))
  check('NO reenvía la cookie a opencode', !!last && last.headers.cookie === undefined)
  check('elimina accept-encoding', !!last && last.headers['accept-encoding'] === undefined)

  check('respuesta chunked con content-length', r.headers['content-length'] !== undefined && r.headers['transfer-encoding'] === undefined)
  check('body JSON parseable', (() => { try { JSON.parse(r.body); return true } catch { return false } })())

  r = await call('/oc/config/providers', { cookie: true })
  check('/config/providers sin secretos', r.status === 200 && !r.body.includes('SECRET') && !r.body.includes('apiKey'))

  r = await call('/app')
  check('/app sin sesión -> 302', r.status === 302)
  r = await call('/app', { cookie: true })
  check('/app con sesión -> 200 html', r.status === 200 && r.body.includes('id="chat"'))

  r = await call('/oc/event', { cookie: true })
  check('/oc/event -> 200 SSE', r.status === 200 && String(r.headers['content-type']).includes('text/event-stream') && r.body.includes('server.connected'))
} finally {
  await new Promise((r) => server.close(r))
  await new Promise((r) => upstream.close(r))
  try { fs.rmSync(process.env.DB_PATH, { force: true }) } catch {}
}

console.log('\n' + pass + ' ok, ' + fail + ' fail')
process.exit(fail ? 1 : 0)
