# Terminal Celular

App móvil (PWA) para usar **opencode** desde el celular: enviar mensajes, ver
las respuestas en vivo, cambiar de chat (sesión), cambiar entre los agentes
**Plan/Build**, cambiar de **modelo** y cambiar entre dos **máquinas**
(principal/secundaria). Incluye también la **terminal xterm** de PC.

Es un **servicio independiente** (`server/standalone.ts`, systemd --user en
`127.0.0.1:3100`): sirve la app, el login (Google + PIN), la terminal (PTY) y el
proxy a `opencode serve`. **No depende de Whatsapp-teamSync (WTS)**: WTS queda
solo para WhatsApp. Ambos se publican bajo el mismo dominio `coffecode.lat` a
través de `coffecode-web`.

## Arquitectura

```
Celular/PC ──> coffecode.lat/app       (PWA)
            ├─> coffecode.lat/oc/*      (proxy → opencode principal)
            ├─> coffecode.lat/oc2/*     (proxy → opencode secundaria)
            └─> coffecode.lat/terminal  (xterm + PTY)

coffecode-web/server.js
  ├─ /app /oc /oc2 /auth /terminal ──> terminal-celular :3100 ──> opencode serve :4096 / :4097
  └─ /api /dashboard /gastometro ────> Whatsapp-teamSync :3001
```

- `app/`        Frontend PWA (HTML/CSS/JS sin bundler) + `terminal.html` (xterm).
- `server/`     Servicio: `standalone.ts` (HTTP+WS), `auth.ts`, `terminal.ts`, `opencode-app.ts`.
- `deploy/`     Unidades systemd (`terminal-celular.service`, `opencode-serve.service`) y `smoke-test.mjs`.
- `test/`       Tests de frontend, del proxy y unitarios.
- `install.sh`  Compila el servicio, instala las unidades y migra los datos.

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
(comportamiento de una sola máquina). La sesión se ejecuta dentro de `tmux`
(`TERMINAL_TMUX`, por defecto `coffecode`), así que **sobrevive a desconexiones
y a reinicios del servicio**.

## Seguridad

- `authed()` exige sesión válida **y** PIN verificado (si hay PIN configurado)
  **y** que la terminal no esté desactivada. `/app` solo exige sesión.
- Allowlist estricta de rutas: `/agent`, `/event`, `/config/providers`,
  `/question`, `/permission`, y solo `/session`, `/session/status`,
  `/session/{id}`, `/session/{id}/{message|prompt_async|abort}`,
  `/session/{id}/question*` y `/session/{id}/permissions/*`. El resto → `403`.
  Se rechazan `..` y `%2f` en el path.
- El proxy **no** reenvía `cookie`/`authorization` del cliente ni cabeceras
  hop-by-hop; para métodos distintos de GET se valida `Origin`/`Referer` (CSRF).
- Las respuestas JSON de proveedores se sanean antes de llegar al navegador:
  nunca se expone `key`/`apiKey`/`token`/`password`/`secret`.
- `opencode serve` escucha solo en `127.0.0.1` y usa **HTTP Basic**
  (`OPENCODE_SERVER_PASSWORD`, usuario `opencode`); el proxy añade el header con
  `OC_PASSWORD`. La contraseña y el resto de variables viven en
  `~/.config/terminal-celular/env` (chmod 600), cargado por systemd vía
  `EnvironmentFile=`.
- El login es Google OAuth + PIN opcional; `google-oauth.json` y el PIN se
  guardan en `~/.config/terminal-celular/data` (`DATA_DIR`).

## Tests

```bash
node deploy/smoke-test.mjs        # integración E2E (proxy efímero + opencode real)
node test/proxy.test.mjs          # integración del proxy vs un upstream falso
node test/frontend.test.cjs       # funciones puras del frontend (app/pure.js)
node --test test/server.test.mjs  # funciones puras del proxy
```

`server.test.mjs` y `proxy.test.mjs` importan `dist/` (el servicio compilado);
`smoke-test.mjs` levanta un proxy efímero in-process (comparte el almacén de
sesiones) y verifica auth, allowlist, saneo de credenciales, CRUD de sesiones y
SSE real contra `opencode`.

## Requisitos

- `opencode` v1 instalado en `~/.opencode/bin/opencode`.
- `node`/`npm` y `python3`/`make`/`g++` (para compilar `node-pty`).
- `coffecode-web/server.js` enrutando `/app`, `/oc`, `/oc2`, `/auth` y
  `/terminal` (y `upgrade /terminal/ws`) a `127.0.0.1:3100`.

## Instalación

```bash
./install.sh
```

El script:
1. Genera/reutiliza la contraseña de opencode y escribe `APP_DIR`, `DATA_DIR`,
   `OC_*`, `OC2_*` y `TERMINAL_SSH_*` en `~/.config/terminal-celular/env`.
2. Crea y activa `opencode-serve.service` (systemd --user) en `127.0.0.1:4096`.
3. Compila el servicio (`npm install --include=dev && npm run build` → `dist/`).
4. Crea y activa `terminal-celular.service` (systemd --user) en `127.0.0.1:3100`.
5. Migra `google-oauth.json` a `~/.config/terminal-celular/data` (si falta).
6. Recarga `coffecode-web`.

## Uso

- Abre `https://coffecode.lat/app` en el celular e instálala como app.
- Pulsa 📎 para adjuntar archivos (varios, de cualquier tipo, hasta 10 MB cada
  uno); se envían junto al mensaje como *file parts* (data URL base64).
- En PC, `/terminal` muestra la terminal xterm con el selector de máquina; en
  móvil redirige a `/app`.
