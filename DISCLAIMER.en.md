# Disclaimer and acceptable-use boundary

Last updated: 2026-09-25

Read this document before installing, deploying, compiling, modifying, or running Remote Codex. By using the project, you acknowledge that you are responsible for its operation, deployment, and administration.

## 1. Authorized systems only

Remote Codex may be used only on computers, accounts, networks, and data that you own, administer, or are explicitly authorized to access. Authorization should identify the target systems, operators, time period, and permitted actions, and must comply with applicable law, contracts, workplace policies, and privacy requirements.

The following uses are outside the project’s authorization boundary:

- accessing, controlling, monitoring, or maintaining access to another person’s computer, server, or network without consent;
- stealing, guessing, transferring, or misusing passwords, tokens, certificates, private keys, cookies, or other credentials;
- bypassing login, privilege, audit, certificate, security-software, or organizational access controls;
- covert surveillance, keylogging, data theft, hidden persistence, extortion, destruction, cryptomining, or other malicious activity;
- scanning, attacking, stress-testing, or disrupting systems outside your administrative scope;
- violating data-protection, employment, communications, export-control, or other applicable laws.

## 2. The operator owns the operational responsibility

You are responsible for:

- obtaining and retaining verifiable authorization and any required user notice or consent;
- applying least privilege, strong authentication, and network access controls to the Agent, Relay, controller, and Codex;
- protecting and rotating controller tokens, enrollment tokens, certificates, private keys, device identities, and administrator credentials;
- using a trusted HTTPS certificate, restricting management origins, enabling audit logs, and fixing exposed services promptly;
- confirming the target, scope, and impact before PowerShell execution, file transfer, RDP, or desktop operations;
- complying with privacy and data-governance obligations for personal, business, and customer data;
- independently assessing the security of the deployment environment, third-party dependencies, operating systems, and network devices.

## 3. No public hosting or authorization by implication

This project is self-hosted source code. It does not mean that the maintainers provide a public Relay, host remote desktops, obtain consent for you, or decide whether an operation is lawful. The existence of a capability in the code does not authorize anyone to use it against a third-party system.

The project name, maintainer name, GitHub organization, and trademarks do not endorse any third-party product, service, or activity. Do not imply that the maintainers participated in, approved, or guaranteed your deployment, product, or operation without written permission.

## 4. No warranty and limitation of liability

The project is provided under Apache-2.0 on an “AS IS” basis. The maintainers do not warrant that it is suitable for your business, systems, or legal environment, or that it will be continuously available, error-free, secure, lossless, or compliant with a particular regulatory regime.

To the maximum extent permitted by applicable law, the maintainers are not liable for direct or indirect loss, data loss, business interruption, privacy incidents, access-control failures, third-party claims, or regulatory penalties arising from downloading, compiling, deploying, modifying, running, disabling, or misusing the project. Complete independent testing, backups, approvals, and risk assessment before production use.

This document is not legal, security, privacy, employment, export-control, or compliance advice. Consult a qualified professional when needed.

## 5. Security and abuse reports

Do not post tokens, passwords, private keys, device identities, customer data, or a complete exploitable attack detail in a public issue. For vulnerabilities, read [SECURITY.md](SECURITY.md) and contact `302911425@qq.com`.

If you observe clear unauthorized access, malicious control, or unlawful use of this project, send verifiable information to the same address. Do not access, damage, or expand the impact of a system merely to verify suspected abuse.

## 6. Relationship to the open-source license

This document states the intended use boundary, operator responsibilities, and maintainer disclaimers. Copyright permissions remain governed by [Apache-2.0 LICENSE](LICENSE); Apache-2.0 grants copyright permissions and does not authorize unlawful or unauthorized conduct.
