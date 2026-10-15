// Where a transcript goes. Port of VoiceTray's TextDeliveryService: into the window that was in front when the
// recording started, or onto the clipboard when that window cannot be brought back (better there than typed into
// whatever happens to be in front). The clipboard is deliberately not restored afterwards.
const w = require("./win32");
const { sleep } = require("./util");

const SETTLE_BEFORE_PASTE_MS = 80;
const SETTLE_AFTER_PASTE_MS = 80;

// outcome mirrors VoiceTray's DeliveryOutcome; reason says why it is not Injected ("press Ctrl+V" for ClipboardOnly).
const injected = () => ({ delivered: true, outcome: "Injected", reason: "injected" });
const clipboardOnly = reason => ({ delivered: false, outcome: "ClipboardOnly", reason });
const failed = reason => ({ delivered: false, outcome: "Failed", reason });

async function toClipboard(text, reason) {
  return (await w.writeClipboardText(text)) ? clipboardOnly(reason) : failed("clipboard-blocked");
}

// The retry path: minutes later the original window may be gone and the user elsewhere, so the text is only offered.
function deliverToClipboard(text, reason = "retry") {
  return w.exclusive(() => toClipboard(text, reason));
}

// target: the result of win32.foreground() taken when the recording started.
function deliver(text, target, { useClipboard = true } = {}) {
  if (!target || !target.hwnd) return deliverToClipboard(text, "no-target");
  return w.exclusive(async () => {
    const focused = await w.focus(target);
    // Ctrl is very often still held from Ctrl+Space; it would turn typing into chords and Ctrl+V into something else.
    await w.waitModifiersUp();
    if (!focused) return toClipboard(text, "focus-failed");

    if (useClipboard) {
      if (!(await w.writeClipboardText(text))) return failed("clipboard-blocked");
      await sleep(SETTLE_BEFORE_PASTE_MS);
      if (!w.sendCtrlV()) return clipboardOnly("paste-failed");
      await sleep(SETTLE_AFTER_PASTE_MS);
      return injected();
    }
    if (w.typeUnicode(text)) return injected();
    return toClipboard(text, "typing-failed");
  });
}

module.exports = { deliver, deliverToClipboard };
