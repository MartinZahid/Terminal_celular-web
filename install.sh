#!/usr/bin/env bash
# Instala Terminal Celular: servicio de opencode + integración en WTS/coffecode-web.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WTS_DIR="${WTS_DIR:-$HOME/Whatsapp-teamSync}"
COFFE_DIR="${COFFE_DIR:-$HOME/coffecode-web}"
OC_PORT="${OC_PORT:-4096}"
APP_DIR="${APP_DIR:-$REPO_DIR/app}"
USER_UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/terminal-celular"
ENV_FILE="$ENV_DIR/env"
ENVFILE_LINE="EnvironmentFile=%h/.config/terminal-celular/env"

# Asegura EnvironmentFile= en una unit systemd (idempotente).
set_envfile() {
  local f="$1"
  [ -f "$f" ] || { echo "  AVISO: no existe $f"; return; }
  # Elimina cualquier EnvironmentFile= que apunte a nuestro env (con o sin
  # guion) y añade el canónico, para no dejar duplicados.
  sed -i '\#^EnvironmentFile=.*terminal-celular/env$#d' "$f"
  awk -v line="$ENVFILE_LINE" '{ print } /^\[Service\]$/ { print line }' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
}

# Fija KEY=VALUE en un archivo KEY=VALUE (idempotente).
set_kv() {
  local f="$1" k="$2" v="$3"
  touch "$f"
  if grep -q "^$k=" "$f"; then
    sed -i "s#^$k=.*#$k=$v#" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

echo "==> 1/7  Contraseña y variables de entorno"
mkdir -p "$ENV_DIR"
if ! grep -q '^OPENCODE_SERVER_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
  OC_PW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  ( umask 077; printf '%s\n' "OC_PASSWORD=$OC_PW" "OPENCODE_SERVER_PASSWORD=$OC_PW" > "$ENV_FILE" )
fi
set_kv "$ENV_FILE" OC_PASSWORD "$(grep '^OPENCODE_SERVER_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
set_kv "$ENV_FILE" APP_DIR "$APP_DIR"
set_kv "$ENV_FILE" ALLOWED_ORIGINS "${ALLOWED_ORIGINS:-coffecode.lat}"
chmod 600 "$ENV_FILE"
# Limpieza de instalaciones previas (secretos en texto plano + archivo viejo).
for f in "$USER_UNIT_DIR/opencode-serve.service" "$USER_UNIT_DIR/whatsapp-teamsync.service"; do
  [ -f "$f" ] && sed -i '/^Environment=\(OC_PASSWORD\|OPENCODE_SERVER_PASSWORD\)=/d' "$f"
done
rm -f "$ENV_DIR/oc-password"

echo "==> 2/7  Servicio systemd --user de opencode"
mkdir -p "$USER_UNIT_DIR"
cp "$REPO_DIR/deploy/opencode-serve.service" "$USER_UNIT_DIR/opencode-serve.service"
set_envfile "$USER_UNIT_DIR/opencode-serve.service"
systemctl --user daemon-reload
systemctl --user enable --now opencode-serve.service
systemctl --user restart opencode-serve.service

echo "==> 3/7  Copiar módulo de integración al server WTS"
cp "$REPO_DIR/server/opencode-app.ts" "$WTS_DIR/server/src/opencode-app.ts"

echo "==> 4/7  Aplicar enganches (idempotente)"
python3 "$REPO_DIR/deploy/patch.py" "$WTS_DIR" "$COFFE_DIR"

echo "==> 5/7  Configurar WTS (EnvironmentFile)"
set_envfile "$USER_UNIT_DIR/whatsapp-teamsync.service"
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
echo "Variables en $ENV_FILE (chmod 600)."
