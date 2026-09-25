#!/usr/bin/env bash
set -euo pipefail
if [[ \${EUID:-\$(id -u)} -ne 0 ]]; then echo "请使用 root 运行"; exit 1; fi
systemctl disable --now remote-codex-relay.service 2>/dev/null || true
rm -f /etc/systemd/system/remote-codex-relay.service
systemctl daemon-reload
echo "已停止并移除 systemd 服务；/opt/remote-codex、/etc/remote-codex 和 /var/lib/remote-codex 保留，需确认后手动删除。"
