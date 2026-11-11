// The colour themes: theme.css holds dark (its :root) and light, themes.css the rest. Each has a base - "dark" or
// "light" - which is what nativeTheme gets (title bars, dialogs, scrollbars), and its window colour (the --bg of its
// CSS block), painted until a page draws. "system" is not a theme of its own: it follows Windows to dark or light.
// group: where Settings lists it - AgentDeck's own, or one adapted from a VS Code theme. No Electron here, so
// scripts/test-themes.js can check this list against the CSS and the translations.
const LIST = [
  { id: "dark", base: "dark", bg: "#0d1015", group: "app" },
  { id: "light", base: "light", bg: "#f2f4f8", group: "app" },
  { id: "black", base: "dark", bg: "#000000", group: "app" },
  { id: "one-dark-pro", base: "dark", bg: "#21252b", group: "vscode" },
  { id: "dracula", base: "dark", bg: "#21222c", group: "vscode" },
  { id: "github-dark", base: "dark", bg: "#010409", group: "vscode" },
  { id: "tokyo-night", base: "dark", bg: "#16161e", group: "vscode" },
  { id: "catppuccin-mocha", base: "dark", bg: "#181825", group: "vscode" },
  { id: "night-owl", base: "dark", bg: "#010e1a", group: "vscode" },
  { id: "nord", base: "dark", bg: "#2e3440", group: "vscode" },
  { id: "ayu-mirage", base: "dark", bg: "#1f2430", group: "vscode" },
  { id: "gruvbox-dark", base: "dark", bg: "#1d2021", group: "vscode" },
  { id: "solarized-dark", base: "dark", bg: "#00212b", group: "vscode" },
  { id: "one-light", base: "light", bg: "#eaeaeb", group: "vscode" },
  { id: "tokyo-night-light", base: "light", bg: "#cbccd1", group: "vscode" },
  { id: "night-owl-light", base: "light", bg: "#f0f0f0", group: "vscode" },
  { id: "ayu-light", base: "light", bg: "#f3f4f5", group: "vscode" },
  { id: "catppuccin-latte", base: "light", bg: "#e6e9ef", group: "vscode" },
  { id: "solarized-light", base: "light", bg: "#eee8d5", group: "vscode" }
];
const BY_ID = new Map(LIST.map(th => [th.id, th]));

// Every choice the user has, "system" first.
const THEMES = ["system", ...LIST.map(th => th.id)];
const DEFAULT = "dark";

const get = id => BY_ID.get(id) || null;
// "system" (and anything unknown) has no base of its own: the caller asks Windows.
const baseOf = id => get(id)?.base ?? null;

module.exports = { LIST, THEMES, DEFAULT, get, baseOf };
