# AgentDeck relay: routes mesh traffic between paired AgentDecks (end-to-end TLS tunnels it cannot read or act on)
# and runs nothing of its own. Built from the repository root:
#   docker build -f host/Dockerfile -t agentdeck-relay .
# The same image is a resource host when its command has `--with-api` (docker-compose.yml, the service "host"): the
# computers paired with it open terminals in the container and forward its ports. No agent is installed in it.
# Its identity, pairing code and paired computers live in /data: keep that a volume, or every start is a new relay
# that has to be paired again.
FROM node:24-alpine

ENV NODE_ENV=production
WORKDIR /app

# The packages first, so a code change does not reinstall them. node-pty is built here, with a compiler that stays
# for this one layer only: a relay never opens a terminal, but the same image run with `--with-api` does (a shell in
# the container, whose "Ports" menu is the way to this machine's ports - docker-compose.yml, the service "host").
# What node-pty brings for Windows and macOS (58 MB of prebuilt binaries, winpty, conpty) is not kept.
COPY host/package.json host/package-lock.json host/
RUN apk add --no-cache --virtual .build python3 make g++ \
 && cd host && npm ci --omit=dev --no-audit --no-fund \
 && rm -rf node_modules/node-pty/prebuilds node_modules/node-pty/deps node_modules/node-pty/third_party \
 && node -e 'require("node-pty")' \
 && npm cache clean --force && rm -rf /root/.cache /root/.npm /tmp/* \
 && apk del .build
# The terminals' shell (src/host/terminals-pty.js asks $SHELL): Alpine has no bash.
ENV SHELL=/bin/sh

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
