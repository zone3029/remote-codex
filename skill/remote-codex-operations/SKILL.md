---
name: remote-codex-operations
description: 操作已授权的 Remote Codex Relay 和 Windows Agent，完成设备发现、在线检查、PowerShell 任务、取消、RDP 与文件传输。
---

# Remote Codex 运维

先读取用户指定或环境变量 REMOTE_CODEX_CONFIG 指向的 JSON 配置。配置至少包含 server 和 controllerToken；绝不在对话、日志或命令输出中打印令牌、密码、私钥、identity.json 或设备注册文件。

使用仓库内 client/remote-codex.mjs：

    node client/remote-codex.mjs devices
    node client/remote-codex.mjs exec --device DEVICE_ID -- powershell-command
    node client/remote-codex.mjs cancel --command COMMAND_ID
    node client/remote-codex.mjs rdp --device DEVICE_ID --ttl 43200

执行顺序：

1. 先列设备，按设备 ID 和别称确认目标；不要只凭“在线设备”猜测目标。
2. 需要执行、取消、RDP、上传或下载时，先确认用户已经明确授权目标和动作。
3. 提交任务后报告设备 ID、命令 ID、退出码和关键非敏感输出；长输出只保留摘要。
4. 远程服务器部署、令牌轮换、设备身份迁移和删除数据属于高影响操作，执行前再次确认范围。

Windows Agent 的“中转服务器”按钮保存的是用户数据目录中的 relay-config.json。服务器必须使用 HTTPS，并提供与证书匹配的 SHA-256 指纹；切换服务器会热重载 Worker，但不会重建设备身份。

不要读取或上传以下文件：relay.env、key.pem、identity.json、设备注册表、控制端配置中的令牌字段。遇到连接问题，优先检查 /health、证书指纹、反向代理 WebSocket、systemd/Docker 日志和 RDP 端口范围。
