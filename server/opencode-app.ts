import { existsSync, readFileSync } from 'fs'
import { join, extname, normalize } from 'path'
import * as http from 'http'
import type { IncomingMessage, ServerResponse } from 'http'
import { getSession, getSessionToken, clientIp, clientUa } from './auth.js'

const OC_HOST = process.env.OC_HOST || '127.0.0.1'
const OC_PORT = Number(process.env.OC_PORT || 4096)
const APP_DIR = process.env.APP_DIR || '/home/martin/terminal-celular/app'

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

export function isMobileClient(req: IncomingMessage): boolean {
  const ua = String(req.headers['user-agent'] || '').toLowerCase()
  return /android|iphone|ipad|ipod|mobile|windows phone/.test(ua)
}

function authed(req: IncomingMessage): boolean {
  try {
    const token = getSessionToken(req)
    if (!token) return false
    return !!getSession(token, clientIp(req), clientUa(req))
  } catch {
    return false
  }
}

// Allowlist: el navegador solo puede alcanzar los endpoints que la app usa.
// Cualquier otra ruta de la API de opencode queda bloqueada (403).
function allowedPath(targetPath: string): boolean {
  const p = targetPath.split('?')[0]
  if (p === '/agent' || p === '/event' || p === '/config/providers') return true
  if (p === '/session' || p.startsWith('/session/')) return true
  return false
}

// Quita credenciales (API keys) antes de devolver JSON al navegador.
function sanitize(obj: unknown): void {
  const scrub = (o: Record<string, unknown>): void => {
    for (const k of ['key', 'apiKey', 'api_key', 'token', 'password', 'secret']) {
      if (k in o) delete o[k]
    }
  }
  if (Array.isArray(obj)) {
    for (const p of obj) if (p && typeof p === 'object') scrub(p as Record<string, unknown>)
  } else if (obj && typeof obj === 'object') {
    const o = obj as Record<string, unknown>
    if (Array.isArray(o.providers)) {
      for (const p of o.providers) if (p && typeof p === 'object') scrub(p as Record<string, unknown>)
    }
    if (Array.isArray(o.all)) {
      for (const p of o.all) if (p && typeof p === 'object') scrub(p as Record<string, unknown>)
    }
  }
}

// Suscripción SSE persistente: mantiene un cliente conectado al stream de
// opencode para que nunca vea "0 clientes" cuando el teléfono se desconecta.
// Evita que un turno se aborte por client_disconnect. Desactivable con OC_KEEPALIVE=0.
const KEEPALIVE = process.env.OC_KEEPALIVE !== '0'
let persistent: http.ClientRequest | null = null
let persistentStopped = false

function ensurePersistent(): void {
  if (!KEEPALIVE || persistentStopped || persistent) return
  const preq = http.request(
    { host: OC_HOST, port: OC_PORT, path: '/event', method: 'GET', headers: { accept: 'text/event-stream' } },
    (pres) => {
      pres.on('data', () => {})
      pres.on('end', () => { persistent = null; if (!persistentStopped) setTimeout(ensurePersistent, 2000) })
      pres.on('error', () => { persistent = null })
    }
  )
  preq.on('socket', (s) => { try { s.unref() } catch {} })
  preq.on('error', () => { persistent = null; if (!persistentStopped) setTimeout(ensurePersistent, 2000) })
  preq.end()
  persistent = preq
}

ensurePersistent()

// Cierra la suscripción persistente para que el proceso pueda salir limpio.
export function stopPersistent(): void {
  persistentStopped = true
  if (persistent) {
    try { persistent.destroy() } catch {}
    persistent = null
  }
}

function serveApp(res: ServerResponse, urlPath: string): void {
  let rel = urlPath.replace(/^\/app\/?/, '')
  if (rel === '') rel = 'index.html'
  const safe = normalize(rel).replace(/^(\.\.(\/|\\|$))+/, '')
  const full = join(APP_DIR, safe)
  if (!full.startsWith(APP_DIR) || !existsSync(full)) {
    const idx = join(APP_DIR, 'index.html')
    if (existsSync(idx)) {
      res.writeHead(200, { 'content-type': MIME['.html'] })
      res.end(readFileSync(idx))
      return
    }
    res.writeHead(404)
    res.end('Not found')
    return
  }
  const type = MIME[extname(full).toLowerCase()] || 'application/octet-stream'
  res.writeHead(200, { 'content-type': type, 'cache-control': 'no-cache' })
  res.end(readFileSync(full))
}

function proxy(req: IncomingMessage, res: ServerResponse, targetPath: string): void {
  const headers: http.OutgoingHttpHeaders = { ...(req.headers as Record<string, unknown>), host: `${OC_HOST}:${OC_PORT}` }
  delete headers['accept-encoding']
  const preq = http.request(
    { host: OC_HOST, port: OC_PORT, path: targetPath, method: req.method, headers },
    (pres) => {
      const ct = String(pres.headers['content-type'] || '')
      const isSSE = ct.includes('text/event-stream')
      const outHeaders: http.OutgoingHttpHeaders = { ...pres.headers }
      if (isSSE) {
        outHeaders['cache-control'] = 'no-cache'
        outHeaders['x-accel-buffering'] = 'no'
      }
      if (ct.includes('application/json')) {
        const chunks: Buffer[] = []
        pres.on('data', (c) => chunks.push(c as Buffer))
        pres.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            sanitize(data)
            const body = Buffer.from(JSON.stringify(data))
            outHeaders['content-length'] = String(body.length)
            res.writeHead(pres.statusCode || 200, outHeaders)
            res.end(body)
          } catch {
            res.writeHead(pres.statusCode || 200, outHeaders)
            res.end(Buffer.concat(chunks))
          }
        })
        return
      }
      res.writeHead(pres.statusCode || 502, outHeaders)
      if (isSSE) res.flushHeaders()
      pres.pipe(res)
    }
  )
  preq.on('error', () => {
    if (!res.headersSent) res.writeHead(502)
    res.end('proxy error')
  })
  // Cierre limpio: si el cliente se va, corta el upstream (evita fugas y el
  // "Unexpected EOF" del server). La suscripción persistente sigue viva.
  res.on('close', () => { if (!preq.destroyed) preq.destroy() })
  req.pipe(preq)
}

export function handleAppRequest(req: IncomingMessage, res: ServerResponse, url: URL, path: string): boolean {
  if (path === '/app' || path.startsWith('/app/')) {
    if (!authed(req)) {
      res.writeHead(302, { Location: '/auth/login' })
      res.end()
      return true
    }
    serveApp(res, path)
    return true
  }
  if (path === '/oc' || path.startsWith('/oc/')) {
    if (!authed(req)) {
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end('{"error":"unauthorized"}')
      return true
    }
    const rest = path.replace(/^\/oc/, '') + (url.search || '')
    if (!allowedPath(rest)) {
      res.writeHead(403, { 'content-type': 'application/json' })
      res.end('{"error":"forbidden"}')
      return true
    }
    proxy(req, res, rest || '/')
    return true
  }
  return false
}
