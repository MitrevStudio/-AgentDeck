// The taskbar monitor's page: draws what main sends (taskbar-monitor.js) - the computer's traffic, CPU and memory -
// and reports how wide that came out, so the window is no wider than its text.
const api = window.taskbarMonitor;
const { t } = I18N;
const strip = document.getElementById("strip");
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const HOT = 90; // percent from which CPU or memory is shown as running out

// 1536 -> "1.50 KB", as the usual traffic monitors write it.
function bytes(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i ? 2 : 0)} ${units[i]}`;
}
const rate = n => (typeof n !== "number" ? "—" : n < 1024 ? `${(n / 1024).toFixed(2)} KB/s` : `${bytes(n)}/s`);
const percent = n => (typeof n === "number" ? `${Math.round(n)} %` : "—");
const hot = n => (typeof n === "number" && n >= HOT ? " hot" : "");

// Everything, whatever the strip itself shows.
function tooltip(d, today) {
  const lines = [t("resources.local")];
  if (today) lines.push(t("taskbar.today", { total: bytes(today.rx + today.tx), up: bytes(today.tx), down: bytes(today.rx) }));
  if (d.net) lines.push(t("taskbar.traffic", { up: rate(d.net.tx), down: rate(d.net.rx) }));
  if (d.cpu !== null) lines.push(t("taskbar.cpu", { value: percent(d.cpu) }));
  if (d.memory) lines.push(t("taskbar.memory", { used: bytes(d.memory.used), total: bytes(d.memory.total) }));
  return lines.join("\n");
}

// Traffic, then CPU and memory, each two lines of text; whatever is not chosen (show) is left out.
function html(d, today, show) {
  const mem = d.memory ? 100 * d.memory.used / d.memory.total : null;
  const cell = (label, value, n) => `<span class="cell${hot(n)}"><span>${label}</span><span class="value">${value}</span></span>`;
  const cpu = show.cpu ? cell("CPU", percent(d.cpu), d.cpu) : "", memory = show.memory ? cell("MEM", percent(mem), mem) : "";
  const net = show.net ? `<div class="col net"><div class="row">${cell("↑", rate(d.net?.tx))}</div><div class="row">${cell("↓", rate(d.net?.rx))}</div></div>` : "";
  // One measurement alone sits in the middle; two share the two lines.
  const use = cpu || memory ? `<div class="col use${cpu && memory ? "" : " one"}">${cpu ? `<div class="row">${cpu}</div>` : ""}${memory ? `<div class="row">${memory}</div>` : ""}</div>` : "";
  return net || use ? `<div class="device" title="${esc(tooltip(d, today))}">${net}${use}</div>` : "";
}

let reported = null;
function render(data) {
  // The taskbar follows Windows' own mode, not the app's theme: light text unless Windows itself is light.
  document.documentElement.dataset.taskbar = data?.light ? "light" : "dark";
  strip.innerHTML = data?.device ? html(data.device, data.today, data.items || {}) : "";
  const width = Math.ceil(strip.getBoundingClientRect().width);
  if (width !== reported) { reported = width; api.send("width", width); } // 0: nothing chosen, nothing to show
}

api.onData(render);
