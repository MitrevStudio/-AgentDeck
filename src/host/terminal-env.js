// Windows Terminal hands the caller's environment to the new tab, so whatever this app inherited ends up in the
// agent sessions it opens. When the app itself was started from inside an agent session, strip what that
// session set for its own use:
//  - per-session markers, which make a resumed Claude Code think it is a child session (transcript saving off,
//    the parent's IDE/permission state);
//  - settings meant for non-interactive tool shells (no colours, no git prompts or editor), which leave the
//    interactive terminal colourless and break git authentication.
// The second group is only removed when an agent marker is present, so a user's own global NO_COLOR etc. survive.
const SESSION_MARKERS = /^(CLAUDECODE|CLAUDE_PID|CLAUDE_CODE_(ENTRYPOINT|CHILD_SESSION|SSE_PORT|SESSION_\w+|MESSAGING_\w+))$/i;
const AGENT_MARKERS = /^(CLAUDECODE|AI_AGENT)$/i;
const AGENT_SHELL_VARS = new Set([
  "ai_agent", "no_color", "git_editor", "git_terminal_prompt", "git_askpass", "gcm_interactive",
  "corepack_enable_auto_pin", "pythonioencoding", "nodefaultcurrentdirectoryinexepath"
]);

// With `proxy` ({url, noProxy} from network.js: the user asked for AgentDeck's proxy in the terminals too) the
// terminal also gets HTTPS_PROXY, HTTP_PROXY and NO_PROXY, replacing whatever spelling of them it inherited (Windows
// names are case-insensitive, so two spellings would be two contradicting entries), and NODE_USE_ENV_PROXY so that
// plain Node.js tools (fetch, https) follow them as well.
const PROXY_VARS = /^(https?_proxy|no_proxy|node_use_env_proxy)$/i;

function terminalEnv(env = process.env, proxy = null) {
  const fromAgent = Object.keys(env).some(k => AGENT_MARKERS.test(k));
  const out = Object.fromEntries(Object.entries(env).filter(([k]) =>
    !SESSION_MARKERS.test(k) && !(fromAgent && AGENT_SHELL_VARS.has(k.toLowerCase())) && !(proxy && PROXY_VARS.test(k))));
  if (proxy) Object.assign(out, { HTTPS_PROXY: proxy.url, HTTP_PROXY: proxy.url, NO_PROXY: proxy.noProxy, NODE_USE_ENV_PROXY: "1" });
  return out;
}

// A terminal here may be looked at from another computer, whose clipboard only an OSC 52 reaches (workspace-ui.js).
// Codex, selecting with its own mouse, writes just the clipboard of the computer it runs on ("copied to host
// clipboard") unless it takes itself for a remote session; under Herdr's marker it does both - that clipboard and an
// OSC 52. Only the terminal of a Codex session AgentDeck starts gets the marker (launch.js openTerminal, by the
// terminal's agent): it reaches every program in the terminal, and others act on it - OpenCode drops its session
// tabs, Herdr's own hooks take the terminal for one of Herdr's. So a plain shell stays without it, and a `codex`
// typed into one copies to its own computer only; a session opened in Windows Terminal needs none, as nobody looks
// at that from another computer. A HERDR_ENV the user set, in any letter case (Windows names are
// case-insensitive, so a second spelling would be a second, contradicting entry), stays exactly as it is.
const HERDR_MARKER = /^HERDR_ENV$/i;
function codexEnv(env, agent) {
  if (agent !== "Codex" || Object.keys(env).some(k => HERDR_MARKER.test(k))) return env;
  return { ...env, HERDR_ENV: "1" };
}

module.exports = { terminalEnv, codexEnv };
