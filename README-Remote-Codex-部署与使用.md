# Remote Codex 部署与使用

本仓库包含 Windows Agent 源码、Linux systemd 部署脚本、Docker 部署模板、控制端 CLI 和 Codex skill。仓库不包含任何生产令牌、证书私钥、设备身份、运行时状态或真实服务器配置。

## 1. Linux 一键部署

在源码根目录执行：

    sudo bash deploy/install.sh

脚本会安装 relay.mjs、创建 remote-codex 系统用户和 systemd 服务，并在 /etc/remote-codex 生成随机控制端令牌、设备注册令牌及自签名证书。输出中的服务器 URL、注册令牌和证书 SHA-256 指纹只应通过安全渠道交给管理员。

Relay 只监听 127.0.0.1:18765。生产环境需要 Nginx、Caddy 或云负载均衡提供 HTTPS，并转发 /remote-codex/ 路径，同时允许 WebSocket 和长连接。RDP 转发端口默认是 31000-31999，防火墙只开放给受信任网络。

## 2. Docker 部署

进入 deploy/docker，运行：

    cp .env.example .env
    bash generate-config.sh

修改 .env 中的 REMOTE_CODEX_PUBLIC_HOST，然后在源码根目录执行：

    docker compose -f deploy/docker/docker-compose.yml up -d --build

公网仍应使用 HTTPS 反向代理。nginx.conf.example 是最小配置示例；证书可以使用正式 CA 证书。不要把 .env 提交到 Git 或公开目录。

## 3. Windows Agent 配置中转服务器

打开 Agent 主界面，点击右上角“中转服务器”。填写：

- 服务器 URL：HTTPS 地址，例如 https://relay.example.com/remote-codex
- 注册令牌：Linux/Docker 部署输出的 enrollment token；留空表示保持当前令牌
- 证书 SHA-256 指纹：部署输出的证书指纹，允许冒号、空格或连续十六进制字符

点击“测试连接”会请求 /health 并固定校验证书；点击“保存并重新连接”后 Worker 会关闭旧 RDP 隧道、重新注册设备并继续轮询。设备 ID 和 identity.json 不会被重建。

## 4. 控制端 CLI

复制 client/config.example.json 为本机私有配置，填写 server 和 controllerToken，并设置 REMOTE_CODEX_CONFIG 指向它。常用命令：

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
