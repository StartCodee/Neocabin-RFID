/**
 * register-rfid.js
 *
 * Local USB/Serial RFID tap service.
 * - exposes GET /rfid/latest to let frontend fetch the latest tap (and auto-clear it)
 *
 * EPC FORMAT FINAL:
 * - 24 HEX
 * - TANPA "E280"
 * - MATCH 100% dengan scan-rfid.js
 */

import express from "express";
import cors from "cors";
import { SerialPort } from "serialport";
import { crc16 } from "./backup/crc16.js";

const app = express();
app.use(cors());
app.use(express.json());

/**
 * =====================
 * RFID STATE
 * =====================
 */
let lastValidEpc = null;
let lastReadAt = 0;

const EPC_LENGTH = 24;
const COOLDOWN = Number(process.env.COOLDOWN_MS || 3000);

/**
 * =====================
 * EPC NORMALIZER (FIXED)
 * =====================
 * - Buang "E280" jika ada
 * - Ambil 24 HEX SETELAHNYA
 * - Sama dengan scan-rfid.js
 */
function normalizeEpc(rawHex) {
  if (!rawHex) return null;

  const hex = rawHex.toUpperCase();

  // Cari E280 + 24 hex (persis seperti scan-rfid.js)
  const match = hex.match(/E280([0-9A-F]{20})/);
  if (match) return match[1];

  // Fallback: jika sudah 24 hex TANPA E280
  if (/^[0-9A-F]{20}$/.test(hex)) return hex;

  return null;
}

/**
 * =====================
 * SERIAL CONFIG
 * =====================
 */
const serialPath = process.env.SERIAL_PATH || "/dev/cu.usbserial-1110";
const serialBaud = Number(process.env.SERIAL_BAUD || 57600);

const port = new SerialPort({
  path: serialPath,
  baudRate: serialBaud,
});

port.on("open", () => {
  console.log("🔌 RFID Reader connected:", serialPath, "@", serialBaud);
});

port.on("error", (err) => {
  console.error("❌ Serial error:", err.message);
});

/**
 * =====================
 * INVENTORY COMMAND
 * =====================
 */
function buildInventoryCmd() {
  const payload = Buffer.from([0x04, 0x00, 0x01]);
  const crc = crc16(payload);

  return Buffer.from([
    ...payload,
    crc & 0xff,
    (crc >> 8) & 0xff,
  ]);
}

const INVENTORY_CMD = buildInventoryCmd();

/**
 * =====================
 * AUTO INVENTORY LOOP
 * =====================
 */
setInterval(() => {
  try {
    port.write(INVENTORY_CMD);
  } catch {}
}, Number(process.env.INVENTORY_INTERVAL_MS || 300));

/**
 * =====================
 * RECEIVE RFID DATA
 * =====================
 */
port.on("data", (buf) => {
  try {
    let offset = 5;
    const epcLen = buf[offset];
    offset++;

    const epcBytes = epcLen * 2;

    const rawEpc = buf
      .slice(offset, offset + epcBytes)
      .toString("hex")
      .toUpperCase();

    const epc = normalizeEpc(rawEpc);
    if (!epc) return;

    const now = Date.now();
    if (epc === lastValidEpc && now - lastReadAt < COOLDOWN) return;

    lastValidEpc = epc;
    lastReadAt = now;

    console.log("🟢 EPC REGISTER (MATCHED):", epc);
  } catch {}
});

/**
 * =====================
 * API FOR FRONTEND
 * =====================
 */
app.get("/rfid/latest", (req, res) => {
  if (!lastValidEpc) {
    return res.json({ epc: null, timestamp: null });
  }

  const result = {
    epc: lastValidEpc,
    timestamp: lastReadAt,
  };

  lastValidEpc = null;
  lastReadAt = 0;

  res.json(result);
});

/**
 * =====================
 * HEALTH CHECK
 * =====================
 */
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    serial: serialPath,
    baud: serialBaud,
  });
});

/**
 * =====================
 * START SERVER
 * =====================
 */
const PORT = Number(process.env.LOCAL_PORT || 4001);
app.listen(PORT, () => {
  console.log(`🚀 RFID Register Service running at http://localhost:${PORT}`);
});
