// rfid-out-tcp.mjs
import net from "net";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const ZONE = "OUT";

const READER_HOST = process.env.RFID_READER_HOST || "192.168.128.200";
const READER_PORT = Number(process.env.RFID_READER_PORT || 2022);

const STATE_FILE = path.resolve(process.env.STATE_FILE || "./rfid_state.txt");
const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";
const BACKEND_AUTH = process.env.BACKEND_AUTH || "";
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 5000);

const RSSI_MIN_DBM = Number(process.env.RSSI_MIN_DBM || -127);
const HIT_WINDOW_MS = Number(process.env.HIT_WINDOW_MS || 0);
const MIN_HITS = Number(process.env.MIN_HITS || 1);
const COOLDOWN_MS = Number(process.env.COOLDOWN_MS || 0);

const BACKEND_PRECHECK = String(process.env.BACKEND_PRECHECK || "0") === "1";

/** ===== Normalizer ===== */
function normalizeEpcHex(epcHex) {
  let hex = String(epcHex || "").toUpperCase();
  if (hex.startsWith("E280")) hex = hex.slice(4);
  if (/^[0-9A-F]{20}$/.test(hex) || /^[0-9A-F]{24}$/.test(hex)) return hex;
  return null;
}

/** ===== CRC ===== */
function crc16Mcrf4xx(buf) {
  let value = 0xffff;
  for (const b of buf) {
    value ^= b;
    for (let i = 0; i < 8; i++) {
      value = (value & 0x0001) ? ((value >> 1) ^ 0x8408) : (value >> 1);
    }
  }
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

/** ===== State ===== */
const lastState = new Map();
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

/** ===== Backend ===== */
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
    reader_id: `OUT-tcp:${READER_HOST}:${READER_PORT}`,
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

/** ===== Parser A: PROTOCOL CF... (kalau reader OUT mengirim protokol lengkap) ===== */
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
  if (!(cmdHi === 0x00 && cmdLo === 0x01)) return null;

  const len = frame[4];
  const status = frame[5];
  if (status !== 0x00) return null;

  const payload = frame.slice(0, 1 + 1 + 2 + 1 + len);
  const crcGot = frame.slice(1 + 1 + 2 + 1 + len, 1 + 1 + 2 + 1 + len + 2);
  const crcOk = crcGot.equals(crc16Mcrf4xx(payload));

  const data = frame.slice(6, 6 + (len - 1));
  if (data.length < 2 + 1 + 1 + 1) return null;

  const rssiDbm = data.readInt16BE(0) / 10;
  const epcLen = data[2 + 1 + 1];
  const epcStart = 2 + 1 + 1 + 1;
  const epcEnd = epcStart + epcLen;
  if (data.length < epcEnd) return null;

  const epcHexRaw = data.slice(epcStart, epcEnd).toString("hex").toUpperCase();
  const epc = normalizeEpcHex(epcHexRaw);
  if (!epc) return null;

  return { epc, rssiDbm, crcOk, mode: "CF" };
}

/** ===== Parser B: LEGACY 01000CE280... (mode lama kamu) ===== */
function parseEpcLegacy(buffer) {
  const hex = buffer.toString("hex").toUpperCase();
  const match = hex.match(/01000CE280([0-9A-F]{20})/);
  return match ? match[1] : null;
}

/** ===== Anti-noise gate ===== */
const candidates = new Map();

async function handleTag(epc, rssiDbm, meta) {
  const now = Date.now();
  const c = candidates.get(epc) || { first: now, count: 0, maxRssi: -999, lastEmit: 0 };

  if (now - c.first > HIT_WINDOW_MS) {
    c.first = now;
    c.count = 0;
    c.maxRssi = -999;
  }

  c.count += 1;
  if (Number.isFinite(rssiDbm)) c.maxRssi = Math.max(c.maxRssi, rssiDbm);
  candidates.set(epc, c);

  const enoughHits = c.count >= MIN_HITS;
  const cooldownOk = (now - c.lastEmit) >= COOLDOWN_MS;

  // kalau RSSI available, gate pakai RSSI
  const rssiOk = Number.isFinite(rssiDbm) ? (c.maxRssi >= RSSI_MIN_DBM) : true;

  if (!enoughHits || !cooldownOk || !rssiOk) return;

  const last = lastState.get(epc);
  if (last && last.zone === ZONE) { c.lastEmit = now; return; }

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
    console.log(`✅ [OUT] EPC ${epc}${Number.isFinite(rssiDbm) ? ` rssi=${rssiDbm.toFixed(1)}dBm` : ""}`);
    saveState(epc, ZONE);
  } else {
    console.warn(`❌ [OUT] gagal kirim EPC ${epc}`);
  }

  c.lastEmit = now;
}

/** ===== Connect TCP ===== */
const client = net.createConnection({ host: READER_HOST, port: READER_PORT }, () => {
  console.log(`🟢 OUT connected ${READER_HOST}:${READER_PORT}`);
});

client.on("data", (buf) => {
  // coba parse CF frames
  acc = Buffer.concat([acc, buf]);
  for (const f of pullFrames()) {
    const p = parseInventoryFromFrame(f);
    if (p) handleTag(p.epc, p.rssiDbm, { mode: p.mode, crcOk: p.crcOk, rssiDbm: p.rssiDbm });
  }

  // fallback legacy parser
  const epcLegacy = parseEpcLegacy(buf);
  if (epcLegacy) handleTag(epcLegacy, null, { mode: "LEGACY" });
});

client.on("error", (e) => console.error("❌ OUT TCP error:", e.message));
client.on("close", () => console.log("🔴 OUT TCP closed"));
