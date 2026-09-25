# Remote Codex 部署与使用

本仓库包含 Windows Agent 源码、Linux systemd 部署脚本、Docker 部署模板、控制端 CLI 和 Codex skill。仓库不包含任何生产令牌、证书私钥、设备身份、运行时状态或真实服务器配置。

## 0. 使用前免责声明

本项目只能用于你拥有或已经取得明确授权的设备、账号、网络和数据。禁止用于未授权访问、隐蔽监控、凭据窃取、绕过权限、持久化植入、勒索、破坏、挖矿、攻击或干扰第三方系统。部署者负责取得授权、保护令牌和私钥、限制访问来源、保存审计记录，并承担隐私、数据保护和其他合规责任。

请先阅读完整的[免责声明与使用边界](DISCLAIMER.md)。维护者不提供公共中转服务，也不对你的部署、操作或滥用行为负责。

## 1. Linux 一键部署

在源码根目录执行：

    sudo bash deploy/install.sh

脚本会安装 relay.mjs、创建 remote-codex 系统用户和 systemd 服务，并在 /etc/remote-codex 生成随机控制端令牌、设备注册令牌及自签名证书。输出中的服务器 URL、注册令牌和证书 SHA-256 指纹只应通过安全渠道交给管理员。

Relay 只监听 127.0.0.1:18765。生产环境需要 Nginx、Caddy 或云负载均衡提供 HTTPS，并转发 /remote-codex/ 路径，同时允许 WebSocket 和长连接。RDP 转发端口默认是 31000-31999，防火墙只开放给受信任网络。

## 2. 生成中转服务配置（Linux 与 Docker 通用说明）

中转端会生成两类令牌，不能混用：

- **controller token**：给控制端 CLI 和 Codex Skill 使用，用于调用 Relay API。
- **enrollment token**：给 Windows Agent 首次注册使用，用于把被控端加入 Relay。

Linux systemd 部署会自动生成配置。安装完成后重点查看：

- `/etc/remote-codex/relay.env`：Relay 运行配置，含随机令牌和端口；
- `/etc/remote-codex/config.example.json`：控制端配置模板；
- `/etc/remote-codex/cert.pem`、`key.pem`：HTTPS 证书和私钥；脚本会输出证书 SHA-256 指纹。

```bash
sudo bash deploy/install.sh
```

请把安装输出中的 enrollment token 和证书指纹通过安全渠道交给 Agent 管理员，把 controller token 写入控制端私有配置。不要把这些值提交到 Git、粘贴到公开 Issue 或放入安装包。

Docker 部署需要先生成自己的 `.env`：

```bash
cd deploy/docker
cp .env.example .env
bash generate-config.sh .env
# 编辑 .env，至少设置 REMOTE_CODEX_PUBLIC_HOST
cd ../..
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

`generate-config.sh` 会用 `openssl rand -hex 32` 生成 controller token 和 enrollment token；如果 `.env` 已存在，脚本不会覆盖。Docker 只生成令牌，不会替你申请公网证书；生产环境仍要在 Relay 前配置 Nginx、Caddy 或云负载均衡的 HTTPS 反向代理，并将公开证书的 SHA-256 指纹提供给 Agent。不要把 `.env` 提交到 Git 或公开目录。

## 3. Windows Agent 配置中转服务器

打开 Agent 主界面，点击右上角“中转服务器”。也可以先在安全目录手动生成一个私有配置文件 `relay-config.json`（不要放在仓库中）：

```json
{
  "server": "https://relay.example.com/remote-codex",
  "enrollmentToken": "从 Linux/Docker Relay 输出复制的注册令牌",
  "certificateFingerprint256": "Relay 公网 HTTPS 证书的 SHA-256 指纹"
}
```

在 Agent 的“中转服务器”窗口导入或填写该文件，然后点击“测试连接”和“保存并重新连接”。字段含义如下：

- `server`：Relay 的 HTTPS 公网地址；
- `enrollmentToken`：只用于 Agent 首次注册，不能填 controller token；
- `certificateFingerprint256`：Relay 公网证书指纹，允许冒号、空格或连续十六进制字符。

Agent 会把配置保存到自己的用户数据目录。若需要迁移，可从界面导出后通过安全渠道传递；不要把 `relay-config.json` 放进 GitHub Release、Docker 镜像或公开下载目录。点击“测试连接”会请求 `/health` 并固定校验证书；保存后 Worker 会重新注册设备，设备 ID 不会被重建。

## 4. 控制端 CLI 与 Codex Skill 配置

CLI 和 Skill 共用控制端配置文件。生成方式：

```bash
mkdir -p ~/.config/remote-codex
cp client/config.example.json ~/.config/remote-codex/config.json
# 编辑 config.json，填写 server、controllerToken，可选 defaultDevice
chmod 600 ~/.config/remote-codex/config.json
export REMOTE_CODEX_CONFIG="$HOME/.config/remote-codex/config.json"
```

其中 `server` 是 Relay 的 HTTPS 地址，`controllerToken` 必须来自 Relay 的 controller token，不能使用 Agent 的 enrollment token。Skill 会读取同一个 `REMOTE_CODEX_CONFIG`（未设置时默认读取 `~/.config/remote-codex/config.json`），安装 Skill 后先列设备再选择目标。

常用命令：

    node client/remote-codex.mjs devices
    node client/remote-codex.mjs exec --device DEVICE_ID -- "Get-ChildItem"
    node client/remote-codex.mjs cancel --command COMMAND_ID
    node client/remote-codex.mjs rdp --device DEVICE_ID --ttl 43200

每次执行前先列设备确认 device ID；不要将令牌、密码、私钥或完整配置粘贴到聊天记录。

## 5. Codex skill

skill 位于 skill/remote-codex-operations。将该目录安装到 Codex 的 skills 目录后，Codex 可以按安全流程列设备、检查在线状态、执行任务、取消任务和启动 RDP。skill 要求先确认目标设备，不会读取 relay.env、key.pem、identity.json 或设备注册表。

## 6. 开机自启和迁移

Windows 安装包会安装 RemoteCodexAgentService，以 LocalSystem 身份在登录前启动 Worker；用户界面登录后只负责配置和状态显示。切换服务器不会生成新设备 ID。迁移服务器时先备份设备注册表，再把同一设备的 agent token 按照服务器迁移流程导入；若服务器没有旧注册记录，Agent 会使用新的 enrollment token 注册。

## 7. 故障排查

检查 systemd：systemctl status remote-codex-relay、journalctl -u remote-codex-relay。

检查健康接口：访问 HTTPS 地址的 /health。若健康检查失败，先检查 Nginx 路径、证书指纹、WebSocket Upgrade、18765 本地监听和防火墙 RDP 端口段。

Agent 无法注册通常是 enrollment token 错误、证书指纹不匹配、服务器时间异常或旧设备注册记录冲突。不要通过关闭证书校验来绕过问题。

## 8. 安全注意事项

relay.env、key.pem、devices.json、identity.json、relay-config.json 和控制端配置必须保持 0600 权限。公开下载目录只放安装包、blockmap、latest.yml 和 checksums.sha256。生产部署应使用正式域名证书、限制管理端来源并定期轮换令牌。
