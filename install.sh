#!/usr/bin/env bash
# Instala Terminal Celular: servicio de opencode + integración en WTS/coffecode-web.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WTS_DIR="${WTS_DIR:-/home/martin/Whatsapp-teamSync}"
COFFE_DIR="${COFFE_DIR:-/home/martin/coffecode-web}"
OC_PORT="${OC_PORT:-4096}"
APP_DIR="${APP_DIR:-$REPO_DIR/app}"
USER_UNIT_DIR="$HOME/.config/systemd/user"
PW_FILE="$HOME/.config/terminal-celular/oc-password"

# Fija Environment=KEY=VALUE en una unit systemd (idempotente).
set_env() {
  local f="$1" k="$2" v="$3"
  [ -f "$f" ] || { echo "  AVISO: no existe $f"; return; }
  if grep -q "^Environment=$k=" "$f"; then
    sed -i "s#^Environment=$k=.*#Environment=$k=$v#" "$f"
  else
    awk -v line="Environment=$k=$v" '{ print } /^\[Service\]$/ { print line }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  fi
}

echo "==> 1/7  Contraseña del server opencode"
mkdir -p "$(dirname "$PW_FILE")"
if [ ! -s "$PW_FILE" ]; then
  head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32 > "$PW_FILE"
  chmod 600 "$PW_FILE"
fi
OC_PW="$(cat "$PW_FILE")"

echo "==> 2/7  Servicio systemd --user de opencode (con contraseña)"
mkdir -p "$USER_UNIT_DIR"
cp "$REPO_DIR/deploy/opencode-serve.service" "$USER_UNIT_DIR/opencode-serve.service"
set_env "$USER_UNIT_DIR/opencode-serve.service" OPENCODE_SERVER_PASSWORD "$OC_PW"
systemctl --user daemon-reload
systemctl --user enable --now opencode-serve.service
systemctl --user restart opencode-serve.service

echo "==> 3/7  Copiar módulo de integración al server WTS"
cp "$REPO_DIR/server/opencode-app.ts" "$WTS_DIR/server/src/opencode-app.ts"

echo "==> 4/7  Aplicar enganches (idempotente)"
python3 "$REPO_DIR/deploy/patch.py" "$WTS_DIR" "$COFFE_DIR"

echo "==> 5/7  Configurar WTS (APP_DIR + OC_PASSWORD)"
set_env "$USER_UNIT_DIR/whatsapp-teamsync.service" APP_DIR "$APP_DIR"
set_env "$USER_UNIT_DIR/whatsapp-teamsync.service" OC_PASSWORD "$OC_PW"
set_env "$USER_UNIT_DIR/whatsapp-teamsync.service" ALLOWED_ORIGINS "coffecode.lat"
systemctl --user daemon-reload

echo "==> 6/7  Recompilar server WTS"
( cd "$WTS_DIR" && npm run build:server )

echo "==> 7/7  Reiniciar servidores"
systemctl --user restart whatsapp-teamsync.service
# coffecode-web es un servicio de sistema con Restart=always; matar el proceso
# hace que systemd lo relance con el código nuevo, sin necesitar sudo.
pid="$(ss -ltnp 2>/dev/null | grep ":8080 " | grep -oP 'pid=\K[0-9]+' | head -1 || true)"
if [ -n "${pid:-}" ]; then
  kill "$pid" 2>/dev/null || true
  echo "  coffecode-web ($pid) recargado"
else
  echo "  coffecode-web no encontrado en :8080 (reinícialo a mano)"
fi

echo
echo "Listo. Abre https://coffecode.lat/app en el celular."
echo "opencode serve escucha en 127.0.0.1:$OC_PORT (Basic auth, usuario 'opencode')."
