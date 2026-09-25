#!/usr/bin/env bash
set -euo pipefail
target="${1:-.env}"
if [[ -e "$target" ]]; then echo "$target 已存在，未覆盖"; exit 1; fi
controller="$(openssl rand -hex 32)"
enrollment="$(openssl rand -hex 32)"
sed -e "0,/replace-with-openssl-rand-hex-32/s//$controller/" \
    -e "0,/replace-with-openssl-rand-hex-32/s//$enrollment/" \
    .env.example > "$target"
chmod 600 "$target"
echo "已生成 $target。请修改 REMOTE_CODEX_PUBLIC_HOST，并为公网 HTTPS 配置反向代理。"
