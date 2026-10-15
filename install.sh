#!/usr/bin/env bash
# Instala Terminal Celular: servicio independiente (app móvil + terminal PC + auth).
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COFFE_DIR="${COFFE_DIR:-$HOME/coffecode-web}"
OC_PORT="${OC_PORT:-4096}"
APP_DIR="${APP_DIR:-$REPO_DIR/app}"
USER_UNIT_DIR="$HOME/.config/systemd/user"
ENV_DIR="$HOME/.config/terminal-celular"
ENV_FILE="$ENV_DIR/env"
DATA_DIR="${DATA_DIR:-$ENV_DIR/data}"
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
    K="$k" V="$v" awk 'BEGIN{k=ENVIRON["K"]; v=ENVIRON["V"]} index($0, k"=")==1 {print k"="v; next} {print}' "$f" > "$f.tmp" && mv "$f.tmp" "$f"
  else
    printf '%s=%s\n' "$k" "$v" >> "$f"
  fi
}

echo "==> 1/6  Contraseña, datos y variables de entorno"
mkdir -p "$ENV_DIR" "$DATA_DIR"
chmod 700 "$DATA_DIR"
if ! grep -q '^OPENCODE_SERVER_PASSWORD=' "$ENV_FILE" 2>/dev/null; then
  OC_PW="$(head -c 24 /dev/urandom | base64 | tr -d '/+=' | head -c 32)"
  ( umask 077; printf '%s\n' "OC_PASSWORD=$OC_PW" "OPENCODE_SERVER_PASSWORD=$OC_PW" > "$ENV_FILE" )
fi
set_kv "$ENV_FILE" OC_PASSWORD "$(grep '^OPENCODE_SERVER_PASSWORD=' "$ENV_FILE" | cut -d= -f2-)"
set_kv "$ENV_FILE" APP_DIR "$APP_DIR"
# DATA_DIR debe ser absoluto: systemd NO expande %h dentro de EnvironmentFile.
set_kv "$ENV_FILE" DATA_DIR "$DATA_DIR"
set_kv "$ENV_FILE" ALLOWED_ORIGINS "${ALLOWED_ORIGINS:-coffecode.lat}"
# Destino principal de opencode (la máquina local).
set_kv "$ENV_FILE" OC_HOST "${OC_HOST:-127.0.0.1}"
set_kv "$ENV_FILE" OC_PORT "$OC_PORT"
# Destino secundario opcional (p. ej. un túnel SSH a otra máquina). Solo se
# activa si se pasa OC2_PORT; si no, la app solo ofrece la máquina principal.
if [ -n "${OC2_PORT:-}" ]; then
  set_kv "$ENV_FILE" OC2_HOST "${OC2_HOST:-127.0.0.1}"
  set_kv "$ENV_FILE" OC2_PORT "$OC2_PORT"
  [ -n "${OC2_PASSWORD:-}" ] && set_kv "$ENV_FILE" OC2_PASSWORD "$OC2_PASSWORD"
fi
# Terminal PC: máquina secundaria accesible por SSH (opcional). Solo se activa
# si se pasa TERMINAL_SSH_HOST; si no, la terminal solo ofrece la Principal.
if [ -n "${TERMINAL_SSH_HOST:-}" ]; then
  set_kv "$ENV_FILE" TERMINAL_SSH_HOST "$TERMINAL_SSH_HOST"
  set_kv "$ENV_FILE" TERMINAL_SSH_USER "${TERMINAL_SSH_USER:-ubuntu}"
  [ -n "${TERMINAL_SSH_KEY:-}" ] && set_kv "$ENV_FILE" TERMINAL_SSH_KEY "$TERMINAL_SSH_KEY"
  [ -n "${TERMINAL_SSH_PORT:-}" ] && set_kv "$ENV_FILE" TERMINAL_SSH_PORT "$TERMINAL_SSH_PORT"
fi
chmod 600 "$ENV_FILE"
# Limpieza de instalaciones previas (secretos en texto plano + archivo viejo).
for f in "$USER_UNIT_DIR/opencode-serve.service" "$USER_UNIT_DIR/whatsapp-teamsync.service" "$USER_UNIT_DIR/terminal-celular.service"; do
  [ -f "$f" ] && sed -i '/^Environment=\(OC_PASSWORD\|OPENCODE_SERVER_PASSWORD\)=/d' "$f"
done
rm -f "$ENV_DIR/oc-password"

echo "==> 2/6  Servicio systemd --user de opencode"
mkdir -p "$USER_UNIT_DIR"
cp "$REPO_DIR/deploy/opencode-serve.service" "$USER_UNIT_DIR/opencode-serve.service"
set_envfile "$USER_UNIT_DIR/opencode-serve.service"
systemctl --user daemon-reload
systemctl --user enable --now opencode-serve.service
systemctl --user restart opencode-serve.service

echo "==> 3/6  Compilar el servicio Terminal Celular"
# NODE_ENV=production haría que npm omita devDependencies (typescript) → forzamos.
( cd "$REPO_DIR" && npm install --include=dev && npm run build )

echo "==> 4/6  Servicio systemd --user de Terminal Celular"
cp "$REPO_DIR/deploy/terminal-celular.service" "$USER_UNIT_DIR/terminal-celular.service"
set_envfile "$USER_UNIT_DIR/terminal-celular.service"
systemctl --user daemon-reload
systemctl --user enable --now terminal-celular.service
systemctl --user restart terminal-celular.service

echo "==> 5/6  Migrar google-oauth.json"
if [ ! -f "$DATA_DIR/google-oauth.json" ]; then
  SRC="$HOME/Whatsapp-teamSync/server/data/google-oauth.json"
  if [ -f "$SRC" ]; then
    cp "$SRC" "$DATA_DIR/google-oauth.json"
    chmod 600 "$DATA_DIR/google-oauth.json"
    echo "  copiado desde $SRC"
  else
    echo "  AVISO: no hay google-oauth.json; configura el OAuth de Google en $DATA_DIR"
  fi
else
  echo "  ya existe $DATA_DIR/google-oauth.json"
fi

echo "==> 6/6  Recargar coffecode-web"
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
echo "Servicio Terminal Celular en 127.0.0.1:3100; opencode en 127.0.0.1:$OC_PORT (Basic auth)."
echo "Variables en $ENV_FILE (chmod 600); datos en $DATA_DIR."
echo "Recuerda enrutar /app, /oc, /oc2, /auth y /terminal a :3100 en coffecode-web."
