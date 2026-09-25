# Remote Codex 使用与部署教程

## 一、Linux 一键部署

在源码包根目录执行：

    sudo bash deploy/install.sh

脚本会创建 remote-codex 系统用户、Relay systemd 服务、随机控制端令牌、设备注册令牌和自签名证书。安装完成后会输出中继服务器地址、设备注册令牌、证书 SHA-256 指纹和控制端配置文件位置。

Relay 默认只监听 127.0.0.1:18765。生产环境需要在前面配置 Nginx 或 Caddy，提供 HTTPS，并转发 /remote-codex/ 和 WebSocket 长连接。

## 二、Docker 部署

进入 deploy/docker 目录：

    cp .env.example .env
    bash generate-config.sh

修改 .env 中的 REMOTE_CODEX_PUBLIC_HOST，然后在源码根目录执行：

    docker compose -f deploy/docker/docker-compose.yml up -d --build

公网访问必须通过 HTTPS 反向代理，不能直接把控制端口暴露到公网。

## 三、安装 Windows Agent

运行压缩包内的：

    windows/Remote Codex Agent Setup 0.4.35.exe

安装完成后打开 Agent，点击界面右上角的“中转服务器”按钮，填写服务器 URL、设备注册令牌和服务器证书 SHA-256 指纹。

点击“测试连接”确认服务器和证书正常，再点击“保存并重新连接”。切换服务器不会改变设备 ID。

## 四、控制端 CLI

复制 client/config.example.json 为私有配置文件，填写 server 和 controllerToken。设置环境变量 REMOTE_CODEX_CONFIG 指向该文件，然后执行：

    node client/remote-codex.mjs devices
    node client/remote-codex.mjs exec --device DEVICE_ID -- "Get-ChildItem"
    node client/remote-codex.mjs rdp --device DEVICE_ID --ttl 43200
    node client/remote-codex.mjs cancel --command COMMAND_ID

执行任务前先使用 devices 确认目标设备和设备 ID。

## 五、Codex skill

skill 目录为 skill/remote-codex-operations。安装到 Codex skills 目录后，可以按授权流程执行设备发现、在线检查、远程命令、取消、RDP 和文件传输。

## 六、故障排查

- Linux 服务：systemctl status remote-codex-relay
- 服务日志：journalctl -u remote-codex-relay
- 健康检查：访问服务器 URL 的 /health
- 注册失败：检查注册令牌、证书指纹、服务器时间和反向代理路径
- RDP 失败：检查 31000-31999 端口范围、防火墙和 WebSocket 转发

## 七、安全要求

不要公开 relay.env、证书私钥、设备注册表、identity.json、relay-config.json 或控制端令牌。证书指纹校验不能通过关闭 TLS 校验来绕过。
