// A picture on its way to a computer (the terminal's "Send a picture"): a phone's photo is several megabytes and
// several thousand pixels wide, more than an agent needs and slow over a mobile link, so a large one is drawn
// smaller and saved as JPEG here first. What a host takes is 10 MB (src/host/paste.js); what leaves here is a few
// hundred kilobytes.
const MAX_SIDE = 2000;           // px on the longer side
const QUALITY = 0.85;            // of the JPEG
const KEEP_BYTES = 1024 * 1024;  // a picture this small, no wider than MAX_SIDE and of a kind agents read goes as it is
const AS_IT_IS = /^image\/(png|jpeg|webp|gif)$/;

// The size a picture of w x h is drawn at: its longer side at most `max`, never enlarged.
export function fitSize(w, h, max = MAX_SIDE) {
  const k = Math.min(1, max / Math.max(w, h, 1));
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)), k };
}
// The name a picture is saved under on the computer: its own, with the extension of what it became.
export function pictureName(name, jpeg, now = Date.now()) {
  const base = String(name || "").split(/[\\/]/).pop().replace(/\.[^.]*$/, "") || `picture-${now}`;
  const ext = jpeg ? "jpg" : (String(name || "").match(/\.([a-z0-9]+)$/i)?.[1] || "png").toLowerCase();
  return `${base}.${ext}`;
}

// file: a File from an <input type="file">. -> { blob, name }: the file itself when it is small enough already,
// else a smaller JPEG of it. A file the WebView cannot draw (not a picture, or a format it does not know) is refused.
export async function shrink(file) {
  let bmp;
  try { bmp = await createImageBitmap(file); } catch { throw Object.assign(new Error("not a picture"), { code: "notPicture" }); }
  try {
    const size = fitSize(bmp.width, bmp.height);
    if (size.k === 1 && file.size <= KEEP_BYTES && AS_IT_IS.test(file.type)) return { blob: file, name: pictureName(file.name, false) };
    const canvas = document.createElement("canvas");
    canvas.width = size.w;
    canvas.height = size.h;
    const g = canvas.getContext("2d");
    g.fillStyle = "#fff"; // JPEG has no transparency: what was clear is white, not black
    g.fillRect(0, 0, size.w, size.h);
    g.drawImage(bmp, 0, 0, size.w, size.h);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", QUALITY));
    if (!blob) throw Object.assign(new Error("not a picture"), { code: "notPicture" });
    return { blob, name: pictureName(file.name, true) };
  } finally { bmp.close?.(); }
}

// A blob's bytes as base64 (what files.put takes).
export function toBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).slice(String(r.result).indexOf(",") + 1));
    r.onerror = () => reject(r.error || new Error("read failed"));
    r.readAsDataURL(blob);
  });
}

// "640 KB", "1.2 MB".
export const sizeText = bytes => (bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);
