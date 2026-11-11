// The browser preview: www/ served on http://127.0.0.1:5391 (a loopback address counts as a secure context, so the camera
// works for the scanner too). Open it with the browser's device toolbar at a phone size. PORT=... picks another port.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const www = path.join(path.dirname(path.dirname(fileURLToPath(import.meta.url))), "www");
const port = Number(process.env.PORT) || 5391;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".json": "application/json", ".txt": "text/plain; charset=utf-8" };

http.createServer(async (req, res) => {
  const url = decodeURIComponent(new URL(req.url, "http://x").pathname);
  const file = path.join(www, url === "/" ? "index.html" : url);
  if (!file.startsWith(www)) { res.writeHead(403).end(); return; }
  try {
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
}).listen(port, "127.0.0.1", () => console.log(`AgentDeck mobile preview: http://127.0.0.1:${port}/`));
