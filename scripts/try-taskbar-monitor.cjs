// Runs the taskbar monitor on its own, without AgentDeck: `npx electron scripts/try-taskbar-monitor.cjs [--no-net] [--no-cpu] [--no-memory]`.
// Ctrl+C ends it.
const { app, ipcMain } = require("electron");
const path = require("node:path");
const os = require("node:os");

app.setPath("userData", path.join(os.tmpdir(), "agentdeck-try-taskbar"));
app.whenReady().then(() => {
  ipcMain.on("prefs:get", e => { e.returnValue = { language: "bg", theme: "dark", resolvedTheme: "dark" }; });
  const { createTaskbarMonitor } = require("../src/taskbar-monitor");
  createTaskbarMonitor({
    shown: () => true,
    items: () => ({ net: !process.argv.includes("--no-net"), cpu: !process.argv.includes("--no-cpu"), memory: !process.argv.includes("--no-memory") }),
    trafficFile: path.join(app.getPath("userData"), "taskbar-traffic.json")
  });
  console.log("The taskbar monitor is up.");
});
app.on("window-all-closed", () => app.quit());
