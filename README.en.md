# Remote Codex

[中文](README.md) · [English](README.en.md)

Remote Codex is an open-source toolkit for **authorized remote operations, remote support, and managed development machines**. The first public release focuses on Windows endpoints. It separates the system into three deployable and auditable parts: a Windows Agent, a Relay, and a Codex Skill.

The project is maintained by [The One Tech / 泰安泽万泰克网络科技有限公司](https://github.com/zone3029).

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

For systemd, see the [deployment and usage guide](README-Remote-Codex-部署与使用.md). A public deployment must use an HTTPS reverse proxy with WebSocket and long-connection support.

### Start the Windows Agent

```powershell
cd electron-agent
npm ci
npm start
```

Configure the Relay HTTPS URL, enrollment token, and certificate SHA-256 fingerprint in the Agent. Building the Windows installer also requires the service wrapper described in the deployment guide.

### Use the CLI and Skill

Copy `client/config.example.json` to a private location, fill in the Relay URL and controller token, and set `REMOTE_CODEX_CONFIG`. After installing `skill/remote-codex-operations/`, list devices before selecting a target:

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

- [中文部署与使用指南](README-Remote-Codex-部署与使用.md)
- [English deployment overview](README-Remote-Codex.md)
- [Changelog](CHANGELOG.md)
- [Contributing guide](CONTRIBUTING.md)

## License

Licensed under [Apache-2.0](LICENSE). Apache-2.0 permits commercial use; this license was chosen to preserve standard open-source compatibility and make the project easier to include in open-source programs.
