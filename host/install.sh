#!/usr/bin/env bash
# Installs AgentDeck's headless host on this Linux machine, for the current user:
#   curl -fsSL https://raw.githubusercontent.com/MitrevStudio/-AgentDeck/main/host/install.sh | bash
# By default this machine is a RELAY ONLY: it routes mesh traffic between your paired computers (the tunnels are
# end-to-end TLS, so it never reads or acts on what it carries) and runs no sessions of its own. To make it a
# resource as well - projects, sessions, terminals and agents your desktops can open here - install with the API on:
#   curl -fsSL .../host/install.sh | AGENTDECK_WITH_API=1 bash
# Or keep the relay as it is and add the resource as a SECOND SERVICE beside it, on the same machine:
#   curl -fsSL .../host/install.sh | AGENTDECK_INSTANCE=api bash
# That service (agentdeck-host-api, data in ~/.agentdeck/host-api) listens on 127.0.0.1 only and pairs itself with the
# relay here; desktops reach it through the relay and pair with it under Settings → Computers → Found.
# Only the host's part of the repository is checked out (host/ and src/host, src/mesh, src/shared), its packages
# are installed, and a systemd user service keeps it running (also after a reboot: linger). Runs again to update.
# Needs: git, node 20+ (22+ for the full-text search), npm. With the API on, also a C toolchain for node-pty. Nothing as root.
set -euo pipefail

REPO="${AGENTDECK_REPO:-https://github.com/MitrevStudio/-AgentDeck.git}"
BRANCH="${AGENTDECK_BRANCH:-main}"
APP="${AGENTDECK_APP:-$HOME/.agentdeck/app}"
WITH_API="${AGENTDECK_WITH_API:-}"   # non-empty: also serve this machine as a resource; empty: relay only
INSTANCE="${AGENTDECK_INSTANCE:-}"   # a second service beside this machine's relay: a resource host (so the API is on)
if [ -n "$INSTANCE" ]; then
  if ! printf '%s' "$INSTANCE" | grep -Eq '^[a-z0-9][a-z0-9-]{0,31}$'; then
    echo "AGENTDECK_INSTANCE must be lowercase letters, digits and dashes, not \"$INSTANCE\"." >&2
    exit 1
  fi
  WITH_API=1
fi
DATA="${AGENTDECK_DATA:-$HOME/.agentdeck/host${INSTANCE:+-$INSTANCE}}"
RELAY_DATA="${AGENTDECK_RELAY_DATA:-$HOME/.agentdeck/host}"   # the relay's data, for a second service to pair with it
PORT="${AGENTDECK_PORT:-${INSTANCE:+7422}}"                    # a second service needs its own port (the relay has 7421)
SERVICE="agentdeck-host${INSTANCE:+-$INSTANCE}"
UNIT="$HOME/.config/systemd/user/$SERVICE.service"
BIN="$APP/host/bin/agentdeck-host.js"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "Missing: $1. Install it first ($2)." >&2; exit 1; }; }

need git "apt install git"
need node "https://nodejs.org or NodeSource; node 20 or newer"
need npm "comes with node"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [ "$NODE_MAJOR" -lt 20 ]; then echo "Node $NODE_MAJOR is too old: 20 or newer is needed." >&2; exit 1; fi
if [ "$NODE_MAJOR" -lt 22 ]; then echo "Note: node $NODE_MAJOR has no node:sqlite, so the full-text search of sessions is off on this host (22+ has it)."; fi

say "The code: $APP ($BRANCH)"
if [ -d "$APP/.git" ]; then
  git -C "$APP" fetch -q origin "$BRANCH"
  git -C "$APP" checkout -q "$BRANCH"
  git -C "$APP" reset -q --hard "origin/$BRANCH"
else
  mkdir -p "$(dirname "$APP")"
  git clone -q --filter=blob:none --no-checkout --branch "$BRANCH" "$REPO" "$APP"
  git -C "$APP" sparse-checkout set host src/host src/mesh src/shared
  git -C "$APP" checkout -q "$BRANCH"
fi

say "The packages"
(cd "$APP/host" && npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -3) || (cd "$APP/host" && npm install --omit=dev --no-audit --no-fund 2>&1 | tail -3)
# node-pty is only needed to open terminals, i.e. with the API on; a relay never does, so don't require it there.
if [ -n "$WITH_API" ] && ! node -e 'process.env.NODE_PATH=process.argv[1]; require("module").Module._initPaths(); require("node-pty")' "$APP/host/node_modules"; then
  echo "node-pty could not be built or loaded. On Debian/Ubuntu: sudo apt install build-essential python3, then run this again." >&2
  exit 1
fi

say "The service: $SERVICE (systemd, user $USER)${WITH_API:+ - with API}"
mkdir -p "$(dirname "$UNIT")" "$DATA"
EXEC="$(command -v node) $BIN run --data-dir $DATA"
if [ -n "$WITH_API" ]; then EXEC="$EXEC --with-api"; fi
if [ -n "$PORT" ]; then EXEC="$EXEC --port $PORT"; fi
# A second service is reached only through the relay beside it: loopback only, nothing to announce on the network.
if [ -n "$INSTANCE" ]; then EXEC="$EXEC --instance $INSTANCE --listen 127.0.0.1 --no-discovery"; fi
cat > "$UNIT" <<EOF
[Unit]
Description=AgentDeck headless host${INSTANCE:+ "$INSTANCE"}${WITH_API:+ (with API)}
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=$EXEC
Restart=on-failure
RestartSec=3
Environment=HOME=$HOME
Environment=PATH=$HOME/.local/bin:$HOME/.npm-global/bin:/usr/local/bin:/usr/bin:/bin
WorkingDirectory=$HOME

[Install]
WantedBy=default.target
EOF
systemctl --user daemon-reload
systemctl --user enable -q "$SERVICE"
# All of this machine's AgentDeck services (a relay and a resource beside it) run this same code: the running ones are
# restarted onto it, and this one is started.
systemctl --user try-restart 'agentdeck-host*'
systemctl --user start "$SERVICE"
# Keeps the user's services running without a login session (after a reboot too).
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || echo "Could not enable linger: the host stops when you log out. Run: sudo loginctl enable-linger $USER"
fi
sleep 2

# A second service pairs with the relay on this machine (its code and port read from the relay's files).
if [ -n "$INSTANCE" ]; then
  say "Pairing with the relay on this machine"
  if [ -f "$RELAY_DATA/node/pair-token.json" ]; then
    node "$BIN" pair-relay --instance "$INSTANCE" --data-dir "$DATA" --relay-data-dir "$RELAY_DATA" \
      || echo "Could not pair with the relay. Try again: $BIN pair-relay --instance $INSTANCE"
  else
    echo "No relay on this machine ($RELAY_DATA). Install it first (the same command without AGENTDECK_INSTANCE), then: $BIN pair-relay --instance $INSTANCE"
  fi
fi

say "Done"
node "$BIN" pair --data-dir "$DATA" || true
echo
if [ -n "$INSTANCE" ]; then
  echo "This machine now also runs a RESOURCE host \"$INSTANCE\" ($SERVICE) beside its relay, on 127.0.0.1 only."
  echo "On a desktop paired with the relay: Settings → Computers → Found → $(hostname)-$INSTANCE → enter the code above."
  echo "Agents here: $(for a in claude codex opencode; do command -v $a >/dev/null 2>&1 && printf '%s ' $a; done)"
  echo "Sign the agents in on this machine (claude, codex) before starting sessions here."
elif [ -n "$WITH_API" ]; then
  echo "This machine is a RESOURCE host: your desktops can open terminals, sessions and agents here."
  echo "Agents here: $(for a in claude codex opencode; do command -v $a >/dev/null 2>&1 && printf '%s ' $a; done)"
  echo "Sign the agents in on this machine (claude, codex) before starting sessions here."
else
  echo "This machine is a RELAY ONLY: it routes traffic between your paired computers and runs nothing itself."
  echo "To also run agents here: AGENTDECK_INSTANCE=api before the same command (a resource beside the relay)."
fi
echo "Commands: $BIN status | logs | pair | pair-relay | update | uninstall${INSTANCE:+   (add --instance $INSTANCE)}"
