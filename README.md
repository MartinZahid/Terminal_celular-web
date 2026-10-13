# Terminal Celular

App móvil (PWA) para usar **opencode** desde el celular: enviar mensajes, ver
las respuestas en vivo, cambiar de chat (sesión), cambiar entre los agentes
**Plan/Build**, cambiar de **modelo** y cambiar entre dos **máquinas**
(principal/secundaria).

La app es un cliente de un servidor `opencode serve` (API v1). Se integra en el
servidor existente de **WhatsApp Team Sync** (WTS) para reutilizar el login
(Google + PIN) y el dominio `coffecode.lat`.

## Arquitectura

```
Celular ──> coffecode.lat/app        (PWA)
        ├─> coffecode.lat/oc/*       (proxy a la máquina principal)
        └─> coffecode.lat/oc2/*      (proxy a la máquina secundaria)

coffecode-web/server.js ──proxy──> WTS :3001 ──proxy /oc ──> opencode serve :4096  (principal)
                                                    ├─proxy /oc2─> opencode serve :4097 (secundaria)
                                                    └── sirve /app desde app/
```

- `app/`            Frontend PWA (HTML/CSS/JS sin bundler).
- `server/`         Módulo de integración que se copia al server WTS.
- `deploy/`         Unidades systemd y `smoke-test.mjs`.
- `install.sh`      Instala el servicio de opencode y enlaza la integración.

## Cambiar de máquina

La app ofrece un selector (chip **Máquina**) con dos destinos, cada uno con su
propio `opencode serve`, sesiones y agentes:

- **Principal** → `/oc`  → `OC_HOST:OC_PORT` (por defecto `127.0.0.1:4096`).
- **Secundaria** → `/oc2` → `OC2_HOST:OC2_PORT` (solo si `OC2_PORT` está definido;
  típicamente un túnel SSH, p. ej. `127.0.0.1:4097`).

La primera vez que se abre la app se pregunta qué máquina usar; después se
recuerda la última elección. Al cambiar de máquina se recargan sesiones,
agentes y modelos. Las variables se configuran en
`~/.config/terminal-celular/env`.

### Terminal de PC (xterm)

En PC, `/terminal` muestra la terminal negra con el mismo selector
**Principal / Secundaria** en la cabecera (solo aparece si hay más de una
máquina). **Principal** abre una shell en el servidor local; **Secundaria**
abre una shell por SSH en la otra máquina, así que **la carga de trabajo corre
ahí**. Se recuerda la última elección (`localStorage`). Requiere en
`~/.config/terminal-celular/env`:

```
TERMINAL_SSH_HOST=40.233.2.94
TERMINAL_SSH_USER=ubuntu
TERMINAL_SSH_KEY=/home/martin/.ssh/40.233.2.94.key
# TERMINAL_SSH_PORT=22
```

Si `TERMINAL_SSH_HOST` no está definido, la terminal solo ofrece la Principal
(comportamiento de una sola máquina).

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
node test/proxy.test.mjs          # integración del proxy vs un upstream falso
node test/frontend.test.cjs       # funciones puras del frontend (app/pure.js)
node --test test/server.test.mjs  # funciones puras del proxy (requiere WTS compilado)
```

`smoke-test.mjs` levanta un proxy efímero in-process (comparte el almacén de
sesiones) y verifica auth, allowlist, saneo de credenciales, CRUD de sesiones y
SSE real contra `opencode`. `proxy.test.mjs` ejercita `handleAppRequest` contra
un upstream falso (Basic auth, cookie no reenviada, chunked, CSRF) sin necesidad
de `opencode`. `server.test.mjs` y `proxy.test.mjs` importan `server/dist`, así
que requieren el WTS compilado; `frontend.test.cjs` no.

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
4. Aplica los enganches en `server.ts` y las rutas `/app`, `/oc` y `/oc2` en
   `coffecode-web/server.js` (idempotente; **falla** si falta un marcador).
5. Configura `APP_DIR`, `OC_PASSWORD`, `OC_HOST`/`OC_PORT` (y `OC2_*` si se
   define `OC2_PORT`; y `TERMINAL_SSH_*` para la terminal de PC de la
   secundaria) en `whatsapp-teamsync.service`.
6. Recompila el server WTS.
7. Reinicia WTS y recarga coffecode-web.

## Uso

- Abre `https://coffecode.lat/app` en el celular e instálala como app.
- Pulsa 📎 para adjuntar archivos (varios, de cualquier tipo, hasta 10 MB cada
  uno); se envían junto al mensaje como *file parts* (data URL base64).
- En PC, `/terminal` muestra la terminal xterm con el selector de máquina; en
  móvil redirige a `/app`.
