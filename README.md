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

- El proxy `/oc` solo permite las rutas que la app usa (`/agent`, `/event`,
  `/config/providers` y `/session*`); el resto responde `403`.
- Las respuestas JSON se sanean antes de llegar al navegador: nunca se expone
  `key`/`apiKey`/`token`/`password`/`secret` de los proveedores.
- `opencode serve` escucha solo en `127.0.0.1` y la puerta de entrada es el login
  existente de WTS (Google + PIN).

## Tests

```bash
node deploy/smoke-test.mjs
```

Levanta un proxy efímero in-process (comparte el almacén de sesiones) y verifica
auth, allowlist, saneo de credenciales, CRUD de sesiones y SSE real contra
`opencode`.

## Requisitos

- `opencode` v1 instalado en `~/.opencode/bin/opencode`.
- El server WTS (`Whatsapp-teamSync/server`) y `coffecode-web/server.js`.

## Instalación

```bash
./install.sh
```

El script:
1. Crea y activa `opencode-serve.service` (systemd --user) en `127.0.0.1:4096`.
2. Copia `server/opencode-app.ts` a `Whatsapp-teamSync/server/src/`.
3. Aplica el enganche en `server.ts` y las rutas `/app` y `/oc` en
   `coffecode-web/server.js` (idempotente, con marcadores).
4. Recompila el server WTS y lo reinicia.

## Uso

- Abre `https://coffecode.lat/app` en el celular e instálala como app.
- En PC, `/terminal` sigue mostrando la terminal xterm; en móvil redirige a `/app`.
