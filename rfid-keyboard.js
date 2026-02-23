/**
 * rfid-keyboard.js
 *
 * RFID USB/Serial → Auto type EPC ke posisi kursor aktif
 * - EPC 20 HEX (tanpa E280)
 * - Sama persis dengan scan-rfid.js
 */

import { SerialPort } from "serialport";
import robot from "robotjs";
import { crc16 } from "./backup/crc16.js";

/**
 * =====================
 * RFID STATE
 * =====================
 */
let lastValidEpc = null;
let lastReadAt = 0;

const COOLDOWN = Number(process.env.COOLDOWN_MS || 3000);

/**
 * =====================
 * EPC NORMALIZER
 * =====================
 * - Buang E280
 * - Ambil 20 HEX
 */
function normalizeEpc(rawHex) {
  if (!rawHex) return null;

  const hex = rawHex.toUpperCase();

  // E280 + 20 hex
  const match = hex.match(/E280([0-9A-F]{20})/);
  if (match) return match[1];

  // Sudah bersih
  if (/^[0-9A-F]{20}$/.test(hex)) return hex;

  return null;
}

/**
 * =====================
 * SERIAL CONFIG
 * =====================
 */
const serialPath = process.env.SERIAL_PATH || "/dev/cu.usbserial-1120";
const serialBaud = Number(process.env.SERIAL_BAUD || 57600);

const port = new SerialPort({
  path: serialPath,
  baudRate: serialBaud,
});

port.on("open", () => {
  console.log("🔌 RFID connected:", serialPath);
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
 * RFID RECEIVE
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

    console.log("🟢 RFID TAP → TYPE:", epc);

    /**
     * =====================
     * TYPE KE KURSOR
     * =====================
     */
    robot.typeString(epc);
    robot.keyTap("enter"); // hapus kalau tidak mau enter

  } catch (err) {
    console.error("❌ Parse error");
  }
});
