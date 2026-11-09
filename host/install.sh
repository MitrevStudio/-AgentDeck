#!/usr/bin/env bash
# Installs AgentDeck's headless host on this Linux machine, for the current user:
#   curl -fsSL https://raw.githubusercontent.com/MitrevStudio/-AgentDeck/main/host/install.sh | bash
# By default this machine is a RELAY ONLY: it routes mesh traffic between your paired computers (the tunnels are
# end-to-end TLS, so it never reads or acts on what it carries) and runs no sessions of its own. To make it a
# resource as well - projects, sessions, terminals and agents your desktops can open here - install with the API on:
#   curl -fsSL .../host/install.sh | AGENTDECK_WITH_API=1 bash
# Only the host's part of the repository is checked out (host/ and src/host, src/mesh, src/shared), its packages
# are installed, and a systemd user service keeps it running (also after a reboot: linger). Runs again to update.
# Needs: git, node 20+ (22+ for the full-text search), npm. With the API on, also a C toolchain for node-pty. Nothing as root.
set -euo pipefail

REPO="${AGENTDECK_REPO:-https://github.com/MitrevStudio/-AgentDeck.git}"
BRANCH="${AGENTDECK_BRANCH:-main}"
APP="${AGENTDECK_APP:-$HOME/.agentdeck/app}"
DATA="${AGENTDECK_DATA:-$HOME/.agentdeck/host}"
WITH_API="${AGENTDECK_WITH_API:-}"   # non-empty: also serve this machine as a resource; empty: relay only
SERVICE=agentdeck-host
UNIT="$HOME/.config/systemd/user/$SERVICE.service"

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
EXEC="$(command -v node) $APP/host/bin/agentdeck-host.js run --data-dir $DATA"
[ -n "$WITH_API" ] && EXEC="$EXEC --with-api"
cat > "$UNIT" <<EOF
[Unit]
Description=AgentDeck headless host${WITH_API:+ (with API)}
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
systemctl --user restart "$SERVICE"
# Keeps the user's services running without a login session (after a reboot too).
if command -v loginctl >/dev/null 2>&1 && [ "$(loginctl show-user "$USER" -p Linger --value 2>/dev/null)" != "yes" ]; then
  loginctl enable-linger "$USER" 2>/dev/null || sudo loginctl enable-linger "$USER" || echo "Could not enable linger: the host stops when you log out. Run: sudo loginctl enable-linger $USER"
fi
sleep 2
say "Done"
node "$APP/host/bin/agentdeck-host.js" pair --data-dir "$DATA" || true
echo
if [ -n "$WITH_API" ]; then
  echo "This machine is a RESOURCE host: your desktops can open terminals, sessions and agents here."
  echo "Agents here: $(for a in claude codex opencode; do command -v $a >/dev/null 2>&1 && printf '%s ' $a; done)"
  echo "Sign the agents in on this machine (claude, codex) before starting sessions here."
else
  echo "This machine is a RELAY ONLY: it routes traffic between your paired computers and runs nothing itself."
  echo "To also use it as a resource (run agents here), reinstall with: AGENTDECK_WITH_API=1 before the command."
fi
echo "Commands: $APP/host/bin/agentdeck-host.js status | logs | pair | update | uninstall"
