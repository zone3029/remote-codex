# Remote Codex 网页远程桌面

访问地址：`https://relay.example.com/remote-codex/web-rdp/`

## 使用

1. 输入网页访问口令进入控制台。
2. 从左侧选择在线 Windows 设备。
3. 输入 Windows 账户和密码。密码只用于当前 Guacamole 会话，不写入网页本地存储。
4. 选择会话时长后连接。关闭页面或点击“断开连接”会结束会话。

Windows 用户名使用完整格式，例如：`DESKTOP-0SE6UTU\\zone`。Windows Hello PIN 不能代替账户密码。

## 服务组成

- `web-rdp/server/gateway.cjs`：网页登录、设备查询、会话创建和关闭。
- `guacamole-lite`：浏览器 WebSocket 到 Guacamole 协议的 Node 网关。
- `guacd`：服务器本机 RDP 协议转换服务，仅监听 `127.0.0.1:4822`。
- 现有 Remote Codex Relay：继续负责设备隧道和固定 RDP 端口。

网页访问口令、Guacamole 加密密钥和中继控制令牌保存在服务器 `/etc/remote-codex/web-rdp.env` 或 relay 配置中，不要提交到代码仓库。
