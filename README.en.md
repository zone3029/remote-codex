# Remote Codex

[中文](README.md) · [English](README.en.md)

Remote Codex is an open-source toolkit for **authorized remote operations, remote support, and managed development machines**. The first public release focuses on Windows endpoints. It separates the system into three deployable and auditable parts: a Windows Agent, a Relay, and a Codex Skill.

The project is maintained by [The One Tech / 泰安泽万泰克网络科技有限公司](https://github.com/zone3029).

## Community

Join the **codeX AI交流群** QQ group: `444137478` to discuss Codex, AI development, and Remote Codex usage.

## Key product advantages

### 1. A self-hosted Relay tunnel for direct remote connectivity

The controller and Windows Agent both make outbound connections to a Relay that you operate. The Relay forwards control, file, RDP, and desktop-operation traffic through an authenticated tunnel. The managed computer normally does not need a public inbound port or manual port forwarding; you can place the Relay close to your users or devices on a cloud VM, internal node, or dedicated server.

You control the route, bandwidth, and Relay location instead of depending on a third-party public relay. Compared with general-purpose remote-desktop products such as Sunlogin or ToDesk, Remote Codex focuses on self-hosted tunneling and programmable developer operations. This is a capability distinction, not a performance claim or an affiliation with those products.

### 2. Local AI operates the remote computer without an AI runtime on the endpoint

The AI tool runs on your local development machine or controller. The Codex Skill, CLI, and Relay send authorized commands, file operations, RDP sessions, or desktop actions to the Windows Agent, which uses the endpoint’s existing Windows capabilities.

The managed computer only needs the Agent and required system components. It does not need Python, Node.js, a model, an AI SDK, an API key, or a second AI environment. Models, prompts, accounts, and developer tools can stay on the administrator side while endpoint permissions and operation auditing remain in place.

### 3. LAN first, Relay fallback when needed

The Agent discovers and registers private IPv4 addresses and a LAN control port. When the CLI starts an RDP session, it filters for addresses on the controller’s local subnet and probes the Windows 3389 port first. If the endpoint is reachable on the LAN, the connection is direct; otherwise the CLI creates a Relay tunnel. This is useful for fast maintenance in an office, server room, or campus network while remaining usable across networks or from outside the office.

The Agent also exposes authenticated LAN endpoints protected by HTTPS, a certificate fingerprint, short-lived HMAC tickets, one-time nonces, replay protection, and SHA-256 checks. They support commands, uploads, and downloads; file writes use temporary files and atomic replacement, and repeated transfer IDs are idempotent.

### 4. Screenshots, mouse and keyboard control, and Web RDP

In the signed-in Windows interactive desktop, a user can explicitly enable “Allow Codex interface control” in the Agent. While that consent is valid, an authorized task can:

- read the current desktop size and capture a PNG screenshot;
- move the mouse and perform left, right, or middle clicks;
- type Unicode text;
- send key combinations;
- scroll vertically or horizontally;
- remove temporary screenshot files.

The `web-rdp/` directory also provides a Guacamole-based browser RDP interface with desktop streaming, keyboard input, and mouse events. Screenshot and interface control require a logged-in interactive user and active consent. This lets a local AI observe the screen and complete graphical operations within the approved scope.

## Feature overview

| Capability | Implemented behavior | Typical use |
| --- | --- | --- |
| Device discovery | Relay registry, heartbeats, aliases, and LAN addresses | Manage multiple Windows endpoints |
| LAN connectivity | Same-subnet RDP probe and authenticated Agent LAN API | Fast office, server-room, or campus maintenance |
| Relay tunnel | HTTPS/WebSocket, RDP port forwarding, reconnect handling | Cross-subnet, Internet, and no-inbound-port environments |
| PowerShell jobs | Timeouts, cancellation, exit codes, output, and operation logs | Installation, diagnostics, and automation |
| File transfer | SHA-256 checks, atomic writes, idempotent transfers, and LAN API | Packages, logs, and configuration files |
| Graphical control | Screenshots, mouse, keyboard, scroll, and browser RDP | Tasks that require viewing and operating Windows UI |
| Local AI orchestration | Codex Skill, CLI, and interactive command bridge | Local AI operating a remote Windows endpoint |


> ⚠️ **Read before use:** This project is for explicitly authorized computers and networks only. Read the [disclaimer and acceptable-use boundary](DISCLAIMER.en.md) before deployment or operation.

## What this project is

Remote Codex lets an administrator connect to an installed and authorized Windows Agent through a Relay that they operate. It supports workflows such as:

- listing registered devices and checking online status;
- running authorized PowerShell commands;
- uploading, downloading, and verifying files;
- creating controlled RDP sessions;
- using Windows desktop and computer-use capabilities when required;
- letting Codex follow an explicit target and authorization workflow for operations.

It is not a public remote-desktop service. It does not provide login bypass, privilege bypass, or hidden persistence. Users must have explicit authorization for every target computer and network.

## The three core parts

### 1. Windows Agent

Directory: `electron-agent/`

The Windows Agent runs on the managed Windows computer. It:

- creates and stores the device identity;
- connects to a self-hosted Relay over HTTPS/WSS;
- receives authenticated jobs and runs them locally;
- provides file transfer, RDP, and desktop-operation bridges;
- returns task status, exit codes, and necessary non-sensitive results.

The Relay URL, enrollment token, and certificate fingerprint are administrator-provided settings. Device identity and runtime state are never part of this repository.

### 2. Relay

Directories: `server/`, `deploy/`

The Relay runs on a Linux or Docker host. It:

- accepts HTTPS/WebSocket connections from the controller and Agents;
- separates controller access from device enrollment with dedicated tokens;
- routes jobs, file transfers, and RDP sessions;
- stores device registration state and short-lived session data needed for operations;
- works behind Nginx or Caddy with a proper HTTPS certificate.

The Relay is your infrastructure; the project does not depend on a public third-party relay. Production deployments should restrict management origins, protect tokens, use a trusted certificate, and retain audit logs.

### 3. Codex Skill

Directory: `skill/remote-codex-operations/`

The Codex Skill turns the safe operating procedure into a reusable workflow:

1. read a private local configuration;
2. list devices and confirm the target;
3. check online status and operation scope;
4. execute, cancel, transfer files, or start RDP only after explicit user authorization;
5. report device ID, command ID, exit code, and a non-sensitive summary.

The Skill must not read or print tokens, passwords, private keys, `identity.json`, device registries, or other sensitive files.

## Repository layout

```text
remote-codex/
├── electron-agent/                 # Windows Agent source
├── server/                          # Node.js Relay and proxy examples
├── deploy/                          # Linux systemd and Docker templates
├── client/                          # Controller CLI
├── skill/remote-codex-operations/   # Codex Skill
├── agent/                           # Experimental Rust Windows Worker
└── web-rdp/                         # Browser RDP UI and gateway source
```

## Quick start

### Start the Relay

```bash
cp deploy/docker/.env.example deploy/docker/.env
bash deploy/docker/generate-config.sh deploy/docker/.env
# edit deploy/docker/.env and set REMOTE_CODEX_PUBLIC_HOST
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

The generator creates separate random controller and enrollment tokens. The controller token is for the CLI and Skill; the enrollment token is for first-time Windows Agent registration. It does not issue a public HTTPS certificate, so production still needs Nginx, Caddy, or a cloud load balancer in front of the Relay. For systemd paths and the exact Agent `relay-config.json` format, see the [bilingual deployment and usage guide](README-Remote-Codex-部署与使用.md). Never commit `.env` or `relay-config.json`.

### Start the Windows Agent

```powershell
cd electron-agent
npm ci
npm start
```

Configure the Relay HTTPS URL, enrollment token, and public certificate SHA-256 fingerprint in the Agent. You can import a private `relay-config.json` containing `server`, `enrollmentToken`, and `certificateFingerprint256`; do not publish this file. Building the Windows installer also requires the service wrapper described in the deployment guide.

### Use the CLI and Skill

Copy `client/config.example.json` to a private location, fill in the Relay URL and controller token, set its permissions to `0600`, and set `REMOTE_CODEX_CONFIG` (or use the default `~/.config/remote-codex/config.json`). The CLI and Skill use this same file. After installing `skill/remote-codex-operations/`, list devices before selecting a target:

```bash
node client/remote-codex.mjs devices
node client/remote-codex.mjs exec --device DEVICE_ID -- "Get-ChildItem"
```

## Platform scope

- Endpoint: Windows first; Windows Agent, PowerShell, and RDP flows are the primary supported scope.
- Relay: Linux systemd or Docker.
- Controller: Node.js CLI and Codex Skill.
- macOS: some compatibility paths exist in the code, but macOS is not a tested target of this public release.

## Security boundary

Use this project only on computers and networks you own or are explicitly authorized to administer. Do not commit `.env` files, tokens, passwords, private keys, device identities, customer data, or runtime logs to GitHub. RDP, file transfer, PowerShell execution, and service management are high-impact operations; operators are responsible for access control, auditing, certificate validation, and token rotation.

For vulnerability reports, read [SECURITY.md](SECURITY.md) and contact `302911425@qq.com`. Never paste real credentials or customer data into a public issue.

## Documentation

- [免责声明与使用边界](DISCLAIMER.en.md)
- [中文部署与使用指南](README-Remote-Codex-部署与使用.md)
- [English deployment overview](README-Remote-Codex.md)
- [Changelog](CHANGELOG.md)
- [Contributing guide](CONTRIBUTING.md)

## License

Licensed under [Apache-2.0](LICENSE). Apache-2.0 permits commercial use; this license was chosen to preserve standard open-source compatibility and make the project easier to include in open-source programs.
