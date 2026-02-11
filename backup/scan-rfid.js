/**
 * scan-rfid.js
 *
 * UHF reader TCP client that:
 * - parses EPC from reader
 * - normalizes EPC (REMOVE E280)
 * - keeps local state file to avoid re-sends
 * - queries backend about current presence_status for that EPC
 * - only POSTs event if backend presence_status differs
 *
 * EPC FORMAT FINAL:
 * - 24 HEX
 * - TANPA "E280"
 * - MATCH register-rfid.js
 */

import net from "net";
import fs from "fs";
import path from "path";
import fetch from "node-fetch";

/**
 * =============================
 * CONFIG (ENV)
 * =============================
 */
const READER = {
  host: process.env.RFID_READER_HOST || "192.168.1.200",
  port: Number(process.env.RFID_READER_PORT || 2022),
  zone: process.env.RFID_READER_ZONE || "OUT", // IN | OUT
};

const STATE_FILE = path.resolve(process.env.STATE_FILE || "./rfid_state.txt");

const BACKEND_URL = process.env.BACKEND_URL || "http://localhost:3001";
const BACKEND_AUTH = process.env.BACKEND_AUTH || "";
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 5000);

/**
 * =============================
 * EPC NORMALIZER (SAMA DENGAN REGISTER)
 * =============================
 */
function normalizeEpc(rawHex) {
  if (!rawHex) return null;

  const hex = rawHex.toUpperCase();

  // E280 + 24 HEX
 const match = hex.match(/01000CE280([0-9A-F]{20})/);

  if (match) return match[1];

  // fallback: already clean
  if (/^[0-9A-F]{24}$/.test(hex)) return hex;

  return null;
}

/**
 * =============================
 * LOAD STATE FILE
 * =============================
 */
const lastState = new Map();

if (fs.existsSync(STATE_FILE)) {
  try {
    const lines = fs.readFileSync(STATE_FILE, "utf-8").split("\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      const [epc, zone, time] = line.split("|");
      lastState.set(epc, { zone, time: Number(time) });
    }
    console.log(`📂 Loaded ${lastState.size} RFID states`);
  } catch (e) {
    console.warn("⚠️ Failed to load state file:", e.message);
  }
}

/**
 * =============================
 * SAVE STATE
 * =============================
 */
function saveState(epc, zone) {
  const time = Date.now();
  lastState.set(epc, { zone, time });

  try {
    const lines = Array.from(lastState.entries()).map(
      ([e, v]) => `${e}|${v.zone}|${v.time}`
    );
    fs.writeFileSync(STATE_FILE, lines.join("\n"));
  } catch (e) {
    console.warn("⚠️ Failed to write state file:", e.message);
  }
}

/**
 * =============================
 * ZONE → PRESENCE
 * =============================
 */
function zoneToPresence(zone) {
  const z = String(zone).toUpperCase();
  if (z === "IN") return "in_room";
  if (z === "OUT") return "out_of_room";
  return "unknown";
}

/**
 * =============================
 * CONNECT TO READER
 * =============================
 */
const client = net.createConnection(
  { host: READER.host, port: READER.port },
  () => {
    console.log(
      `🟢 Connected to UHF Reader (${READER.zone}) at ${READER.host}:${READER.port}`
    );
  }
);

client.setTimeout(0);

/**
 * =============================
 * HANDLE DATA FROM READER
 * =============================
 */
client.on("data", async (buffer) => {
  try {
    const epc = parseEpcFromBuffer(buffer);
    if (!epc) return;

    console.log(`📡 EPC detected: ${epc}`);

    const last = lastState.get(epc);
    if (last && last.zone === READER.zone) return;

    const desiredPresence = zoneToPresence(READER.zone);

    let backendPresence = null;

    try {
      const url = `${BACKEND_URL.replace(
        /\/$/,
        ""
      )}/api/documents/rfid/epc/${encodeURIComponent(epc)}`;

      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        BACKEND_TIMEOUT_MS
      );

      const resp = await fetch(url, {
        method: "GET",
        headers: BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {},
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (resp.ok) {
        const j = await resp.json();
        if (j && j.found) {
          backendPresence = j.presence_status || null;
        }
      }
    } catch (e) {
      console.warn("⚠️ Backend check failed:", e.message);
    }

    if (backendPresence && backendPresence === desiredPresence) {
      console.log(`ℹ️ Backend already ${desiredPresence}, skip`);
      saveState(epc, READER.zone);
      return;
    }

    const sent = await sendToServer(epc, READER.zone);
    if (sent) saveState(epc, READER.zone);
  } catch (e) {
    console.error("❌ Processing error:", e.message);
  }
});

/**
 * =============================
 * SEND EVENT TO BACKEND
 * =============================
 */
async function sendToServer(epc, zone) {
  const url = `${BACKEND_URL.replace(
    /\/$/,
    ""
  )}/api/documents/rfid/events`;

  const body = {
    epc,
    zone,
    reader_id: `${READER.host}:${READER.port}`,
    payload: {
      source: "uhf-reader",
      zone_origin: READER.zone,
    },
  };

  console.log(`🚀 Sending: ${epc} → ${zone}`);

  try {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      BACKEND_TIMEOUT_MS
    );

    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!resp.ok) {
      console.error(`❌ Backend rejected: ${resp.status}`);
      return false;
    }

    console.log(`✅ Backend accepted EPC ${epc}`);
    return true;
  } catch (e) {
    console.error("❌ POST failed:", e.message);
    return false;
  }
}

/**
 * =============================
 * EPC PARSER (RC4 ACTIVE MODE)
 * =============================
 * Reader format:
 *   01000C + E280XXXXXXXXXXXX (24 HEX)
 */
function parseEpcFromBuffer(buffer) {
  const hex = buffer.toString("hex").toUpperCase();

  const match = hex.match(/01000CE280([0-9A-F]{20})/);
  if (match) return match[1];

  return null;
}

/**
 * =============================
 * ERROR HANDLERS
 * =============================
 */
client.on("error", (err) => {
  console.error("❌ Reader error:", err.message);
});

client.on("close", () => {
  console.log("🔴 Connection closed");
});

client.on("end", () => {
  console.log("🔴 Connection ended by reader");
});
