# Remote Codex

[中文](README.md) · [English](README.en.md)

Remote Codex 是一个面向**已获授权的远程运维、远程支持和开发机管理**的开源工具集，当前优先支持 Windows 被控端。它把远程连接拆成三个可以独立部署和审计的部分：Windows Agent、中转 Relay，以及 Codex Skill。

项目由 [The One Tech / 泰安泽万泰克网络科技有限公司](https://github.com/zone3029) 维护。

## 产品核心优势

### 1. 自建 Relay 中转隧道，直接连接远端电脑

控制端和 Windows Agent 都主动连接你自己部署的 Relay，由 Relay 转发控制、文件、RDP 和桌面操作流量。被控端不需要暴露公网入站端口，通常也不需要配置端口映射；你可以把 Relay 部署在靠近主要用户或设备的云主机、内网节点或专用服务器上。

这让连接路径、带宽和服务器位置由你自己控制，减少对第三方公共中继节点的依赖。与向日葵、ToDesk 等通用远程桌面产品相比，Remote Codex 的重点是自建中转隧道和可编排的开发者运维能力；这里不对其他产品的性能作评价，也不表示存在任何关联。

### 2. 本地 AI 操作远端电脑，被控端无需配置 AI 环境

AI 工具运行在你的本地开发机或控制端。Codex Skill、CLI 和 Relay 将经过授权的命令、文件操作、RDP 或桌面操作发送到 Windows Agent，再由 Agent 调用被控端已有的 Windows 能力执行。

被控端只需要安装 Agent 和必要的系统组件，不需要再安装 Python、Node.js、模型、AI SDK、API Key 或另一套 AI 运行环境。这样可以把模型、提示词、账号和开发工具集中在管理员侧，同时保留被控端的权限控制和操作审计。

### 3. 局域网优先，公网中继自动兜底

Agent 会发现并上报被控端的私有 IPv4 地址和局域网控制端口。控制端在发起 RDP 时，会先筛选与本机同网段的地址并探测 Windows 3389 端口：局域网可达时直接连接，局域网不可达时再创建 Relay 隧道。这样适合在办公室、机房和同一园区内快速维护设备，也能在跨网段或外出时继续使用中转连接。

Agent 还提供带 HTTPS、自签名证书指纹、HMAC 签名短期票据、一次性 nonce、防重放和 SHA-256 校验的局域网接口，可处理命令、文件上传和下载；文件写入使用临时文件和原子替换，重复传输 ID 不会重复写入。

### 4. 截图、鼠标键盘控制和网页远程桌面

在 Windows 登录的交互桌面中，用户可以在 Agent 界面明确开启“允许 Codex 界面控制”。授权有效时，远程任务可以：

- 获取当前桌面尺寸和 PNG 截图；
- 移动鼠标，执行左键、右键和中键单击；
- 输入 Unicode 文本；
- 发送组合键；
- 垂直或水平滚动；
- 清理临时截图文件。

仓库中的 `web-rdp/` 还提供基于 Guacamole 的网页远程桌面界面，支持桌面画面流、键盘和鼠标事件。截图与界面控制需要远端用户登录并主动授权，适合让本地 AI 先观察画面，再在授权范围内完成图形化操作。

## 功能一览

| 功能 | 当前实现 | 适用场景 |
| --- | --- | --- |
| 设备发现与在线状态 | Relay 注册表、心跳、设备别名、局域网地址 | 管理多台 Windows 设备 |
| 局域网直连 | 同网段 RDP 探测；Agent 局域网 HTTPS 控制接口 | 办公室、机房、同一内网快速维护 |
| Relay 隧道 | HTTPS/WebSocket、RDP 端口转发、断线重连 | 跨网段、外网和无入站端口环境 |
| PowerShell 任务 | 超时、取消、退出码、输出回传、操作日志 | 软件安装、诊断、自动化运维 |
| 文件传输 | SHA-256 校验、原子写入、幂等传输、局域网接口 | 部署包、日志和配置文件传输 |
| 图形化控制 | 截图、鼠标、键盘、滚轮、网页 RDP | 需要观察和操作 Windows 桌面的任务 |
| 本地 AI 编排 | Codex Skill、CLI、交互命令桥 | 本地 AI 操作远端 Windows |


> ⚠️ **使用前必读：** 本项目仅适用于获得明确授权的设备和网络。请先阅读[免责声明与使用边界](DISCLAIMER.md)，再进行部署或运行。

## 这是什么

Remote Codex 让管理员可以通过自己部署的中转服务，连接已经安装并授权的 Windows Agent，然后执行受控的远程操作，例如：

- 查看已注册设备及在线状态；
- 执行经过授权的 PowerShell 命令；
- 上传、下载和校验文件；
- 创建受控的 RDP 会话；
- 在需要时使用 Windows 桌面和计算机操作能力；
- 让 Codex 按明确的目标设备和授权流程协助完成运维任务。

它不是公共远程桌面服务，也不提供绕过登录、绕过权限或隐藏驻留的功能。所有使用者都必须拥有目标设备和网络的明确授权。

## 三个核心部分

### 1. Windows Agent：远控端

目录：`electron-agent/`

Windows Agent 安装在被管理的 Windows 电脑上，负责：

- 生成并保存设备身份；
- 通过 HTTPS/WSS 连接自建 Relay；
- 接收经过认证的任务并在本机执行；
- 提供文件传输、RDP 和桌面操作桥接；
- 将任务状态、退出码和必要的非敏感结果返回控制端。

Agent 的连接地址、注册令牌和证书指纹由管理员配置。设备身份和运行时状态不会提交到本仓库。

### 2. Relay：中转端

目录：`server/`、`deploy/`

Relay 部署在 Linux 或 Docker 主机上，负责：

- 接收控制端和 Windows Agent 的 HTTPS/WebSocket 连接；
- 使用 controller token 和 enrollment token 区分控制端与设备注册；
- 转发任务、文件传输和 RDP 会话；
- 保存设备注册状态和操作所需的短期会话信息；
- 配合 Nginx/Caddy 和正式 HTTPS 证书对外提供服务。

Relay 是你的基础设施，不依赖第三方公共中转服务器。生产环境应限制管理端来源、保护令牌、使用正式证书并保留审计日志。

### 3. Codex Skill：智能运维入口

目录：`skill/remote-codex-operations/`

Codex Skill 把常用运维流程整理成可复用的操作规范：

1. 读取本机私有配置；
2. 先列出设备并确认目标；
3. 检查在线状态和操作范围；
4. 在用户明确授权后执行任务、取消任务、传输文件或启动 RDP；
5. 只汇报设备 ID、命令 ID、退出码和非敏感摘要。

Skill 不应读取或输出令牌、密码、私钥、`identity.json`、设备注册表等敏感文件。

## 目录结构

```text
remote-codex/
├── electron-agent/                 # Windows Agent 源码
├── server/                          # Node.js Relay 和反向代理示例
├── deploy/                          # Linux systemd、Docker 部署模板
├── client/                          # 控制端 CLI
├── skill/remote-codex-operations/   # Codex Skill
├── agent/                           # 实验性的 Rust Windows Worker
└── web-rdp/                         # 浏览器 RDP 界面和网关源码
```

## 快速开始

### 启动 Relay

```bash
cp deploy/docker/.env.example deploy/docker/.env
bash deploy/docker/generate-config.sh deploy/docker/.env
# 编辑 deploy/docker/.env，设置 REMOTE_CODEX_PUBLIC_HOST
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

Linux systemd 部署见[部署与使用指南](README-Remote-Codex-部署与使用.md)。公网部署必须使用 HTTPS 反向代理，并正确转发 WebSocket 和长连接。

### 启动 Windows Agent

```powershell
cd electron-agent
npm ci
npm start
```

然后在 Agent 中配置 Relay HTTPS 地址、注册令牌和证书 SHA-256 指纹。Windows 安装包构建还需要服务封装组件，具体见部署文档。

### 使用 CLI 和 Skill

复制 `client/config.example.json` 到私有目录，填写 Relay 地址和 controller token，并设置 `REMOTE_CODEX_CONFIG`。安装 `skill/remote-codex-operations/` 后，先列设备再选择目标：

```bash
node client/remote-codex.mjs devices
node client/remote-codex.mjs exec --device DEVICE_ID -- "Get-ChildItem"
```

## 平台范围

- 被控端：Windows 优先，Windows Agent 和 PowerShell/RDP 流程是当前主要支持范围；
- 中转端：Linux systemd 或 Docker；
- 控制端：Node.js CLI 和 Codex Skill；
- macOS：代码中保留了一部分兼容路径，但尚未作为本次公开版本的测试目标。

## 安全边界

仅在你明确拥有或获准管理的设备和网络上使用本项目。请勿把 `.env`、令牌、密码、私钥、设备身份、客户数据或运行时日志提交到 GitHub。RDP、文件传输、PowerShell 执行和服务管理都属于高影响操作，部署者应自行负责访问控制、审计、证书校验和令牌轮换。

发现安全问题请阅读 [SECURITY.md](SECURITY.md)，通过 `302911425@qq.com` 联系维护者，不要在公开 Issue 中粘贴真实凭据或客户数据。

## 文档

- [免责声明与使用边界](DISCLAIMER.md)
- [中文部署与使用指南](README-Remote-Codex-部署与使用.md)
- [English documentation](README.en.md)
- [操作变更记录](CHANGELOG.md)
- [贡献指南](CONTRIBUTING.md)

## 许可证

本项目采用 [Apache-2.0](LICENSE) 许可证。该协议允许商业使用；采用它是为了保持标准开源兼容性，并便于参与开源项目计划。
