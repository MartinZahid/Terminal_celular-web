// Servicio independiente de Terminal Celular: app movil (PWA), proxy /oc y /oc2,
// auth Google + PIN y terminal xterm (PTY). Servicio independiente.

import { WebSocketServer, WebSocket } from 'ws'
import { createServer, IncomingMessage, ServerResponse } from 'http'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  authorizeUrl, exchangeCode, createSession, getSession, destroySession, destroyAllSessions,
  getSessionToken, rotateSession, sessionCookie, clearSessionCookie, stateCookie, newState,
  verifyState, isAllowedUser, isOAuthConfigured, ALLOWED_EMAIL, clientIp, clientUa,
  rateLimit, pinConfigured, verifyPin, resetPinFails, registerPinFail, pinBlockRemaining, setPin,
  isTerminalDisabled, setTerminalDisabled, audit, pruneAuth
} from './auth.js'
import { attachTerminal, closeAllTerminals, terminalMachines, TerminalMachineId } from './terminal.js'
import { handleAppRequest, isMobileClient, stopPersistent } from './opencode-app.js'

const PORT = Number(process.env.PORT) || 3100
const HOST = process.env.HOST || '127.0.0.1'
const APP_DIR = process.env.APP_DIR || join(process.env.HOME || '.', 'terminal-celular', 'app')

// Lee un cuerpo JSON pequeño (para /auth/verify-pin y /auth/set-pin)
function readBody(req: IncomingMessage, limit: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk: Buffer) => {
      data += chunk
      if (data.length > limit) {
        req.destroy()
        reject(new Error('body too large'))
        return
      }
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url || '/', `http://${req.headers.host}`)
  const path = url.pathname
  const isSecure = req.headers['x-forwarded-proto'] === 'https' || (req.url || '').startsWith('https')
  const ip = clientIp(req)
  const ua = clientUa(req)

  // --- OAuth routes (Terminal) ---
  if (path === '/auth/login') {
    if (!isOAuthConfigured()) {
      res.writeHead(503, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('OAuth de Google no configurado (falta google-oauth.json en DATA_DIR)')
      return
    }
    if (!rateLimit(ip, 'login', 10, 10 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Demasiados intentos. Espera unos minutos.')
      return
    }
    const state = newState()
    res.setHeader('Set-Cookie', stateCookie(state))
    res.writeHead(302, { Location: authorizeUrl(state) })
    res.end()
    return
  }

  if (path === '/auth/callback') {
    if (!rateLimit(ip, 'callback', 20, 10 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'text/plain; charset=utf-8' })
      res.end('Demasiados intentos. Espera unos minutos.')
      return
    }
    const code = url.searchParams.get('code')
    const state = url.searchParams.get('state')
    const user = code && verifyState(state) ? await exchangeCode(code) : null
    if (!user || !isAllowedUser(user)) {
      audit('login_denied', user?.email ?? null, ip, ua)
      res.writeHead(403, { 'Content-Type': 'text/html; charset=utf-8' })
      res.end('<!doctype html><meta charset="utf-8"><title>Acceso denegado</title><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh"><div style="text-align:center"><h1>Acceso denegado</h1><p>Solo la cuenta autorizada puede entrar.<br><a href="/auth/login" style="color:#7cfc5a">Intentar con otra cuenta</a></p></div></body>')
      return
    }
    const token = createSession(user.email, ip, ua)
    audit('login_ok', user.email, ip, ua)
    res.setHeader('Set-Cookie', sessionCookie(token, isSecure))
    res.writeHead(302, { Location: '/terminal' })
    res.end()
    return
  }

  if (path === '/auth/logout') {
    const token = getSessionToken(req)
    destroySession(token)
    res.setHeader('Set-Cookie', clearSessionCookie(isSecure))
    res.writeHead(302, { Location: '/' })
    res.end()
    return
  }

  if (path === '/auth/logout-all') {
    if (!getSession(getSessionToken(req), ip, ua)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    destroyAllSessions()
    audit('logout_all', undefined, ip, ua)
    res.setHeader('Set-Cookie', clearSessionCookie(isSecure))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (path === '/auth/me') {
    if (!rateLimit(ip, 'me', 60, 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ authenticated: false, rateLimited: true }))
      return
    }
    const token = getSessionToken(req)
    const session = getSession(token, ip, ua)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      authenticated: !!session,
      email: session?.email ?? null,
      pinVerified: session?.pinVerified ?? false,
      pinConfigured: pinConfigured(),
      enabled: !isTerminalDisabled(),
      sessionToken: token || null
    }))
    return
  }

  if (path === '/auth/verify-pin' && req.method === 'POST') {
    if (!rateLimit(ip, 'pin', 10, 15 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, tooMany: true }))
      return
    }
    const session = getSession(getSessionToken(req), ip, ua)
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: 'Sesión no válida' }))
      return
    }
    if (pinBlockRemaining(ip) > 0) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, blocked: Math.ceil(pinBlockRemaining(ip) / 1000) }))
      return
    }
    let pin = ''
    try { pin = String(JSON.parse(await readBody(req, 1024)).pin || '') } catch { /* no body */ }
    if (!verifyPin(pin)) {
      registerPinFail(ip)
      audit('pin_failed', session.email, ip, ua)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, blocked: Math.ceil(pinBlockRemaining(ip) / 1000) }))
      return
    }
    resetPinFails(ip)
    const token = getSessionToken(req)
    const newToken = token ? rotateSession(token, ip, ua) : null
    audit('pin_ok', session.email, ip, ua)
    res.setHeader('Set-Cookie', newToken ? sessionCookie(newToken, isSecure) : clearSessionCookie(isSecure))
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (path === '/auth/set-pin' && req.method === 'POST') {
    if (!rateLimit(ip, 'setpin', 5, 10 * 60 * 1000)) {
      res.writeHead(429, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, tooMany: true }))
      return
    }
    const session = getSession(getSessionToken(req), ip, ua)
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: 'Sesión no válida' }))
      return
    }
    if (!session.pinVerified) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: 'PIN no verificado' }))
      return
    }
    let current = ''
    let pin = ''
    try {
      const body = JSON.parse(await readBody(req, 1024))
      current = String(body.current || '')
      pin = String(body.pin || '')
    } catch { /* no body */ }
    if (!verifyPin(current)) {
      registerPinFail(ip)
      audit('pin_change_failed', session.email, ip, ua)
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    if (!/^\d{4,12}$/.test(pin)) {
      res.writeHead(400, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false, message: 'El PIN debe ser numérico (4-12 dígitos)' }))
      return
    }
    setPin(pin)
    audit('pin_changed', session.email, ip, ua)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true }))
    return
  }

  if (path === '/auth/terminal-off' || path === '/auth/terminal-on') {
    const session = getSession(getSessionToken(req), ip, ua)
    if (!session || !session.pinVerified) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: false }))
      return
    }
    const off = path === '/auth/terminal-off'
    setTerminalDisabled(off)
    audit(off ? 'terminal_off' : 'terminal_on', session.email, ip, ua)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ ok: true, enabled: !off }))
    return
  }

  // --- App movil (PWA) + proxy /oc y /oc2 ---
  if (handleAppRequest(req, res, url, path)) return

  // --- Terminal: lista de máquinas (selector Principal/Secundaria) ---
  if (path === '/terminal/machines') {
    const session = getSession(getSessionToken(req), ip, ua)
    if (!session) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'no auth' }))
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
    res.end(JSON.stringify(terminalMachines()))
    return
  }

  // --- Terminal page (xterm) ---
  if (path === '/terminal' || path === '/terminal/') {
    if (isMobileClient(req)) { res.writeHead(302, { Location: '/app' }); res.end(); return }
    const session = getSession(getSessionToken(req), ip, ua)
    try {
      let content: Buffer
      if (session) {
        content = readFileSync(join(APP_DIR, 'terminal.html'))
      } else {
        content = Buffer.from(`<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terminal</title><body style="font-family:sans-serif;background:#111;color:#eee;display:grid;place-items:center;min-height:100vh;margin:0"><div style="text-align:center"><h1>Terminal bloqueada</h1><a href="/auth/login" style="display:inline-block;margin-top:16px;padding:12px 24px;background:#4285F4;color:#fff;border-radius:8px;text-decoration:none">Entrar con Google</a></div></body></html>`)
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(content)
    } catch {
      res.writeHead(500, { 'Content-Type': 'text/plain' })
      res.end('Error interno')
    }
    return
  }

  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end('Not found')
})

// --- WebSocket attached to HTTP server ---
// perMessageDeflate OFF: el proxy de coffecode-web reconstruye el 101 y elimina
// Sec-WebSocket-Extensions; con deflate el navegador aborta (código 1002).
const wss = new WebSocketServer({ server: httpServer })

console.log(`[Terminal] Starting HTTP + WebSocket server on ${HOST}:${PORT}...`)

// Prune expired sessions / rate buckets / pin blocks
setInterval(() => { pruneAuth() }, 60_000)

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const sock = req.socket
  if (sock && typeof sock.setNoDelay === 'function') sock.setNoDelay(true)

  const reqUrl = new URL(req.url || '/', 'http://localhost')
  const wsPath = reqUrl.pathname

  if (wsPath !== '/terminal/ws') { ws.close(); return }

  const ip = clientIp(req)
  const ua = clientUa(req)
  const token = getSessionToken(req)
  const session = getSession(token, ip, ua)
  console.log(`[Terminal] ws machine=${reqUrl.searchParams.get('machine') || 'local'} auth=${session ? 'ok' : 'no'}`)
  if (!session || session.email !== ALLOWED_EMAIL) {
    ws.send('\r\n[Terminal] No autenticado. Vuelve a /auth/login\r\n')
    ws.close()
    return
  }
  if (isTerminalDisabled()) {
    ws.send('\r\n[Terminal] Terminal deshabilitada. Actívala desde la página.\r\n')
    ws.close()
    return
  }
  const requested = reqUrl.searchParams.get('machine')
  const machine: TerminalMachineId = terminalMachines().some((m) => m.id === requested)
    ? (requested as TerminalMachineId)
    : 'local'
  audit('terminal_session_open', session.email, ip, ua)
  const sessionKey = `${token || `ip:${ip}`}:${machine}`
  attachTerminal(ws, sessionKey, machine)
  const ka = setInterval(() => {
    if (ws.readyState === WebSocket.OPEN) ws.ping()
    else clearInterval(ka)
  }, 30000)
  ws.on('close', () => clearInterval(ka))
})

wss.on('error', (error) => { console.error('[Terminal] WS server error:', error) })

// Graceful shutdown
function shutdown() {
  console.log('[Terminal] Shutting down...')
  try { stopPersistent() } catch { /* ignore */ }
  try { closeAllTerminals() } catch { /* ignore */ }
  try { wss.clients.forEach((c) => c.terminate()) } catch { /* ignore */ }
  wss.close(() => httpServer.close(() => process.exit(0)))
  setTimeout(() => process.exit(0), 800).unref()
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

httpServer.listen(PORT, HOST, () => {
  console.log(`[Terminal] listening on http://${HOST}:${PORT}`)
})
