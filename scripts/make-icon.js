// Renders build/icon.png (the installer/executable icon) from the same drawing the app uses at runtime.
// Run with Electron: npx electron scripts/make-icon.js
const { app } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
const { makeIcon } = require("../src/app-icon");

app.whenReady().then(() => {
  const out = path.join(__dirname, "..", "build", "icon.png");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, makeIcon(512).toPNG());
  console.log(`wrote ${out}`);
  app.quit();
});
