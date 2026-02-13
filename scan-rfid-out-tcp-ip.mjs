// rfid-out-tcp.mjs
import net from "net";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

const ZONE = "OUT";

const READER_HOST = process.env.RFID_READER_HOST || "192.168.179.200";
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
const DEBUG_RAW = String(process.env.DEBUG_RAW || "0") === "1";
const INVENTORY_POLL = String(process.env.INVENTORY_POLL || "0") === "1";
const INVENTORY_INTERVAL_MS = Number(process.env.INVENTORY_INTERVAL_MS || 300);
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 1500);
const SYNC_STATE_FROM_DISK = String(process.env.SYNC_STATE_FROM_DISK || "1") !== "0";
const SINGLE_INSTANCE = String(process.env.SINGLE_INSTANCE || "1") !== "0";
const LOCK_FILE = process.env.LOCK_FILE || `/tmp/rfid-${ZONE.toLowerCase()}-tcp.lock`;

function normalizeEpcHex(epcHex) {
  let hex = String(epcHex || "").toUpperCase();
  if (hex.startsWith("E280")) hex = hex.slice(4);
  if (/^[0-9A-F]{20}$/.test(hex) || /^[0-9A-F]{24}$/.test(hex)) return hex;
  return null;
}

function crc16Mcrf4xx(buf) {
  let value = 0xffff;
  for (const b of buf) {
    value ^= b;
    for (let i = 0; i < 8; i++) {
      value = value & 0x0001 ? (value >> 1) ^ 0x8408 : value >> 1;
    }
  }
  return Buffer.from([(value >> 8) & 0xff, value & 0xff]);
}

function buildInventoryCmd() {
  const payload = Buffer.from([0x04, 0x00, 0x01]);
  const crcBE = crc16Mcrf4xx(payload);
  const crcLow = crcBE[1];
  const crcHigh = crcBE[0];
  return Buffer.from([...payload, crcLow, crcHigh]);
}

const lastState = new Map();

function loadStateFromDisk() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const fresh = new Map();
    for (const line of fs.readFileSync(STATE_FILE, "utf-8").split("\n")) {
      if (!line.trim()) continue;
      const [epc, zone, time] = line.split("|");
      const t = Number(time);
      if (epc && zone && Number.isFinite(t)) {
        fresh.set(epc, { zone, time: t });
      }
    }
    lastState.clear();
    for (const [epc, state] of fresh.entries()) {
      lastState.set(epc, state);
    }
  } catch {
    // DEBUG // console.warn(`⚠️ [${ZONE}] gagal sync state dari disk, pakai cache memory.`);
  }
}

function persistStateToDisk() {
  const lines = Array.from(lastState.entries()).map(
    ([e, v]) => `${e}|${v.zone}|${v.time}`,
  );
  const tmpFile = `${STATE_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, lines.join("\n"));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    try {
      fs.writeFileSync(STATE_FILE, lines.join("\n"));
    } catch {}
  }
}

function saveState(epc, zone) {
  const time = Date.now();
  lastState.set(epc, { zone, time });
  persistStateToDisk();
}

loadStateFromDisk();

function zoneToPresence(zone) {
  if (zone === "IN") return "in_room";
  if (zone === "OUT") return "out_of_room";
  return "unknown";
}

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
    return j?.found ? j.presence_status || null : null;
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
    reader_id: `${ZONE}-tcp:${READER_HOST}:${READER_PORT}`,
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
    if (!resp.ok) {
      const bodyText = await resp.text().catch(() => "");
      console.warn(
        `❌ [${ZONE}] backend ${resp.status}: ${bodyText || resp.statusText}`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`❌ [${ZONE}] fetch error: ${e && e.message ? e.message : e}`);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

let acc = Buffer.alloc(0);

function pullFrames() {
  const frames = [];
  while (acc.length >= 6) {
    const start = acc.indexOf(0xcf);
    if (start < 0) {
      acc = Buffer.alloc(0);
      break;
    }
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
  const cmdHi = frame[2],
    cmdLo = frame[3];
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

function parseEpcLegacy(buffer) {
  const hex = buffer.toString("hex").toUpperCase();
  const matchE280 = hex.match(/01000CE280([0-9A-F]{20})/);
  if (matchE280) return matchE280[1];

  const match12 = hex.match(/01000C([0-9A-F]{24})/);
  if (match12) return match12[1];

  return null;
}

const candidates = new Map();

async function handleTag(epc, rssiDbm, meta) {
  const now = Date.now();
  const c = candidates.get(epc) || {
    first: now,
    count: 0,
    maxRssi: -999,
    lastEmit: 0,
  };

  if (now - c.first > HIT_WINDOW_MS) {
    c.first = now;
    c.count = 0;
    c.maxRssi = -999;
  }

  c.count += 1;
  if (Number.isFinite(rssiDbm)) c.maxRssi = Math.max(c.maxRssi, rssiDbm);
  candidates.set(epc, c);

  const enoughHits = c.count >= MIN_HITS;
  const cooldownOk = now - c.lastEmit >= COOLDOWN_MS;
  const rssiOk = Number.isFinite(rssiDbm) ? c.maxRssi >= RSSI_MIN_DBM : true;

  if (!enoughHits || !cooldownOk || !rssiOk) {
    // DEBUG // console.log(`⏭ [${ZONE}] skip epc=${epc} hits=${c.count}/${MIN_HITS} cooldown=${now - c.lastEmit}/${COOLDOWN_MS} rssi=${Number.isFinite(c.maxRssi) ? c.maxRssi.toFixed(1) : "n/a"} min=${RSSI_MIN_DBM}`);
    return;
  }

  if (SYNC_STATE_FROM_DISK) loadStateFromDisk();

  const last = lastState.get(epc);
  if (last && last.zone === ZONE) {
    // DEBUG // console.log(`⏭ [${ZONE}] skip same-zone epc=${epc}`);
    c.lastEmit = now;
    return;
  }

  if (BACKEND_PRECHECK) {
    const desiredPresence = zoneToPresence(ZONE);
    const backendPresence = await backendGetPresence(epc);
    if (backendPresence && backendPresence === desiredPresence) {
      saveState(epc, ZONE);
      c.lastEmit = now;
      return;
    }
  }

  // Set before await to prevent duplicate sends from rapid frames.
  c.lastEmit = now;
  const ok = await sendToServer(epc, ZONE, meta);
  if (ok) {
    console.log(
      `✅ [${ZONE}] EPC ${epc}${Number.isFinite(rssiDbm) ? ` rssi=${rssiDbm.toFixed(1)}dBm` : ""}`,
    );
    saveState(epc, ZONE);
  } else {
    console.warn(`❌ [${ZONE}] gagal kirim EPC ${epc}`);
  }
}

let client = null;
let pollTimer = null;
let reconnectTimer = null;
let shuttingDown = false;
let lockFd = null;

function acquireLockOrExit() {
  if (!SINGLE_INSTANCE) return;

  const tryAcquire = () => {
    lockFd = fs.openSync(LOCK_FILE, "wx");
    fs.writeFileSync(lockFd, String(process.pid));
  };

  try {
    tryAcquire();
  } catch (e) {
    if (e.code !== "EEXIST") throw e;

    let stale = true;
    try {
      const pidText = fs.readFileSync(LOCK_FILE, "utf-8").trim();
      const pid = Number(pidText);
      if (Number.isFinite(pid)) {
        process.kill(pid, 0);
        stale = false;
        console.error(
          `❌ ${ZONE} scanner already running (pid=${pid}). Stop it or set SINGLE_INSTANCE=0.`,
        );
      }
    } catch {
      stale = true;
    }

    if (!stale) process.exit(1);

    try {
      fs.unlinkSync(LOCK_FILE);
    } catch {}
    tryAcquire();
  }
}

function releaseLock() {
  if (!SINGLE_INSTANCE) return;
  try {
    if (lockFd !== null) fs.closeSync(lockFd);
  } catch {}
  lockFd = null;
  try {
    if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
  } catch {}
}

function clearTimers() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

function scheduleReconnect(reason = "close") {
  if (shuttingDown) return;
  if (reconnectTimer) return;
  console.warn(`🔁 ${ZONE} reconnect in ${RECONNECT_MS}ms (${reason})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectReader();
  }, RECONNECT_MS);
}

function connectReader() {
  if (shuttingDown) return;
  acc = Buffer.alloc(0);
  client = net.createConnection({ host: READER_HOST, port: READER_PORT });

  client.setNoDelay(true);
  client.setKeepAlive(true, 15000);
  client.setTimeout(0);

  client.on("connect", () => {
    console.log(`🟢 ${ZONE} connected ${READER_HOST}:${READER_PORT}`);

    if (INVENTORY_POLL) {
      const cmd = buildInventoryCmd();
      if (!client.destroyed) client.write(cmd);
      pollTimer = setInterval(() => {
        if (!client || client.destroyed) return;
        client.write(cmd);
      }, INVENTORY_INTERVAL_MS);
      console.log(
        `📶 [${ZONE}] inventory poll ON (${INVENTORY_INTERVAL_MS}ms)`,
      );
    }
  });

  client.on("data", (buf) => {
    if (DEBUG_RAW) {
      console.log(
        `📥 [${ZONE}] raw ${buf.length} bytes: ${buf.toString("hex").slice(0, 120)}`,
      );
    }

    acc = Buffer.concat([acc, buf]);
    let parsedFromCf = false;
    for (const f of pullFrames()) {
      const p = parseInventoryFromFrame(f);
      if (p) {
        parsedFromCf = true;
        handleTag(p.epc, p.rssiDbm, {
          mode: p.mode,
          crcOk: p.crcOk,
          rssiDbm: p.rssiDbm,
        });
      }
    }

    if (!parsedFromCf) {
      const epcLegacy = parseEpcLegacy(buf);
      if (epcLegacy) handleTag(epcLegacy, null, { mode: "LEGACY" });
    }
  });

  client.on("error", (e) => {
    console.error(`❌ ${ZONE} TCP error:`, e.message);
  });

  client.on("close", () => {
    console.log(`🔴 ${ZONE} TCP closed`);
    clearTimers();
    scheduleReconnect("close");
  });
}

function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`🛑 ${ZONE} stopping (${sig})`);
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  clearTimers();
  if (client && !client.destroyed) client.destroy();
  releaseLock();
}

process.on("SIGINT", () => {
  shutdown("SIGINT");
  process.exit(0);
});

process.on("SIGTERM", () => {
  shutdown("SIGTERM");
  process.exit(0);
});

process.on("exit", () => {
  releaseLock();
});

acquireLockOrExit();
connectReader();
