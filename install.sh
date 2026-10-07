#!/usr/bin/env bash
# Instala Terminal Celular: servicio de opencode + integración en WTS/coffecode-web.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WTS_DIR="${WTS_DIR:-/home/martin/Whatsapp-teamSync}"
COFFE_DIR="${COFFE_DIR:-/home/martin/coffecode-web}"
OC_PORT="${OC_PORT:-4096}"
APP_DIR="${APP_DIR:-$REPO_DIR/app}"

echo "==> 1/6  Servicio systemd --user de opencode"
mkdir -p "$HOME/.config/systemd/user"
cp "$REPO_DIR/deploy/opencode-serve.service" "$HOME/.config/systemd/user/opencode-serve.service"
systemctl --user daemon-reload
systemctl --user enable --now opencode-serve.service
systemctl --user restart opencode-serve.service

echo "==> 2/6  Copiar módulo de integración al server WTS"
cp "$REPO_DIR/server/opencode-app.ts" "$WTS_DIR/server/src/opencode-app.ts"

echo "==> 3/6  Aplicar enganches (idempotente)"
python3 "$REPO_DIR/deploy/patch.py" "$WTS_DIR" "$COFFE_DIR"

echo "==> 4/6  Configurar APP_DIR en la unidad de WTS"
UNIT="$HOME/.config/systemd/user/whatsapp-teamsync.service"
if [ -f "$UNIT" ]; then
  if grep -q '^Environment=APP_DIR=' "$UNIT"; then
    sed -i "s#^Environment=APP_DIR=.*#Environment=APP_DIR=$APP_DIR#" "$UNIT"
  else
    awk -v appdir="$APP_DIR" '{ print } /^\[Service\]$/ { print "Environment=APP_DIR=" appdir }' "$UNIT" > "$UNIT.tmp"
    mv "$UNIT.tmp" "$UNIT"
  fi
  systemctl --user daemon-reload
  echo "  APP_DIR=$APP_DIR en whatsapp-teamsync.service"
else
  echo "  AVISO: no existe $UNIT; define APP_DIR=$APP_DIR manualmente en el servicio"
fi

echo "==> 5/6  Recompilar server WTS"
( cd "$WTS_DIR" && npm run build:server )

echo "==> 6/6  Reiniciar servidores"
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
echo "opencode serve escucha en 127.0.0.1:$OC_PORT"
