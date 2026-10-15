// Reading the agents' transcripts (append-only JSONL files, some of them hundreds of MB) a piece at a time, so a
// first pass over them never holds a whole file in memory. Used by session-preview.js and usage-worker.js.
const CHUNK = 4 * 1024 * 1024;

// len bytes at pos of an open file (fs.promises FileHandle); fewer at its end.
async function readAt(fh, pos, len) {
  const buf = Buffer.allocUnsafe(len);
  let got = 0;
  while (got < len) {
    const { bytesRead } = await fh.read(buf, got, len - got, pos + got);
    if (!bytesRead) break;
    got += bytesRead;
  }
  return buf.subarray(0, got);
}

// The complete lines between start and end, in Buffers of about `chunk` bytes that each end with a newline (a line
// longer than a chunk is put together first). What follows the last newline - a line still being written - is left.
async function* lineChunks(fh, start, end, chunk = CHUNK) {
  let parts = [];
  for (let pos = start; pos < end;) {
    const buf = await readAt(fh, pos, Math.min(chunk, end - pos));
    if (!buf.length) return;
    pos += buf.length;
    const nl = buf.lastIndexOf(10);
    if (nl < 0) { parts.push(buf); continue; }
    const lines = parts.length ? Buffer.concat([...parts, buf.subarray(0, nl + 1)]) : buf.subarray(0, nl + 1);
    parts = nl + 1 < buf.length ? [buf.subarray(nl + 1)] : [];
    yield lines;
  }
}

module.exports = { readAt, lineChunks, CHUNK };
