#!/usr/bin/env bash
set -euo pipefail
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
target="${1:-$script_dir/.env}"
if [[ -e "$target" ]]; then echo "$target 已存在，未覆盖"; exit 1; fi
mkdir -p "$(dirname "$target")"
controller="$(openssl rand -hex 32)"
enrollment="$(openssl rand -hex 32)"
awk -v controller="$controller" -v enrollment="$enrollment" '
/^REMOTE_CODEX_CONTROLLER_TOKEN=/ { print "REMOTE_CODEX_CONTROLLER_TOKEN=" controller; next }
/^REMOTE_CODEX_ENROLLMENT_TOKEN=/ { print "REMOTE_CODEX_ENROLLMENT_TOKEN=" enrollment; next }
{ print }
' "$script_dir/.env.example" > "$target"
chmod 600 "$target"
echo "已生成 ${target}。请修改 REMOTE_CODEX_PUBLIC_HOST，并为公网 HTTPS 配置反向代理。"
