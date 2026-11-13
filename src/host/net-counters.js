// Bytes the whole computer has received and sent since boot, summed over its physical network adapters - what
// resources.js turns into a rate. Node has no such counters (os.networkInterfaces() gives addresses only), so they
// come from Windows' interface table, through koffi. Elsewhere, and whenever that fails, read() gives null: no
// traffic is known.
//
// Only real adapters count: a VPN, a virtual switch or a filter driver carries the same bytes as the adapter under it
// and would count them twice.
// MIB_IF_ROW2 (netioapi.h), x64: 1352 bytes; MIB_IF_TABLE2 is a count followed, 8 bytes in, by the rows.
const ROW = 1352, ROWS_AT = 8;
const TYPE_AT = 1128, FLAGS_AT = 1152, OPER_AT = 1156, IN_AT = 1208, OUT_AT = 1280;
const IF_TYPE_LOOPBACK = 24, OPER_UP = 1;
const HARDWARE = 1, FILTER = 2; // InterfaceAndOperStatusFlags bits

let api; // undefined: not loaded yet; null: not available
function native() {
  if (api !== undefined) return api;
  try {
    const koffi = require("koffi");
    const lib = koffi.load("iphlpapi.dll");
    api = {
      koffi,
      getTable: lib.func("uint32_t __stdcall GetIfTable2(_Out_ void **table)"),
      free: lib.func("void __stdcall FreeMibTable(void *table)")
    };
  } catch (e) {
    console.error("Network counters are not available:", e.message);
    api = null;
  }
  return api;
}

function readWindows() {
  const f = native();
  if (!f) return null;
  const out = [null];
  if (f.getTable(out) !== 0 || !out[0]) return null;
  try {
    const count = f.koffi.decode(out[0], "uint32_t");
    // Field by field: Electron's V8 does not allow a view onto memory it did not allocate (koffi.view).
    const u32 = at => f.koffi.decode(out[0], at, "uint32_t"), u64 = at => BigInt(f.koffi.decode(out[0], at, "uint64_t"));
    const sum = { hardware: { rx: 0n, tx: 0n, n: 0 }, other: { rx: 0n, tx: 0n, n: 0 } };
    for (let i = 0; i < count; i++) {
      const at = ROWS_AT + i * ROW;
      const flags = f.koffi.decode(out[0], at + FLAGS_AT, "uint8_t");
      if (u32(at + OPER_AT) !== OPER_UP || u32(at + TYPE_AT) === IF_TYPE_LOOPBACK || flags & FILTER) continue;
      const to = flags & HARDWARE ? sum.hardware : sum.other;
      to.rx += u64(at + IN_AT);
      to.tx += u64(at + OUT_AT);
      to.n++;
    }
    // A virtual machine may have no adapter marked as hardware: then every adapter that is up counts.
    const use = sum.hardware.n ? sum.hardware : sum.other;
    return { rx: Number(use.rx), tx: Number(use.tx) };
  } finally {
    f.free(out[0]);
  }
}

// -> { rx, tx } in bytes since boot, or null.
function read() {
  try {
    if (process.platform === "win32") return readWindows();
  } catch {}
  return null;
}

module.exports = { read };
