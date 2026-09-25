# Remote Codex

Remote Codex is a Windows-first, authorized remote operations toolkit published by [The One Tech](https://github.com/zone3029). It contains the Windows Agent, a relay service, a control CLI, deployment templates, and a Codex skill.

This repository contains source code and configuration templates. Production tokens, private keys, device identities, runtime state, installers, and generated build directories are intentionally excluded.

## Components

- `electron-agent/` — Windows desktop Agent and local computer-use bridge.
- `server/` — Node.js relay service and systemd/Nginx examples.
- `client/` — command-line controller.
- `skill/remote-codex-operations/` — Codex skill for authorized operations.
- `agent/` — experimental Rust worker implementation for Windows environments.
- `web-rdp/` — browser RDP interface and gateway source.
- `deploy/` — Linux and Docker deployment templates.

## Quick start

### Relay

```bash
cd remote-codex
cp deploy/docker/.env.example deploy/docker/.env
bash deploy/docker/generate-config.sh deploy/docker/.env
# edit deploy/docker/.env and set REMOTE_CODEX_PUBLIC_HOST
docker compose -f deploy/docker/docker-compose.yml up -d --build
```

For a systemd installation, use `sudo bash deploy/install.sh` on a Linux host and put an HTTPS reverse proxy in front of the relay.

### Windows Agent

```powershell
cd electron-agent
npm ci
npm start
```

The Agent connects to a relay with an HTTPS URL, enrollment token, and certificate SHA-256 fingerprint. The Windows installer build also requires the service wrapper described in the deployment guide.

### CLI and Codex skill

Copy `client/config.example.json` to a private path, fill in the relay URL and controller token, and set `REMOTE_CODEX_CONFIG`. Install `skill/remote-codex-operations/` into the Codex skills directory. Always list devices before selecting a target.

## Authorization and security

Use this project only on computers and networks where you have explicit authorization. Keep `.env`, relay state, private keys, device identities, and controller configuration outside version control with restrictive permissions. Do not put tokens or passwords in issues, logs, screenshots, or chat messages. See [SECURITY.md](SECURITY.md) for vulnerability reports.

RDP, file transfer, PowerShell execution, and service management are high-impact operations. Operators are responsible for access control, audit logging, certificate validation, and token rotation.

## Platform scope

The first public release targets Windows endpoints and Linux/Docker relay hosts. macOS support is not part of the tested release yet.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE). Apache-2.0 permits commercial use; this choice keeps the project compatible with common open-source programs and dependencies.
