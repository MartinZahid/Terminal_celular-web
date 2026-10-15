// Google OAuth + hardened sessions + PIN second factor + rate limiting + audit + kill-switch
import { randomBytes, createHash, randomInt } from 'crypto'
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, appendFileSync } from 'fs'
import { join } from 'path'

// Directorio de datos (OAuth, PIN, kill-switch, audit). Configurable por env;
// por defecto, la config propia del servicio (~/.config/terminal-celular/data).
const DB_DIR = process.env.DATA_DIR || join(process.env.HOME || '.', '.config', 'terminal-celular', 'data')
const CONFIG_PATH = join(DB_DIR, 'google-oauth.json')
const PIN_FILE = join(DB_DIR, 'terminal-pin')
const DISABLE_FILE = join(DB_DIR, 'terminal-disabled')
const AUDIT_PATH = join(DB_DIR, 'security.log')

export const ALLOWED_EMAIL = 'martinzahidpro@gmail.com'
export const COOKIE_NAME = 'wts_session'
const STATE_COOKIE = 'wts_oauth_state'

const IDLE_TIMEOUT_MS = 15 * 60 * 1000 // 15 min sin actividad
const MAX_LIFETIME_MS = 8 * 60 * 60 * 1000 // 8 h tope absoluto

export const REDIRECT_URI = process.env.GOOGLE_REDIRECT_URI || 'https://coffecode.lat/auth/callback'

// ---------- OAuth config ----------
interface OAuthConfig {
  clientId: string
  clientSecret: string
}

let config: OAuthConfig | null = null

export function loadOAuthConfig(): OAuthConfig | null {
  if (config) return config
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
    config = { clientId: process.env.GOOGLE_CLIENT_ID, clientSecret: process.env.GOOGLE_CLIENT_SECRET }
    return config
  }
  try {
    if (existsSync(CONFIG_PATH)) {
      config = JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as OAuthConfig
      return config
    }
  } catch (err) {
    console.error('[Auth] Error reading OAuth config:', err)
  }
  return null
}

export function saveOAuthConfig(clientId: string, clientSecret: string): void {
  mkdirSync(DB_DIR, { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify({ clientId, clientSecret }, null, 2), { mode: 0o600 })
  config = { clientId, clientSecret }
}

export function isOAuthConfigured(): boolean {
  return loadOAuthConfig() !== null
}

// ---------- Audit log (server/data/security.log) ----------
export function audit(
  event: string,
  email?: string | null,
  ip?: string,
  ua?: string,
  extra?: Record<string, unknown>
): void {
  try {
    mkdirSync(DB_DIR, { recursive: true })
    appendFileSync(
      AUDIT_PATH,
      JSON.stringify({ ts: new Date().toISOString(), event, email: email ?? null, ip: ip ?? null, ua: ua ?? null, ...(extra ?? {}) }) + '\n'
    )
  } catch (err) {
    console.error('[Auth] audit write failed:', err)
  }
}

// ---------- Client IP / UA ----------
export function clientIp(req: { headers?: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const xff = req.headers?.['x-forwarded-for']
  const raw = Array.isArray(xff) ? xff[0] : xff
  if (raw) return raw.split(',')[0].trim()
  const ra = req.socket?.remoteAddress
  return ra ? ra.replace(/^::ffff:/, '') : 'unknown'
}

export function clientUa(req: { headers?: Record<string, string | string[] | undefined> }): string {
  const h = req.headers?.['user-agent']
  return (Array.isArray(h) ? h[0] : h) || 'unknown'
}

// ---------- Sessions (hardened) ----------
interface Session {
  email: string
  createdAt: number
  lastActivity: number
  ip: string
  ua: string
  pinVerified: boolean
}

const sessions = new Map<string, Session>()

export function createSession(email: string, ip: string, ua: string): string {
  const token = randomBytes(32).toString('hex')
  sessions.set(token, { email, createdAt: Date.now(), lastActivity: Date.now(), ip, ua, pinVerified: false })
  return token
}

// Validates token + expiration + fingerprint (IP and UA bound).
export function getSession(
  token: string | null | undefined,
  ip?: string,
  ua?: string
): Session | null {
  if (!token) return null
  const s = sessions.get(token)
  if (!s) return null

  const now = Date.now()
  if (now - s.createdAt > MAX_LIFETIME_MS || now - s.lastActivity > IDLE_TIMEOUT_MS) {
    sessions.delete(token)
    return null
  }

  if (ua && s.ua !== ua) {
    audit('fingerprint_mismatch', s.email, ip, ua)
    sessions.delete(token)
    return null
  }
  if (ip && s.ip !== ip) {
    audit('ip_changed', s.email, ip, ua, { known_ip: s.ip })
    sessions.delete(token)
    return null
  }

  s.lastActivity = now
  return s
}

// Rotates the token (called after PIN verify / re-login). Returns the new token.
export function rotateSession(token: string, ip: string, ua: string): string | null {
  const s = getSession(token, ip, ua)
  if (!s) return null
  sessions.delete(token)
  const newToken = randomBytes(32).toString('hex')
  sessions.set(newToken, { ...s, lastActivity: Date.now() })
  return newToken
}

export function destroySession(token: string | null | undefined): void {
  if (token) sessions.delete(token)
}

export function destroyAllSessions(): void {
  sessions.clear()
}

export function pruneAuth(): void {
  const now = Date.now()
  for (const [token, s] of sessions) {
    if (now - s.createdAt > MAX_LIFETIME_MS || now - s.lastActivity > IDLE_TIMEOUT_MS) sessions.delete(token)
  }
  for (const [k, e] of rateBuckets) {
    if (now - e.windowStart > 60_000) rateBuckets.delete(k)
  }
  for (const [k, f] of pinFails) {
    if (now > f.until && (f.until || now - (f.lastAt ?? 0) > 60_000)) pinFails.delete(k)
  }
}

// ---------- Rate limiting (in-memory, per IP) ----------
interface RateEntry { count: number; windowStart: number }
const rateBuckets = new Map<string, RateEntry>()

export function rateLimit(ip: string, key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const k = `${ip}|${key}`
  const e = rateBuckets.get(k)
  if (!e || now - e.windowStart > windowMs) {
    rateBuckets.set(k, { count: 1, windowStart: now })
    return true
  }
  e.count++
  if (e.count > limit) return false
  return true
}

// ---------- PIN second factor ----------
interface PinRecord { salt: string; hash: string }

function getPinRecord(): PinRecord | null {
  try {
    if (existsSync(PIN_FILE)) return JSON.parse(readFileSync(PIN_FILE, 'utf-8')) as PinRecord
  } catch { /* ignore */ }
  return null
}

export function pinConfigured(): boolean {
  return getPinRecord() !== null
}

export function setPin(pin: string): void {
  const salt = randomBytes(16).toString('hex')
  const hash = createHash('sha256').update(salt + pin).digest('hex')
  mkdirSync(DB_DIR, { recursive: true })
  writeFileSync(PIN_FILE, JSON.stringify({ salt, hash }), { mode: 0o600 })
}

export function verifyPin(pin: string): boolean {
  const rec = getPinRecord()
  if (!rec) return false
  const h = createHash('sha256').update(rec.salt + pin).digest('hex')
  return h === rec.hash
}

export function generatePin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

interface PinFail { count: number; until: number; lastAt: number }
const pinFails = new Map<string, PinFail>()

export function pinBlockRemaining(ip: string): number {
  const f = pinFails.get(ip)
  if (f && f.until > Date.now()) return f.until - Date.now()
  return 0
}

export function registerPinFail(ip: string): void {
  const now = Date.now()
  const f = pinFails.get(ip) || { count: 0, until: 0, lastAt: now }
  if (f.until <= now) f.count = (now - f.lastAt < 15 * 60 * 1000 ? f.count : 0) + 1
  else f.count++
  f.lastAt = now
  if (f.count >= 5) f.until = now + 15 * 60 * 1000
  pinFails.set(ip, f)
}

export function resetPinFails(ip: string): void {
  pinFails.delete(ip)
}

// ---------- Kill switch (persistent file) ----------
export function isTerminalDisabled(): boolean {
  try { return existsSync(DISABLE_FILE) } catch { return false }
}

export function setTerminalDisabled(v: boolean): void {
  mkdirSync(DB_DIR, { recursive: true })
  if (v) writeFileSync(DISABLE_FILE, 'disabled')
  else rmSync(DISABLE_FILE, { force: true })
}

// ---------- OAuth state (CSRF) ----------
const states = new Map<string, number>()

export function newState(): string {
  const s = randomBytes(16).toString('hex')
  states.set(s, Date.now())
  return s
}

export function verifyState(s: string | null | undefined): boolean {
  if (!s) return false
  const created = states.get(s)
  if (!created) return false
  states.delete(s)
  return Date.now() - created < 10 * 60 * 1000
}

// ---------- OAuth URLs / exchange ----------
export function authorizeUrl(state: string): string {
  const clientId = loadOAuthConfig()?.clientId || ''
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: REDIRECT_URI,
    response_type: 'code',
    scope: 'openid email profile',
    state,
  })
  return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
}

export interface GoogleUser {
  email: string
  email_verified: boolean
}

export async function exchangeCode(code: string): Promise<GoogleUser | null> {
  const cfg = loadOAuthConfig()
  if (!cfg) return null

  const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: cfg.clientId,
      client_secret: cfg.clientSecret,
      redirect_uri: REDIRECT_URI,
      grant_type: 'authorization_code',
    }),
  })
  if (!tokenRes.ok) {
    console.error('[Auth] Token exchange failed:', tokenRes.status)
    return null
  }
  const tokens = (await tokenRes.json()) as { access_token?: string }

  const userRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
    headers: { Authorization: `Bearer ${tokens.access_token}` },
  })
  if (!userRes.ok) {
    console.error('[Auth] Userinfo request failed:', userRes.status)
    return null
  }
  return (await userRes.json()) as GoogleUser
}

export function isAllowedUser(user: GoogleUser): boolean {
  return user.email === ALLOWED_EMAIL && user.email_verified === true
}

// ---------- Cookies ----------
export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(';')) {
    const idx = part.indexOf('=')
    if (idx > 0) out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

export function getSessionToken(req: { headers?: Record<string, string | string[] | undefined>; url?: string } | undefined): string | null {
  const h = req?.headers?.['cookie']
  const header = Array.isArray(h) ? h[0] : h
  const fromCookie = parseCookies(header)[COOKIE_NAME]
  if (fromCookie) return fromCookie
  // Fallback: accept token from query param ?token=... (for cross-origin WebSocket)
  if (req?.url) {
    try {
      const u = new URL(req.url, 'http://localhost')
      const t = u.searchParams.get('token')
      if (t) return t
    } catch {}
  }
  return null
}

export function sessionCookie(token: string, secure: boolean): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${MAX_LIFETIME_MS / 1000}`]
  if (secure) flags.push('Secure')
  return `${COOKIE_NAME}=${token}; ${flags.join('; ')}`
}

export function clearSessionCookie(secure: boolean): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0']
  if (secure) flags.push('Secure')
  return `${COOKIE_NAME}=; ${flags.join('; ')}`
}

export function stateCookie(state: string): string {
  return `${STATE_COOKIE}=${state}; Path=/; SameSite=Lax; Max-Age=600`
}