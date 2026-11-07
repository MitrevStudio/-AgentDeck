<div align="center">

<img src="docs/assets/agentdeck-banner.svg" alt="AgentDeck — AI sessions, projects and voice in one place" width="100%">

<br>

**Your projects. Your agents. Your whole development fleet.**

A Windows desktop workspace for **Claude Code**, **Codex CLI** and **OpenCode** — with persistent terminals, voice tools and direct connections to your other machines.

[![Windows](https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=for-the-badge)](#installation)
[![MIT](https://img.shields.io/badge/License-MIT-A78BFA?style=for-the-badge)](LICENSE)
[![Electron](https://img.shields.io/badge/Built_with-Electron-47848F?style=for-the-badge&logo=electron&logoColor=white)](#architecture)
[![Local first](https://img.shields.io/badge/Local-first-34D399?style=for-the-badge)](#privacy-and-security)

[![CI](https://github.com/MitrevStudio/-AgentDeck/actions/workflows/ci.yml/badge.svg)](https://github.com/MitrevStudio/-AgentDeck/actions/workflows/ci.yml)
[![Release](https://github.com/MitrevStudio/-AgentDeck/actions/workflows/release.yml/badge.svg)](https://github.com/MitrevStudio/-AgentDeck/actions/workflows/release.yml)
[![Latest release](https://img.shields.io/github/v/release/MitrevStudio/-AgentDeck?label=latest%20release)](https://github.com/MitrevStudio/-AgentDeck/releases/latest)

<br>

[**Download for Windows**](https://github.com/MitrevStudio/-AgentDeck/releases/latest) · [**Get started**](#your-first-five-minutes) · [**Explore features**](#feature-tour) · [**Report an issue**](https://github.com/MitrevStudio/-AgentDeck/issues)

</div>

---

## Meet AgentDeck

Working with several coding agents quickly becomes a navigation problem: which terminal belongs to which repository, what a session was doing yesterday, which agent needs your attention, and where the work is actually running.

AgentDeck brings those pieces into one desktop workspace. Choose a project, start an agent, split a terminal beside it, find an earlier conversation, or resume a session on a paired Linux host. A small handle at the top of your screen keeps the launcher within reach while you work in another app.

Voice is part of that workflow too. Dictate a prompt into the active application, clean up what you said, edit selected text with a spoken instruction, listen to a response, or ask the command centre to start work in a project.

> [!NOTE]
> AgentDeck uses the coding CLIs installed on your machines. Install and sign in to the agents you want to use separately. Voice features use your own provider API keys; the command centre uses Claude Code.

## At a glance

| 🗂️ Projects & sessions | 🖥️ Terminals & workspace | 🎙️ Voice & control |
| --- | --- | --- |
| Claude Code, Codex CLI and OpenCode | Built-in terminal tabs | Dictation into other applications |
| Automatic local session discovery | Horizontal and vertical splits | Verbatim, Clean and Prompt modes |
| Pinned projects and custom groups | Drag tabs and panes to rearrange | Spoken edits to selected text |
| Search, previews and session resume | Persistent Windows terminal processes | Read aloud and quick voice questions |
| Git branch and working-tree status | Remote terminals over the mesh | Claude-powered command centre |

| 📊 Visibility | 🌐 Connected machines | ⚙️ Everyday polish |
| --- | --- | --- |
| Token usage and estimated API cost | Desktop-to-desktop connections | English and Bulgarian interface |
| Claude and Codex plan limits | Linux headless host | Dark, light and system themes |
| Context and session cost indicators | Pairing with certificate pinning | Global shortcuts and keyboard help |
| CPU, memory and disk readings | Clone repositories onto another host | Tray operation and Windows startup |
| Optional daily activity report | Host setup and agent readiness checks | Automatic installed-app updates |

## Contents

- [Installation](#installation)
- [Your first five minutes](#your-first-five-minutes)
- [Feature tour](#feature-tour)
- [Connected machines and remote work](#connected-machines-and-remote-work)
- [Linux headless host](#linux-headless-host)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Settings and customization](#settings-and-customization)
- [Updates](#updates)
- [Privacy and security](#privacy-and-security)
- [Data and storage](#data-and-storage)
- [Development](#development)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Current boundaries](#current-boundaries)
- [Contributing](#contributing)
- [License](#license)

## Installation

### Windows installer

1. Open [GitHub Releases](https://github.com/MitrevStudio/-AgentDeck/releases/latest).
2. Download `AgentDeck-Setup-<version>.exe`.
3. Run the installer and choose the installation directory.
4. Launch AgentDeck from the desktop or Start menu shortcut.

The installer targets **Windows x64**, installs for the current user and lets you change the destination. A separate Node.js installation is needed for development from source, rather than for the packaged desktop app itself.

The installer is currently unsigned. If Windows SmartScreen shows a warning, verify that you downloaded it from this repository's Releases page before choosing **More info → Run anyway**.

### What you need

| Component | Needed for |
| --- | --- |
| Windows 10/11, x64 | The desktop application and Windows integrations |
| Installed, authenticated coding CLI | Starting and resuming that agent's sessions |
| Windows Terminal (`wt.exe`) | External Windows Terminal mode |
| Git on the relevant machine | Repository status, branches and clone workflows |
| Microphone and a provider API key | Dictation and other voice input features |
| Gemini API key | Gemini read-aloud generation |
| Claude Code | The command centre and generated daily summaries |

Built-in **AgentDeck tabs** are the default terminal destination. Windows Terminal is an alternative you can select in settings or the tray menu.

<details>
<summary><strong>Run from source instead</strong></summary>

Use Windows, Git, npm and **Node.js 24**, matching the repository's CI setup.

```powershell
git clone https://github.com/MitrevStudio/-AgentDeck.git
cd ./-AgentDeck
npm ci
npm start
```

There is no separate frontend build step for development: Electron loads the application from `src/`.

For an isolated development profile:

```powershell
$env:AGENTDECK_USER_DATA = Join-Path $PWD ".dev-profile"
npm start
```

The profile has its own settings, registry and single-instance lock. Source runs do not use installed-app automatic updates or the packaged Windows startup integration.

</details>

## Your first five minutes

1. **Choose your language and theme.** Open Settings and select English if needed; the initial defaults are Bulgarian and dark mode.
2. **Check your agents.** Ensure the CLI you want is on `PATH` and already signed in. You can use one agent or all three.
3. **Add a project folder.** Use the **+** beside Projects. Existing session folders can also populate the catalog through discovery.
4. **Start a session.** Select the project and choose Claude, Codex or OpenCode. It opens in a terminal tab by default.
5. **Try a second pane.** Open a shell or another agent beside the current terminal, then resize the divider.
6. **Find earlier work.** Press <kbd>Ctrl</kbd> + <kbd>K</kbd>, type a project name or phrase from a conversation, and inspect the preview.
7. **Add voice when you want it.** Configure your provider key and microphone, then press <kbd>Ctrl</kbd> + <kbd>Space</kbd> to dictate.

> [!TIP]
> Press <kbd>F1</kbd> in the manager to see its shortcuts. The edge menu has its own keyboard-help panel showing the currently registered global shortcuts.

## Feature tour

### Projects and session discovery

The sidebar is a catalog of the repositories and folders you work in. Add directories, rename their display names, pin frequent projects, organize groups and reorder items with drag and drop.

AgentDeck combines sessions from three sources:

| Agent | Discovery | Resume command |
| --- | --- | --- |
| **Claude Code** | Local transcripts under `~/.claude/projects/` | `claude --resume <id>` |
| **Codex CLI** | Local rollouts under `~/.codex/sessions/` | `codex resume <id>` |
| **OpenCode** | CLI session listing; local database for supported previews and usage | `opencode --session <id>` |

The catalog refreshes as local session files change. AgentDeck derives titles and project associations from the metadata it can read, including a session's current working directory when it changes into a worktree.

The Agents list makes running sessions easier to find, with live states where the integration can determine them. A session waiting for you is different from one still working; notifications can bring you back when attention is needed.

Removing a project from the catalog and deleting a session are separate actions. Discovery and previews read history; explicit session deletion can remove the corresponding agent history.

### A terminal workspace for every project

Each project has its own workspace, with tabs containing one or more terminal panes. Keep an implementation agent, a second agent and a regular shell together without losing their project context.

- Split panes **right** or **down** and resize their dividers.
- Move between panes with directional shortcuts.
- Zoom the focused pane and return to the full arrangement.
- Rename and reorder tabs.
- Drag pane headers to move terminals; drag tabs onto panes to combine their layouts.
- Detach a pane into its own tab.
- Change terminal text size and overall interface scale independently.
- Paste clipboard images or drop files into terminals through the application's file handling.

On Windows, terminals run through **DockPty**, the repository's native pseudoconsole bridge. Terminal processes can survive quitting AgentDeck: reopening the app reattaches to still-running terminals and restores their layout and retained output.

Use the tray's **Stop all terminals and quit** action when you intend to end those processes too. Closing an individual terminal pane ends that terminal.

If you prefer external terminals, select **Windows Terminal** as the destination and choose whether launches use a new window or a tab in an existing one. AgentDeck can bring a matching running terminal forward; eligible sessions can also be moved into its own workspace.

<details>
<summary><strong>Long sessions: automatic remember and compact</strong></summary>

For large Claude Code sessions in AgentDeck tabs, automatic compaction can issue `/remember:remember`, followed by `/compact`, after a completed turn and a quiet period.

Available context thresholds are **100k, 150k, 200k and 300k tokens**; the default is **150k**, with the feature enabled. Change it or turn it off through the terminal preferences/tray menu.

The workflow watches for intervening user input and avoids repeatedly compacting until the context falls below the threshold. The remember step depends on that command being available in your Claude Code setup.

</details>

### Search and conversation previews

The <kbd>Ctrl</kbd> + <kbd>K</kbd> palette searches project and session metadata: names, titles, folders and session IDs. Local Claude and Codex transcripts also have a full-text index, so you can find a conversation by what was said.

Select a result to see its preview alongside the list. Depending on the agent and available history, it includes:

- The first prompt and recent prompts and replies.
- The model, start time and most recent activity.
- Counts of prompts, replies and subagents.
- Context or cost indicators where available.

Previews focus on the conversation and omit tool output and internal bookkeeping. Large transcript files are read incrementally or from the end; background workers handle indexing.

Press <kbd>Enter</kbd> to bring a running session forward or resume a stopped one. Use <kbd>Alt</kbd> + <kbd>Enter</kbd> to resume beside the focused pane. Supported Claude sessions also offer **Continue fresh**, starting a new conversation with a handoff from the previous one.

Remote session metadata joins the shared list and palette. Full-text transcript indexing and detailed previews currently operate on the local host.

### The top-edge launcher

A small translucent handle sits at the top of the screen. Hover briefly to reveal the menu, or click to keep it open with search focused. Move the handle along the edge; its position is remembered.

The launcher gives you quick access to projects, recent sessions, running agents, git information and voice controls without first opening the full manager. It also opens from the tray or its global shortcut, usually <kbd>Alt</kbd> + <kbd>`</kbd>.

Hover-opened menus retract when you leave. The handle hides while a fullscreen application is active, and you can disable it while retaining shortcut and tray access.

### Voice tools

Voice tools work across applications through global shortcuts, a recording overlay, provider transcription and delivery back to the target window. Configure **OpenAI** or **Gemini** with your own API key, choose a microphone and set your language and recording preferences.

#### Dictate into the active application

Press <kbd>Ctrl</kbd> + <kbd>Space</kbd> to record. The overlay shows a waveform and timer. Finish with the shortcut again, or use push-to-talk: hold while speaking and release to finish.

The default **Tap or hold** behavior supports both patterns. Choose tap-only or hold-only if preferred. Press <kbd>Esc</kbd> during recording to cancel.

AgentDeck tries to deliver the result to the application that was in front when recording began. If it cannot bring that window back, it leaves the result in the clipboard for manual pasting. Recordings started from the tray deliver to the clipboard.

| Mode | Result | Useful for |
| --- | --- | --- |
| **Verbatim** | The recognized text | Keeping your original phrasing |
| **Clean** | Removes fillers, repetitions and false starts while preserving meaning | Messages, notes and prose |
| **Prompt** | Turns free speech into a clearer coding-agent prompt | Describing a task aloud |

Clean and Prompt make an additional text-model request using your configured provider. Prompt output can follow the spoken language or use English. If rewriting fails, dictation falls back to the recognized text; History retains original and rewritten versions where applicable.

#### Teach it your vocabulary

The dictionary supports **terms** to guide recognition and rewriting, plus **replacements** for recurring mistakes. Project names can contribute vocabulary too.

Use it for repository names, products, libraries, abbreviations and technical words you mix into another language. Replacements match whole words without depending on letter case.

#### Edit selected text by voice

Select text in an application and use <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd>, then speak an instruction:

> “Translate this into English.”
>
> “Make this shorter and keep the technical details.”

AgentDeck sends the selected text and your instruction to the configured text provider and replaces the selection with the result. If processing fails, the delivery workflow restores the original selection text.

#### Ask a quick question

Use <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>/</kbd> to ask a short question by voice. The answer appears in a small popup and is copied to the clipboard, making short commands or snippets convenient to paste.

This uses the configured provider's text model. It is a quick-answer workflow without a browsing tool.

#### Read selected text aloud

Select text and press <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd>. Gemini generates the speech; the playback panel offers pause, stop and speed controls. Speed adjustment preserves voice pitch, and the selection-copy workflow restores the previous clipboard contents.

Press the shortcut again to stop playback. Configure the read-aloud model and voice separately from dictation.

#### History and recovery

Failed recordings remain available for retry. The overlay shows the error, the tray marks pending failures, and you can retry one recording or retry/discard the failed queue from the tray.

History keeps recordings and results, including original recognition when rewriting changed the text. Audio and text have separate retention limits; see [Data and storage](#data-and-storage).

### The command centre

The command centre is an AgentDeck-managed **Claude Code session** with its own terminal and conversation history. It receives typed requests or transcribed voice commands and uses AgentDeck's tools through a local **Model Context Protocol (MCP)** server.

For example:

> “Start Codex in the website project and ask it to add tests for the login form.”
>
> “Ask the backend project what changed in the authentication flow and tell me the result.”
>
> “Show me the session about the logs.”

It can list local projects and sessions, start an agent on a prompt, send a message to a session in an AgentDeck tab, wait for an answer, read recent conversation messages and show a project or running session.

To speak a command, hold the edge-menu shortcut and release when finished, or use the menu's microphone button. The transcript goes to the command centre; Commands settings let you disable this or restrict the trigger to the microphone button.

The centre resumes its own conversation on later starts. Its tools coordinate sessions rather than providing a general shell or file API. Current orchestration targets local projects; paired-machine terminal control is available through the regular interface.

> [!IMPORTANT]
> Voice commands are actionable requests sent to the command centre. Review work in the visible agent terminals and use each CLI's permission controls.

### Usage, limits and machine resources

The Usage view separates **how many tokens sessions consumed** from **how much a subscription allows**.

**Token and cost reporting** includes today, the last 7 days, the last 30 days and all time. Explore a daily cost/token chart and the projects, sessions and models behind the totals. Smaller chips show costs in session lists and project context.

Costs are **API-equivalent estimates** using the application's price table in [`src/host/usage-prices.js`](src/host/usage-prices.js). They are a comparison metric, not an invoice: subscription plans do not charge you those per-token amounts. Unknown model prices produce token counts without a cost estimate.

**Plan limits** are shown separately for installed Claude Code and Codex CLIs, with provider-reported usage windows, reset times and forecasts where available. Codex uses its local app-server account RPC; API-key sign-in may not provide ChatGPT subscription limits.

**Machine resources** show whole-computer CPU, memory and home-volume disk readings. Paired hosts publish resource, usage and limit information over their direct connection as well.

### Git awareness and daily activity

Git indicators show a project's branch, staged/modified/untracked counts, conflicts and commits ahead of or behind its upstream. They appear in relevant project and session views, including the edge launcher.

Status inspection is read-only and avoids optional Git locks. AgentDeck does not fetch to refresh these badges, so ahead/behind numbers reflect the most recent fetch performed elsewhere.

The optional **Day** view in the edge menu groups Claude Code activity by ticket key, or by project when no ticket is found. It estimates active time from message timestamps and merges overlapping activity so parallel sessions do not count the same wall-clock minutes twice.

Browse earlier days and request a short work-log summary through `claude -p`. These durations are heuristics derived from conversations rather than a running time tracker; generating a summary sends the selected activity digest through Claude Code.

## Connected machines and remote work

AgentDeck's **mesh** connects desktops and headless hosts directly over your LAN or VPN. There is no central AgentDeck cloud service or broker to deploy.

```mermaid
flowchart LR
    A["Windows desktop<br/>AgentDeck workspace"] <-->|"WSS · paired certificates"| B["Windows desktop<br/>Projects and sessions"]
    A <-->|"WSS · paired certificates"| C["Linux headless host<br/>Agents and terminals"]
```

### Pair two computers

1. Open **Settings → Computers** on the machines you want to connect.
2. Give each a recognizable name and check its listening port. The default is **7421**.
3. Enable local-network visibility if you want mDNS discovery.
4. Find the other machine, enter the pairing code shown there and connect.
5. If discovery is unavailable, add it by hostname or IP address, including `:port` for a non-default port.

Windows Firewall may prompt when the app first listens. Allow the connection on the private network you intend to use. Discovery uses mDNS; manually adding an address is useful over VPNs or network segments that do not pass multicast.

### Work on another machine

Paired projects appear in the shared project list with their machine identity. Remote sessions join the Agents list and metadata search.

Select a remote project to open a shell, start one of the host's agents or resume a recent session. The process runs **there** while its terminal pane appears **here**, with streamed output, keyboard input and resizing.

Remote panes remain in your saved layout. If a host goes offline, the pane reports that state; reconnecting reattaches to the host's available terminal. Closing the terminal ends it on the host.

### Clone a project onto a host

Choose **Clone to…** from a local project's menu or context menu, then select:

- The paired destination computer.
- A target folder, defaulting to a location such as `~/work/<name>`.
- An existing branch, or a new branch based on a selected base.
- Optionally, an agent and a starting task.

Cloning, branch selection and optional agent launch run in a remote terminal visible in your workspace. Once the clone creates the repository, its folder joins that host's project catalog.

For SSH remotes, configure the destination host's key and trusted Git host first. The dialog also offers HTTPS conversion for supported SSH-style repository addresses.

### Prepare a remote host

The paired computer's **Setup** panel checks Git, SSH keys, trusted hosts, Git identity and agent availability. It can generate a key on the host, display its public key, add a Git host to `known_hosts` and set Git name/email.

Install and authenticate agents on the host itself, using a remote terminal for interactive login. Its private SSH key stays on that machine.

> [!IMPORTANT]
> Pairing grants meaningful control: a paired computer can launch terminals and sessions on the host. Use trusted machines on a LAN or VPN, and keep the mesh port off the public internet.

## Linux headless host

Use a Linux machine as an agent host while keeping the Windows desktop as your interface. The host package runs the same session and terminal core without Electron or a graphical desktop.

### Install

Prerequisites: **Git, npm, Node.js 20+ and a systemd user-service environment**. Use **Node.js 24** for a setup consistent with desktop CI and SQLite-dependent features. On Node 20, transcript full-text search is unavailable.

```bash
curl -fsSL https://raw.githubusercontent.com/MitrevStudio/-AgentDeck/main/host/install.sh | bash
```

The installer checks out the host-related directories into `~/.agentdeck/app`, installs host dependencies, creates and starts the `agentdeck-host` systemd user service, and prints the pairing code and address. It attempts to enable lingering so the service can continue after logout; that step may request sudo.

If `node-pty` cannot load, the installer reports missing build prerequisites. On Debian/Ubuntu, these can include `build-essential` and `python3`.

### Manage the service

```bash
# Check the host
node ~/.agentdeck/app/host/bin/agentdeck-host.js status

# Show its pairing code
node ~/.agentdeck/app/host/bin/agentdeck-host.js pair

# View logs
node ~/.agentdeck/app/host/bin/agentdeck-host.js logs

# Pull updates, install dependencies and restart
node ~/.agentdeck/app/host/bin/agentdeck-host.js update

# Remove the service
node ~/.agentdeck/app/host/bin/agentdeck-host.js uninstall
```

Data and logs live under `~/.agentdeck/host/`. Agents and their authentication belong to the user running the service. Ensure executables are visible in the service's `PATH`, not just an interactive shell's configuration.

<details>
<summary><strong>Advanced host options</strong></summary>

Run a host manually:

```bash
node host/bin/agentdeck-host.js run --name dev-host --port 7421
```

Supported run options include `--data-dir`, `--port`, `--name`, `--pair-token`, `--no-discovery` and `--interface`.

Installer variables include `AGENTDECK_BRANCH`, `AGENTDECK_REPO`, `AGENTDECK_APP` and `AGENTDECK_DATA`. The installer manages its checkout and can reset it to the selected remote branch when rerun; keep personal code changes in a separate checkout.

The same host entry point can run on Windows, but the Linux installer and systemd setup do not apply there. Windows headless operation has no dedicated installer/service integration.

The mesh design notes and implementation history are in [`docs/MESH.md`](docs/MESH.md). That document also contains planning material; use the current code and this README for user-facing behavior.

</details>

## Keyboard shortcuts

### Global voice and launcher controls

| Shortcut | Action |
| --- | --- |
| <kbd>Alt</kbd> + <kbd>`</kbd> | Open the edge launcher; hold to speak a command when enabled |
| <kbd>Ctrl</kbd> + <kbd>Space</kbd> | Dictate: tap to toggle, or hold/release in the default mode |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Space</kbd> | Read selected text aloud; press again to stop |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Space</kbd> | Edit selected text with a spoken instruction |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>/</kbd> | Ask a quick question by voice |
| <kbd>Esc</kbd> | Cancel an active recording |

The launcher tries the first available shortcut from `Alt+Backtick`, `Ctrl+Alt+Space` and `Ctrl+Alt+Shift+Space`. Check the tray/menu for the actual registered combination; a fallback can conflict with another global voice shortcut. Keyboard help reports the current bindings.

### Manager and workspace

| Shortcut | Action |
| --- | --- |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | Search projects and sessions |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>T</kbd> | New shell terminal |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>1</kbd> | New Claude session |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>2</kbd> | New Codex session |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>3</kbd> | New OpenCode session |
| Add <kbd>Alt</kbd> to an agent shortcut | Open the new agent beside the focused pane |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>R</kbd> | Resume the latest session |
| <kbd>Alt</kbd> + <kbd>Shift</kbd> + <kbd>=</kbd> / <kbd>-</kbd> | Split right / down |
| <kbd>Alt</kbd> + arrow keys | Focus a neighboring pane |
| <kbd>Ctrl</kbd> + <kbd>Tab</kbd> / <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Tab</kbd> | Next / previous tab |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>Z</kbd> | Toggle pane zoom |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>W</kbd> | Close the focused pane |
| <kbd>Ctrl</kbd> + <kbd>=</kbd> / <kbd>-</kbd> / <kbd>0</kbd> | Increase / decrease / reset terminal font size |
| <kbd>Ctrl</kbd> + <kbd>,</kbd> | Settings |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>H</kbd> | Voice history |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>U</kbd> | Usage view |
| <kbd>F5</kbd> | Rescan |
| <kbd>F1</kbd> | Keyboard help |

Agent-launch shortcuts require the corresponding CLI. In the search palette, arrows select results, Enter opens, Alt+Enter opens beside the current pane, and Esc closes.

## Settings and customization

| Area | What you can change |
| --- | --- |
| **General** | English/Bulgarian, dark/light/system theme, interface scale, startup and updates |
| **Terminals** | Built-in tabs or Windows Terminal, external window behavior, font size and automatic compaction |
| **Dictation** | Provider, model, language, microphone, recording length, delivery, text mode and push-to-talk |
| **Dictionary** | Recognition terms, replacement rules and project vocabulary |
| **Read aloud** | Gemini model, voice and playback speed |
| **Commands** | Enable/disable spoken commands and choose their trigger |
| **Network** | System/PAC/manual/direct proxy modes, credentials and connection testing |
| **Computers** | Node identity, discovery, pairing, peers and host setup |

The tray also provides quick language/theme switches, terminal destination controls, voice actions and app lifecycle controls. Closing the manager leaves AgentDeck available in the tray.

**Start with Windows** applies to installed copies and starts quietly in the tray. It is enabled once for a new installed setup; disabling it persists.

<details>
<summary><strong>Proxy and corporate-network support</strong></summary>

Provider requests and update checks use Electron's Chromium network stack, following Windows trust and proxy configuration.

- **System:** Windows proxy configuration, including PAC/WPAD.
- **PAC:** An explicit proxy configuration URL.
- **Manual:** A proxy URL and bypass rules; HTTP, HTTPS and SOCKS5 forms are supported.
- **Direct:** Connect without a proxy.

Optional credentials support authenticated proxies; saved passwords use encrypted storage. The connection test reports the selected route and timing or failure reason.

An optional setting passes proxy information to newly launched agent terminals through `HTTP_PROXY`, `HTTPS_PROXY`, `NO_PROXY` and `NODE_USE_ENV_PROXY=1`. This is off by default; individual CLIs remain responsible for how they interpret those variables.

</details>

## Updates

Installed copies check GitHub Releases shortly after startup and then every four hours. With automatic updating enabled, AgentDeck downloads an available release in the background and installs it when you quit.

Once a download is ready, use **Restart and update** from Settings or the tray to apply it immediately. Settings also exposes the current version, update status and a manual check.

Turning automatic updates off keeps checks and notifications available while making download an explicit action. Network failures or temporarily incomplete release availability are retried later.

Automatic updates apply to installed builds. Source runs and unpacked development builds do not use the installed-app updater.

## Privacy and security

AgentDeck keeps its project catalog, layout, indexes and voice history on the machine. Local discovery, git status and previews do not require an AgentDeck account or hosted AgentDeck backend.

Some features intentionally communicate beyond the local app:

| Feature | Data flow |
| --- | --- |
| Coding sessions | The selected CLI communicates using its own configuration and account |
| Dictation | Audio and relevant recognition context go to the selected provider |
| Clean / Prompt | Recognized text and rewrite context go to the text provider |
| Voice editing | Selected text and spoken instruction go to the provider |
| Voice questions | The question and relevant vocabulary go to the provider |
| Read aloud | Selected text goes to Gemini for speech generation |
| Command centre | Requests and tool results enter its Claude Code conversation |
| Generated day summaries | An activity digest is passed to Claude Code |
| Updates | The app contacts the release service |
| Mesh | Paired machines exchange metadata, status and requested terminal/file data |

API keys and proxy passwords use Electron `safeStorage` encryption on Windows. Key saving fails when encryption is unavailable rather than falling back to plaintext. This does **not** encrypt all local history: voice text, audio, session indexes and logs should be treated as local user data.

Mesh trust is established through pairing and pinned certificate fingerprints over TLS. mDNS finds a machine; it does not grant trust. Forgetting a peer tears down the pairing connection. Treat a paired host as a trusted machine with execution access.

The command centre's MCP service binds to `127.0.0.1` and requires a bearer token. Agent launchers validate agent/session arguments; session titles are display data rather than shell commands. These controls complement the agents' own permission settings.

## Data and storage

Fresh desktop profiles normally live at:

```text
%APPDATA%\AgentDeck
```

The active profile contains the encryption context associated with its `Local State` file. Preserve that context when backing up your data.

| Location inside the profile | Purpose |
| --- | --- |
| `settings.json` | UI, terminal, network and voice preferences; encrypted secrets |
| `registry.json` | Project catalog, groups and organization |
| `workspace.json` | Saved spaces, tabs and pane arrangements |
| `terminals/` | Metadata for reconnecting to Windows terminal processes |
| `search.db` | Local transcript full-text index |
| `usage-cache.json` | Cached usage calculations |
| `voice/records/` | Audio files and per-record JSON metadata |
| `node/` | Mesh identity and pairing state |
| `orchestrator/` | Command-centre instructions, MCP configuration and state |

Voice retention keeps audio for **14 days**, with a **1 GiB** audio cap, and record metadata/text for **90 days**, up to **500 records**. Failed jobs are not removed by the normal age timer; a separate cap retains up to **50** failures.

For backups, preserve the entire profile and its encryption context. Copying `settings.json` alone does not guarantee that another Windows account or machine can decrypt its secrets. Coding agents' original histories remain in their own directories.

## Development

### Local workflow

```powershell
npm ci
npm start
```

The desktop uses Electron, plain JavaScript, HTML and CSS. Windows integration uses Koffi and the C# DockPty bridge. Linux host terminals use `node-pty` from the separate `host/` package.

### Checks

```powershell
# Syntax-check JavaScript under src/
npm run check

# Focused regression checks used by CI
node scripts/test-remote-state.js
node scripts/test-resources.js
node scripts/test-codex-live.js
node scripts/test-project-sessions.js
npm run test:limits
```

Additional focused checks live in `scripts/`, including workspace and mesh tests. Inspect a script's prerequisites before running integration checks; some need runtime capabilities beyond syntax checking.

### Package for Windows

```powershell
# NSIS installer
npm run dist

# Unpacked application
npm run dist:dir
```

Outputs are written under `dist/`. The installer is `AgentDeck-Setup-<version>.exe`; the unpacked executable is `dist/win-unpacked/AgentDeck.exe`. Build configuration lives in `package.json`.

The repository version is intentionally `0.0.0-development`. Release automation injects the version associated with the Git tag into the build.

### Environment variables

| Variable | Purpose |
| --- | --- |
| `AGENTDECK_USER_DATA` | Separate desktop profile and instance lock |
| `AGENTDECK_UPDATE_URL` | Generic installed-app update feed with `latest.yml` and installer artifacts |
| `AGENTDECK_BRANCH` | Headless installer's checkout branch |
| `AGENTDECK_REPO` | Headless installer's repository |
| `AGENTDECK_APP` | Headless installer's checkout directory |
| `AGENTDECK_DATA` | Headless installer's data directory |

### Release workflow

Pushes to `main` run validation and semantic-release. Conventional Commits determine the next version:

| Commit | Release effect |
| --- | --- |
| `fix: ...` | Patch |
| `feat: ...` | Minor |
| `feat!: ...` or a `BREAKING CHANGE:` footer | Major |
| `docs: ...`, `chore: ...`, `refactor: ...` | No release by default |

Automation creates a tag and draft release, builds the Windows installer, uploads the `.exe`, `.blockmap` and `latest.yml`, and then publishes the release. A failed build leaves a draft rather than a published release without its installer.

Pull requests and non-main branches run checks and an unpacked Windows packaging build. See the [CI workflow](.github/workflows/ci.yml) and [release workflow](.github/workflows/release.yml).

## Architecture

```mermaid
flowchart TB
    UI["Manager · edge launcher · voice windows"] --> IPC["Electron main + preload / IPC"]
    IPC --> W["Workspace layout"]
    IPC --> H["Local host core"]
    IPC --> V["Voice pipeline"]
    IPC --> O["Command centre + local MCP"]
    O --> H
    H --> S["Discovery · search · git · usage"]
    H --> T["Windows DockPty terminals"]
    IPC --> M["Mesh links · pairing · WSS"]
    M <--> R["Remote host core"]
    R --> P["Linux node-pty / Windows DockPty"]
    V --> API["OpenAI / Gemini"]
```

| Path | Responsibility |
| --- | --- |
| `src/main.js` | Desktop lifecycle, windows, tray, IPC and local/remote coordination |
| `src/renderer.js`, `src/index.html` | Main project and session interface |
| `src/workspace.js`, `src/workspace-ui.js` | Layout state and terminal pane rendering |
| `src/host/` | Reusable core: discovery, launches, terminals, search, git, usage and setup |
| `src/mesh/` | Identity, pairing, peer links, discovery, protocol and served host methods |
| `src/voice/` | Recording, transcription, rewrite, delivery, playback and durable history |
| `src/orchestrator.js` | Claude-based coordination and local MCP tools |
| `src/day.js`, `src/day-ui.js` | Activity estimation and work-log summaries |
| `src/prefs.js`, `src/i18n.js`, `src/theme.css` | Preferences, translations and visual tokens |
| `native/DockPty.cs` | Windows persistent pseudoconsole bridge |
| `host/` | Headless package, CLI and Linux installer |
| `scripts/` | Syntax checks, regression tests and maintenance utilities |

The desktop owns the visual layout. Hosts own their sessions, processes and machine state. A remote terminal participates in the same interface while execution stays on its original machine.

## Troubleshooting

<details>
<summary><strong>An agent is missing or will not start</strong></summary>

Check that its executable (`claude`, `codex` or `opencode`) is on the target machine's `PATH` and works in a regular terminal. Complete its login there, then restart AgentDeck after installation or environment changes.

For a remote host, use its Setup panel and check the service environment as well as your interactive shell. An agent in a shell-specific path may be invisible to systemd.

</details>

<details>
<summary><strong>A session is missing, or Resume is unavailable</strong></summary>

Add the relevant project folder and rescan with F5. AgentDeck needs a valid session ID, supported history format and working-directory association it can resolve. Moved folders, unavailable drives and changed CLI formats can prevent a match.

Discovery relies on local product formats that can change independently. Include the agent version and a redacted description of the missing session when reporting a problem.

</details>

<details>
<summary><strong>A global shortcut does nothing</strong></summary>

Open the tray menu or shortcut-help panel to see the bindings AgentDeck actually registered. Other applications may own a shortcut. Stop the conflicting app or adjust the supported voice hotkey settings.

Dictation and read-aloud shortcuts are configurable in voice settings. Edit-selection and question bindings are stored in `settings.json` under `voice.hotkeys.editSelection` and `voice.hotkeys.ask`.

</details>

<details>
<summary><strong>Dictation failed, or the text did not paste</strong></summary>

Check microphone selection, provider key, model and network/proxy settings. Use Retry for a failed recording rather than recording again.

If AgentDeck cannot restore the target window, the result stays in the clipboard: focus your application and paste manually. Starting a recording from the tray also uses clipboard delivery.

</details>

<details>
<summary><strong>A paired machine is not discovered or appears offline</strong></summary>

Check the host process, listening port, firewall and LAN/VPN reachability. Add the host by address if mDNS is blocked. Use the code displayed by the destination machine and compatible mesh protocol versions on both sides.

A saved pane cannot receive live output while its host is unreachable. Reconnect before attempting remote launches.

</details>

<details>
<summary><strong>Cost estimates differ from my bill</strong></summary>

Usage calculates API-equivalent cost from token records and the bundled price table. It does not read your invoice or convert a subscription into per-session charges. Missing prices, provider-specific billing and subscription allowances affect the comparison.

</details>

<details>
<summary><strong>The app closed, but my agent is still running</strong></summary>

On Windows, built-in terminals are designed to outlive the desktop. Reopen AgentDeck to reattach, or choose **Stop all terminals and quit** when you intend to stop the processes too. A computer reboot still ends those Windows processes.

</details>

## Current boundaries

- The desktop targets Windows x64. Linux has a headless host without a desktop UI.
- Discovery depends on supported CLI storage formats and available metadata.
- Full-text indexing supports local Claude and Codex transcripts. Remote metadata search does not imply remote transcript full-text search.
- The command centre currently coordinates local projects and depends on Claude Code.
- Daily activity estimates derive from Claude transcripts and are not precise time tracking.
- Persistence differs by backend. Windows DockPty processes can survive a desktop restart; Linux `node-pty` sessions belong to the host process and end when it stops.
- Resuming conversation history cannot recover a process that no longer exists or preserve a live process across a machine reboot.
- Usage estimates depend on bundled prices, and plan limits depend on the agent's authenticated account.
- Mesh pairing grants execution access; there is no view-only peer role in the current interface.
- Engineering notes under `docs/` include plans and historical implementation checkpoints.

## Contributing

Bug reports, documentation improvements and focused pull requests are welcome through [GitHub Issues](https://github.com/MitrevStudio/-AgentDeck/issues) and [pull requests](https://github.com/MitrevStudio/-AgentDeck/pulls).

For a useful bug report, include the AgentDeck version, Windows or host platform, affected agent/version, reproduction steps and expected behavior. For mesh issues, describe both machines and whether the connection is LAN or VPN. Redact API keys, tokens, private prompts and personal paths from attachments.

When changing the application:

1. Keep user-visible strings in `src/i18n.js` with English and Bulgarian translations.
2. Use the shared theme tokens in `src/theme.css` for interface colors.
3. Keep reusable host behavior independent of Electron and the DOM.
4. Run relevant checks and explain what you validated in the pull request.
5. Use Conventional Commits so release automation can classify the change.

## License

AgentDeck is available under the [MIT License](LICENSE).

Copyright © 2026 Mitrev Studio.

---

<div align="center">

**A place for every project. A view of every agent.**

[Download AgentDeck](https://github.com/MitrevStudio/-AgentDeck/releases/latest) · [Browse the source](src/) · [Back to top](#meet-agentdeck)

</div>
