# 部署参考

## 生成中转配置

Relay 会生成两类令牌：`controller token` 给本地 CLI 和 Codex Skill，`enrollment token` 给 Windows Agent 首次注册。两者不能互换。

### Linux systemd

在源码根目录运行：

```bash
sudo bash deploy/install.sh
```

脚本会创建 `/etc/remote-codex/relay.env`、控制端配置模板、随机令牌和自签名证书，并在终端输出 Agent 需要的 enrollment token 与证书 SHA-256 指纹。生产环境应把 Nginx 或其他 HTTPS 反向代理放在 `127.0.0.1:18765` 前面。

### Docker

```bash
cp deploy/docker/.env.example deploy/docker/.env
bash deploy/docker/generate-config.sh deploy/docker/.env
# 编辑 deploy/docker/.env，设置 REMOTE_CODEX_PUBLIC_HOST
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

脚本使用 `openssl rand -hex 32` 生成两个随机令牌，已有 `.env` 时不会覆盖。它不生成公网 HTTPS 证书；公开证书的指纹要提供给 Agent。公网只暴露 HTTPS 代理和 RDP 端口段，不要直接公开控制端口。

## Windows Agent 配置文件

可在安全目录创建私有 `relay-config.json` 后从 Agent 界面导入：

```json
{
  "server": "https://relay.example.com/remote-codex",
  "enrollmentToken": "<token printed by the Relay deployment>",
  "certificateFingerprint256": "<SHA-256 fingerprint of the public HTTPS certificate>"
}
```

不要将该文件提交到仓库、镜像或 Release。Agent 保存后即可注册；切换服务器不会重建设备 ID。

## CLI 与 Skill 配置

CLI 和 Skill 共用：

```bash
mkdir -p ~/.config/remote-codex
cp client/config.example.json ~/.config/remote-codex/config.json
chmod 600 ~/.config/remote-codex/config.json
export REMOTE_CODEX_CONFIG="$HOME/.config/remote-codex/config.json"
```

其中 `controllerToken` 必须是 Relay 的 controller token。Skill 执行远程操作前应先读取这份私有配置并列出设备确认目标；不得读取或输出令牌、私钥、`identity.json` 或设备注册表。
