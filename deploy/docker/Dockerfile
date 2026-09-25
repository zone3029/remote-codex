FROM node:22-bookworm-slim
RUN useradd --system --home-dir /var/lib/remote-codex --no-create-home --shell /usr/sbin/nologin remote-codex \
    && mkdir -p /opt/remote-codex/updates/windows /var/lib/remote-codex/transfers \
    && chown -R remote-codex:remote-codex /opt/remote-codex /var/lib/remote-codex
WORKDIR /opt/remote-codex
COPY server/relay.mjs ./relay.mjs
USER remote-codex
EXPOSE 18765
CMD ["node", "relay.mjs"]
