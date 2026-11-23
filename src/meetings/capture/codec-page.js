// One job of the codec page (codec.js): a window of its own, so that cancelling is closing it and its memory goes
// with it. The page may only touch the files it was given, by their names.
const fs = require("node:fs");
const { toBuffer } = require("../../shared/util");
const { openPage } = require("./hidden-page");

const PARTITION = "meetings-codec";
const READ_MAX = 32 * 1024 * 1024;

const configure = session => {
  session.setPermissionRequestHandler((_wc, _permission, answer) => answer(false));
  session.setPermissionCheckHandler(() => false);
};

// files: { <name>: { path, write } }. fn(call) while it is open; signal closes it. A file system error is what is
// thrown, not the page's account of it.
async function withCodec({ files, signal, onProgress }, fn) {
  signal?.throwIfAborted();
  const handles = new Map();
  let fileError = null, over = false;

  function fileOf(name, writing = false) {
    if (over || !Object.hasOwn(files, name) || (writing && !files[name].write)) throw new Error(`not a file of this job: ${name}`);
    if (!handles.has(name)) handles.set(name, fs.promises.open(files[name].path, files[name].write ? "w+" : "r"));
    return handles.get(name);
  }
  async function guarded(fn) {
    try {
      return await fn();
    } catch (error) {
      if (error.syscall) fileError ??= error;
      throw error;
    }
  }
  const handle = {
    size: ({ name }) => guarded(async () => (await (await fileOf(name)).stat()).size),
    read: ({ name, position, length }) => guarded(async () => {
      if (!(Number.isSafeInteger(position) && position >= 0 && Number.isSafeInteger(length) && length >= 0 && length <= READ_MAX)) throw new RangeError("read");
      const file = await fileOf(name), buffer = Buffer.allocUnsafeSlow(length);
      let done = 0;
      while (done < length) {
        const { bytesRead } = await file.read(buffer, done, length - done, position + done);
        if (!bytesRead) break;
        done += bytesRead;
      }
      return buffer.subarray(0, done);
    }),
    write: ({ name, position, data }) => guarded(async () => {
      if (!Number.isSafeInteger(position) || position < 0) throw new RangeError("write");
      const file = await fileOf(name, true), bytes = toBuffer(data);
      for (let done = 0; done < bytes.length;) done += (await file.write(bytes, done, bytes.length - done, position + done)).bytesWritten;
    })
  };

  const page = openPage({ html: "codec.html", partition: PARTITION, configure, handle, on: { progress: p => onProgress?.(p.frames) } });
  const abort = () => page.close();
  signal?.addEventListener("abort", abort);
  try {
    const result = await fn((cmd, args) => page.call(cmd, args, 0)); // hours of audio take minutes
    signal?.throwIfAborted();
    return result;
  } catch (error) {
    signal?.throwIfAborted();
    throw fileError || error;
  } finally {
    over = true;
    signal?.removeEventListener("abort", abort);
    page.close();
    await Promise.all([...handles.values()].map(opening => opening.then(file => file.close(), () => {})));
  }
}

module.exports = { withCodec };
