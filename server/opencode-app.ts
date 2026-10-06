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
      if (targetPath.split('?')[0] === '/config/providers' && ct.includes('application/json')) {
        const chunks: Buffer[] = []
        pres.on('data', (c) => chunks.push(c as Buffer))
        pres.on('end', () => {
          try {
            const data = JSON.parse(Buffer.concat(chunks).toString('utf8'))
            for (const p of (data.providers || [])) {
              if (p && typeof p === 'object') delete p.key
            }
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
    proxy(req, res, rest || '/')
    return true
  }
  return false
}
