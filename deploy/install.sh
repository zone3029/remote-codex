#!/usr/bin/env bash
set -euo pipefail
if [[ ${EUID:-$(id -u)} -ne 0 ]]; then echo "请使用 root 运行：sudo bash deploy/install.sh"; exit 1; fi
command -v systemctl >/dev/null || { echo "需要 systemd"; exit 1; }
command -v openssl >/dev/null || { echo "需要 openssl"; exit 1; }
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="${REMOTE_CODEX_APP_DIR:-/opt/remote-codex}"
ETC_DIR="${REMOTE_CODEX_ETC_DIR:-/etc/remote-codex}"
DATA_DIR="${REMOTE_CODEX_DATA_DIR:-/var/lib/remote-codex}"
PUBLIC_HOST="${REMOTE_CODEX_PUBLIC_HOST:-$(hostname -f 2>/dev/null || hostname)}"
PUBLIC_PORT="${REMOTE_CODEX_PUBLIC_PORT:-9443}"
mkdir -p "$APP_DIR/updates/windows" "$ETC_DIR" "$DATA_DIR/transfers"
if ! id -u remote-codex >/dev/null 2>&1; then useradd --system --home-dir "$DATA_DIR" --no-create-home --shell /usr/sbin/nologin remote-codex; fi
install -d -o remote-codex -g remote-codex -m 700 "$DATA_DIR" "$DATA_DIR/transfers"
install -d -o root -g root -m 755 "$APP_DIR" "$APP_DIR/updates" "$APP_DIR/updates/windows"
install -m 644 "$ROOT/server/relay.mjs" "$APP_DIR/relay.mjs"
if [[ ! -f "$ETC_DIR/relay.env" ]]; then
  controller="$(openssl rand -hex 32)"; enrollment="$(openssl rand -hex 32)"
  cat > "$ETC_DIR/relay.env" <<EOF
REMOTE_CODEX_BIND_HOST=127.0.0.1
REMOTE_CODEX_BIND_PORT=18765
REMOTE_CODEX_CONTROLLER_TOKEN=$controller
REMOTE_CODEX_ENROLLMENT_TOKEN=$enrollment
REMOTE_CODEX_DEVICE_REGISTRY_PATH=$DATA_DIR/devices.json
REMOTE_CODEX_UPDATE_DIR=$APP_DIR/updates/windows
REMOTE_CODEX_TRANSFER_DIR=$DATA_DIR/transfers
REMOTE_CODEX_PUBLIC_HOST=$PUBLIC_HOST
REMOTE_CODEX_RDP_PORT_MIN=31000
REMOTE_CODEX_RDP_PORT_MAX=31999
EOF
  chmod 600 "$ETC_DIR/relay.env"
else
  controller="$(sed -n 's/^REMOTE_CODEX_CONTROLLER_TOKEN=//p' "$ETC_DIR/relay.env" | tail -1)"
  enrollment="$(sed -n 's/^REMOTE_CODEX_ENROLLMENT_TOKEN=//p' "$ETC_DIR/relay.env" | tail -1)"
fi
if [[ ! -f "$ETC_DIR/cert.pem" || ! -f "$ETC_DIR/key.pem" ]]; then
  openssl req -x509 -newkey rsa:2048 -nodes -days 825 -subj "/CN=$PUBLIC_HOST" -addext "subjectAltName=DNS:$PUBLIC_HOST,IP:127.0.0.1" -keyout "$ETC_DIR/key.pem" -out "$ETC_DIR/cert.pem" >/dev/null 2>&1
  chmod 600 "$ETC_DIR/key.pem"; chmod 644 "$ETC_DIR/cert.pem"
fi
fingerprint="$(openssl x509 -in "$ETC_DIR/cert.pem" -noout -fingerprint -sha256 | cut -d= -f2)"
cat > "$ETC_DIR/config.example.json" <<EOF
{
  "server": "https://$PUBLIC_HOST:$PUBLIC_PORT/remote-codex",
  "controllerToken": "$controller"
}
EOF
chmod 600 "$ETC_DIR/config.example.json"
install -m 644 "$ROOT/server/remote-codex-relay.service" /etc/systemd/system/remote-codex-relay.service
sed -i "s#^EnvironmentFile=.*#EnvironmentFile=$ETC_DIR/relay.env#" /etc/systemd/system/remote-codex-relay.service
systemctl daemon-reload
systemctl enable --now remote-codex-relay.service
cat <<EOF
Remote Codex Relay 已安装。
内部监听：127.0.0.1:18765
公网 URL（需 HTTPS 反向代理）：https://$PUBLIC_HOST:$PUBLIC_PORT/remote-codex
注册令牌：$enrollment
证书 SHA-256 指纹：$fingerprint
控制端配置模板：$ETC_DIR/config.example.json
环境变量：$ETC_DIR/relay.env
请勿把上述令牌、私钥或 relay.env 放进公开下载目录。
EOF
