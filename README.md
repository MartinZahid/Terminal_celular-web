# Terminal Celular

App móvil (PWA) para usar **opencode** desde el celular: enviar mensajes, ver
las respuestas en vivo, cambiar de chat (sesión), cambiar entre los agentes
**Plan/Build** y cambiar de **modelo**.

La app es un cliente de un servidor `opencode serve` (API v1). Se integra en el
servidor existente de **WhatsApp Team Sync** (WTS) para reutilizar el login
(Google + PIN) y el dominio `coffecode.lat`.

## Arquitectura

```
Celular ──> coffecode.lat/app        (PWA)
        └─> coffecode.lat/oc/*       (proxy a la API de opencode)

coffecode-web/server.js  ──proxy──>  WTS :3001  ──proxy /oc──>  opencode serve :4096
                                                     └── sirve /app desde app/
```

- `app/`            Frontend PWA (HTML/CSS/JS sin bundler).
- `server/`         Módulo de integración que se copia al server WTS.
- `deploy/`         Unidades systemd y `smoke-test.mjs`.
- `install.sh`      Instala el servicio de opencode y enlaza la integración.

## Seguridad

- `authed()` exige sesión válida **y** PIN verificado (si hay PIN configurado)
  **y** que la terminal no esté desactivada.
- Allowlist estricta de rutas: `/agent`, `/event`, `/config/providers`,
  `/question`, `/permission`, y solo `/session`, `/session/status`,
  `/session/{id}`, `/session/{id}/{message|prompt_async|abort}`,
  `/session/{id}/question*` y `/session/{id}/permissions/*`. El resto → `403`.
  Se rechazan `..` y `%2f` en el path.
- El proxy **no** reenvía `cookie`/`authorization` del cliente ni cabeceras
  hop-by-hop; para métodos distintos de GET se valida `Origin`/`Referer` (CSRF).
- Las respuestas JSON se sanean antes de llegar al navegador: nunca se expone
  `key`/`apiKey`/`token`/`password`/`secret` de los proveedores.
- `opencode serve` escucha solo en `127.0.0.1` y usa **HTTP Basic**
  (`OPENCODE_SERVER_PASSWORD`, usuario `opencode`); el proxy añade el header con
  `OC_PASSWORD`. La contraseña se guarda en
  `~/.config/terminal-celular/oc-password` (chmod 600).

## Tests

```bash
node deploy/smoke-test.mjs        # integración E2E (proxy efímero + opencode real)
node test/frontend.test.cjs       # funciones puras del frontend (app/pure.js)
node --test test/server.test.mjs  # funciones puras del proxy (requiere WTS compilado)
```

`smoke-test.mjs` levanta un proxy efímero in-process (comparte el almacén de
sesiones) y verifica auth, allowlist, saneo de credenciales, CRUD de sesiones y
SSE real contra `opencode`. Los otros dos son unitarios y no usan red.

## Requisitos

- `opencode` v1 instalado en `~/.opencode/bin/opencode`.
- El server WTS (`Whatsapp-teamSync/server`) y `coffecode-web/server.js`.

## Instalación

```bash
./install.sh
```

El script:
1. Genera/reutiliza la contraseña de opencode
   (`~/.config/terminal-celular/oc-password`).
2. Crea y activa `opencode-serve.service` (systemd --user) en `127.0.0.1:4096`
   con `OPENCODE_SERVER_PASSWORD`.
3. Copia `server/opencode-app.ts` a `Whatsapp-teamSync/server/src/`.
4. Aplica los enganches en `server.ts` y las rutas `/app` y `/oc` en
   `coffecode-web/server.js` (idempotente; **falla** si falta un marcador).
5. Configura `APP_DIR` y `OC_PASSWORD` en `whatsapp-teamsync.service`.
6. Recompila el server WTS.
7. Reinicia WTS y recarga coffecode-web.

## Uso

- Abre `https://coffecode.lat/app` en el celular e instálala como app.
- En PC, `/terminal` sigue mostrando la terminal xterm; en móvil redirige a `/app`.
