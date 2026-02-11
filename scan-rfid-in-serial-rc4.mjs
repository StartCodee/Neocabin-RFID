// rfid-in-serial.mjs
import { SerialPort } from "serialport";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const ZONE = "IN";

const SERIAL_PATH = process.env.SERIAL_PORT || "/dev/cu.PL2303G-USBtoUART120";
const BAUD = Number(process.env.BAUD_RATE || 115200); // 115200 8N1 :contentReference[oaicite:8]{index=8}

const STATE_FILE = path.resolve(process.env.STATE_FILE || "./rfid_state_in.txt");
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";
const BACKEND_AUTH = process.env.BACKEND_AUTH || "";
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 5000);

// Filter anti “nyapu ruangan”

const RSSI_MIN_DBM = Number(process.env.RSSI_MIN_DBM || -127);
const HIT_WINDOW_MS = Number(process.env.HIT_WINDOW_MS || 0);
const MIN_HITS = Number(process.env.MIN_HITS || 1);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 0);


// Kalau kamu tetap mau cek backend dulu (biasanya bikin berat), set 1
const BACKEND_PRECHECK = String(process.env.BACKEND_PRECHECK || "0") === "1";

/** ===== EPC normalizer ===== */
function normalizeEpcHex(epcHex) {
  let hex = String(epcHex || "").toUpperCase();
  if (hex.startsWith("E280")) hex = hex.slice(4);
  if (/^[0-9A-F]{20}$/.test(hex) || /^[0-9A-F]{24}$/.test(hex)) return hex;
  return null;
}

/** ===== CRC-16/MCRF4XX (sesuai doc) ===== :contentReference[oaicite:9]{index=9} */
function crc16Mcrf4xx(buf) {
  let value = 0xffff;
  for (const b of buf) {
    value ^= b;
    for (let i = 0; i < 8; i++) {
      value = (value & 0x0001) ? ((value >> 1) ^ 0x8408) : (value >> 1);
    }
  }
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]); // [msb, lsb]
}

/** ===== State ===== */
const lastState = new Map(); // epc -> { zone, time }
if (fs.existsSync(STATE_FILE)) {
  for (const line of fs.readFileSync(STATE_FILE, "utf-8").split("\n")) {
    if (!line.trim()) continue;
    const [epc, zone, time] = line.split("|");
    if (epc && zone && time) lastState.set(epc, { zone, time: Number(time) });
  }
}
function saveState(epc, zone) {
  const time = Date.now();
  lastState.set(epc, { zone, time });
  const lines = Array.from(lastState.entries()).map(([e, v]) => `${e}|${v.zone}|${v.time}`);
  fs.writeFileSync(STATE_FILE, lines.join("\n"));
}
function zoneToPresence(zone) {
  if (zone === "IN") return "in_room";
  if (zone === "OUT") return "out_of_room";
  return "unknown";
}

/** ===== Backend sender ===== */
async function backendGetPresence(epc) {
  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/documents/rfid/epc/${encodeURIComponent(epc)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "GET",
      headers: BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {},
      signal: controller.signal,
    });
    if (!resp.ok) return null;
    const j = await resp.json();
    return j?.found ? (j.presence_status || null) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function sendToServer(epc, zone, meta = {}) {
  const url = `${BACKEND_URL.replace(/\/$/, "")}/api/documents/rfid/events`;
  const body = {
    epc,
    zone,
    reader_id: `IN-serial:${SERIAL_PATH}`,
    payload: { source: "uhf-reader", zone_origin: zone, ...meta },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    return resp.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

/** ===== RC protocol frame parser =====
 * Response Data Block:
 * Header(0xCF), Addr, Cmd(2), Length(1 = Status+Data), Status, Data[], CRC(2)
 * :contentReference[oaicite:10]{index=10}
 */
let acc = Buffer.alloc(0);

function pullFrames() {
  const frames = [];
  while (acc.length >= 6) {
    const start = acc.indexOf(0xcf);
    if (start < 0) { acc = Buffer.alloc(0); break; }
    if (start > 0) acc = acc.slice(start);
    if (acc.length < 6) break;

    const len = acc[4];
    const total = 1 + 1 + 2 + 1 + len + 2;
    if (acc.length < total) break;

    frames.push(acc.slice(0, total));
    acc = acc.slice(total);
  }
  return frames;
}

function parseInventoryFromFrame(frame) {
  const cmdHi = frame[2], cmdLo = frame[3];
  if (!(cmdHi === 0x00 && cmdLo === 0x01)) return null; // inventory response

  const len = frame[4];
  const status = frame[5];
  if (status !== 0x00) return null;

  // CRC check (optional)
  const payload = frame.slice(0, 1 + 1 + 2 + 1 + len);
  const crcGot = frame.slice(1 + 1 + 2 + 1 + len, 1 + 1 + 2 + 1 + len + 2);
  const crcOk = crcGot.equals(crc16Mcrf4xx(payload));

  const data = frame.slice(6, 6 + (len - 1));

  // Data[] format: RSSI(2), Ant(1), Channel(1), EPC_len(1), EPC(N)
  // :contentReference[oaicite:11]{index=11}
  if (data.length < 2 + 1 + 1 + 1) return null;

  const rssiRaw = data.readInt16BE(0);     // contoh FD E4 => -54.0 dBm
  const rssiDbm = rssiRaw / 10;

  const epcLen = data[2 + 1 + 1];
  const epcStart = 2 + 1 + 1 + 1;
  const epcEnd = epcStart + epcLen;
  if (data.length < epcEnd) return null;

  const epcHexRaw = data.slice(epcStart, epcEnd).toString("hex").toUpperCase();
  const epcHex = normalizeEpcHex(epcHexRaw);
  if (!epcHex) return null;

  return { epc: epcHex, epcRaw: epcHexRaw, rssiDbm, crcOk };
}

/** ===== Anti-noise gate ===== */
const candidates = new Map(); // epc -> { first, count, maxRssi, lastEmit }

async function handleTag(epc, rssiDbm, meta) {
  const now = Date.now();
  const c = candidates.get(epc) || { first: now, count: 0, maxRssi: -999, lastEmit: 0 };

  if (now - c.first > HIT_WINDOW_MS) {
    c.first = now;
    c.count = 0;
    c.maxRssi = -999;
  }

  c.count += 1;
  c.maxRssi = Math.max(c.maxRssi, Number.isFinite(rssiDbm) ? rssiDbm : -999);
  candidates.set(epc, c);

  const strongEnough = c.maxRssi >= RSSI_MIN_DBM;
  const enoughHits = c.count >= MIN_HITS;
  const cooldownOk = (now - c.lastEmit) >= COOLDOWN_MS;

  if (!strongEnough || !enoughHits || !cooldownOk) return;

  // Dedup by state (edge)
  const last = lastState.get(epc);
  if (last && last.zone === ZONE) {
    c.lastEmit = now;
    return;
  }

  // Optional backend precheck (biasanya OFF biar ringan)
  if (BACKEND_PRECHECK) {
    const desiredPresence = zoneToPresence(ZONE);
    const backendPresence = await backendGetPresence(epc);
    if (backendPresence && backendPresence === desiredPresence) {
      saveState(epc, ZONE);
      c.lastEmit = now;
      return;
    }
  }

  const ok = await sendToServer(epc, ZONE, meta);
  if (ok) {
    console.log(`✅ [IN] EPC ${epc} rssi=${rssiDbm?.toFixed?.(1)}dBm`);
    saveState(epc, ZONE);
  } else {
    console.warn(`❌ [IN] gagal kirim EPC ${epc}`);
  }

  c.lastEmit = now;
}

/** ===== Open serial ===== */
const port = new SerialPort({
  path: SERIAL_PATH,
  baudRate: BAUD,
  dataBits: 8,
  stopBits: 1,
  parity: "none",
});

port.on("open", () => console.log("🟢 IN Serial open:", SERIAL_PATH));
port.on("error", (e) => console.error("❌ IN Serial error:", e.message));

port.on("data", (buf) => {
  acc = Buffer.concat([acc, buf]);
  const frames = pullFrames();

  for (const f of frames) {
    const parsed = parseInventoryFromFrame(f);
    if (parsed) {
      handleTag(parsed.epc, parsed.rssiDbm, { crcOk: parsed.crcOk, rssiDbm: parsed.rssiDbm });
    }
  }
});
