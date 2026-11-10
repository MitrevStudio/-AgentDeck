# AgentDeck relay: routes mesh traffic between paired AgentDecks (end-to-end TLS tunnels it cannot read or act on)
# and runs nothing of its own. Built from the repository root:
#   docker build -f host/Dockerfile -t agentdeck-relay .
# Its identity, pairing code and paired computers live in /data: keep that a volume, or every start is a new relay
# that has to be paired again.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# The packages first, so a code change does not reinstall them. --ignore-scripts: node-pty is not built, as a relay
# never opens a terminal, and is removed (only `--with-api` would need it, with a C toolchain and the agents installed).
COPY host/package.json host/package-lock.json host/
RUN cd host && npm ci --omit=dev --ignore-scripts --no-audit --no-fund && rm -rf node_modules/node-pty && npm cache clean --force

# What install.sh checks out: the host and the shared code it runs.
COPY host/bin host/bin
COPY src/host src/host
COPY src/mesh src/mesh
COPY src/shared src/shared

# `agentdeck-host pair` and the rest work in `docker exec` without naming the data directory.
# The data directory goes last: `pair-to ADDRESS PORT CODE` reads its arguments up to the first option.
RUN printf '#!/bin/sh\nexec node /app/host/bin/agentdeck-host.js "$@" --data-dir /data\n' \
      > /usr/local/bin/agentdeck-host \
 && chmod +x /usr/local/bin/agentdeck-host \
 && mkdir -p /data && chown node:node /data

USER node
VOLUME /data
EXPOSE 7421

# The relay is up when its port takes a connection.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e 'require("net").connect(7421,"127.0.0.1").on("connect",()=>process.exit(0)).on("error",()=>process.exit(1))'

# --no-discovery: mDNS does not leave a container's network; peers reach the relay by its address.
ENTRYPOINT ["agentdeck-host"]
CMD ["run", "--no-discovery"]
