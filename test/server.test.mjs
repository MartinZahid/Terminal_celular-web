// Tests de las funciones puras del proxy.
// Uso: node --test test/server.test.mjs
// Requiere que el server WTS esté compilado (server/dist). Ubica el proyecto
// WTS con $WTS_DIR o ~/Whatsapp-teamSync.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const WTS = process.env.WTS_DIR || path.join(os.homedir(), 'Whatsapp-teamSync')
const mod = await import(pathToFileURL(path.join(WTS, 'server/dist/server/src/opencode-app.js')).href)
const { allowedPath, sameOriginOk, sanitize } = mod

test('allowedPath permite las rutas que usa la app', () => {
  for (const p of [
    '/session',
    '/session/status',
    '/session/abc',
    '/session/abc/message?limit=5',
    '/session/abc/prompt_async',
    '/session/abc/abort',
    '/session/abc/permissions/per_1',
    '/agent',
    '/event',
    '/config/providers',
    '/question',
    '/permission',
    '/question/que_1/reply',
    '/question/que_1/reject',
  ]) {
    assert.equal(allowedPath(p), true, 'debería permitir ' + p)
  }
})

test('allowedPath bloquea lo peligroso', () => {
  for (const p of [
    '/session/abc/shell',
    '/session/abc/fork',
    '/session/abc/share',
    '/provider',
    '/config',
    '/session/..%2f..%2fetc',
    '/session/%2e%2e/x',
    '/session/a/../../x',
  ]) {
    assert.equal(allowedPath(p), false, 'debería bloquear ' + p)
  }
})

test('sameOriginOk valida métodos mutantes', () => {
  const post = (h) => sameOriginOk({ method: 'POST', headers: h })
  assert.equal(post({ origin: 'https://coffecode.lat', host: 'localhost:3001' }), false)
  assert.equal(post({ origin: 'https://coffecode.lat', host: 'localhost:3001', 'x-forwarded-host': 'coffecode.lat' }), true)
  assert.equal(post({ origin: 'https://coffecode.lat', host: 'coffecode.lat' }), true)
  assert.equal(sameOriginOk({ method: 'GET', headers: {} }), true)
})

test('sanitize quita credenciales, incluso anidadas', () => {
  const data = {
    providers: [{ id: 'a', key: 'k', options: { apiKey: 'x', baseURL: 'u' } }],
    all: [{ id: 'b', token: 't' }],
  }
  sanitize(data)
  assert.equal('key' in data.providers[0], false)
  assert.equal('apiKey' in data.providers[0].options, false)
  assert.equal(data.providers[0].options.baseURL, 'u')
  assert.equal('token' in data.all[0], false)
})
