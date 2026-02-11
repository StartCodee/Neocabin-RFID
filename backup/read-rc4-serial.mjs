// read-rc4-serial.mjs
import { SerialPort } from "serialport";

const SERIAL_PATH = process.env.SERIAL_PORT || "/dev/cu.PL2303G-USBtoUART120";

const port = new SerialPort({
  path: SERIAL_PATH,
  baudRate: 115200, // standar 115200 8N1
  dataBits: 8,
  stopBits: 1,
  parity: "none",
});

port.on("open", () => console.log("🟢 Serial open:", SERIAL_PATH));
port.on("error", (e) => console.error("❌ Serial error:", e.message));

/**
 * Buffer penampung karena data serial bisa kepotong2
 */
let acc = Buffer.alloc(0);

function crc16Mcrf4xx(buf) {
  // sesuai contoh CRC-16/MCRF4XX (poly 0x8408, init 0xFFFF) :contentReference[oaicite:2]{index=2}
  let value = 0xffff;
  for (const b of buf) {
    value ^= b;
    for (let i = 0; i < 8; i++) {
      value = (value & 0x0001) ? ((value >> 1) ^ 0x8408) : (value >> 1);
    }
  }
  const msb = (value >> 8) & 0xff;
  const lsb = value & 0xff;
  return Buffer.from([msb, lsb]); // [crc_msb, crc_lsb]
}

function normalizeEpcHex(epcHex) {
  let hex = epcHex.toUpperCase();
  if (hex.startsWith("E280")) hex = hex.slice(4); // buang E280 (2 byte)
  // terima 20 atau 24 hex (tergantung tag/setting kamu)
  if (/^[0-9A-F]{20}$/.test(hex) || /^[0-9A-F]{24}$/.test(hex)) return hex;
  return null;
}

/**
 * Parse frame response:
 * Header(1)=CF, Addr(1), Cmd(2), Len(1), Status(1), Data(Len-1), CRC(2)
 * Total = 1+1+2+1+Len+2
 */
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

    const len = acc[4]; // Length = status+data
    const total = 1 + 1 + 2 + 1 + len + 2;

    if (acc.length < total) break;

    const frame = acc.slice(0, total);
    acc = acc.slice(total);
    frames.push(frame);
  }

  return frames;
}

function parseInventoryEpcFromFrame(frame) {
  // cmd 00 01 adalah inventory response di active/trigger :contentReference[oaicite:3]{index=3}
  const cmdHi = frame[2];
  const cmdLo = frame[3];
  if (!(cmdHi === 0x00 && cmdLo === 0x01)) return null;

  const len = frame[4];
  const status = frame[5];
  if (status !== 0x00) return null; // 00 = berhasil, ada data tag :contentReference[oaicite:4]{index=4}

  // Validasi CRC (opsional tapi bagus)
  const payloadForCrc = frame.slice(0, 1 + 1 + 2 + 1 + len); // header..(status+data)
  const crcGot = frame.slice(1 + 1 + 2 + 1 + len, 1 + 1 + 2 + 1 + len + 2);
  const crcCalc = crc16Mcrf4xx(payloadForCrc);
  const crcOk = crcGot.equals(crcCalc);

  // Data[] format inventory: RSSI(2), Ant(1), Channel(1), EPC_len(1), EPC(N) :contentReference[oaicite:5]{index=5}
  const data = frame.slice(6, 6 + (len - 1)); // (len-1) karena status sudah 1 byte
  if (data.length < 2 + 1 + 1 + 1) return null;

  const epcLen = data[2 + 1 + 1]; // setelah RSSI2 + antenna1 + channel1
  const epcStart = 2 + 1 + 1 + 1;
  const epcEnd = epcStart + epcLen;
  if (data.length < epcEnd) return null;

  const epcBytes = data.slice(epcStart, epcEnd);
  const epcHexRaw = epcBytes.toString("hex").toUpperCase();
  const epcHex = normalizeEpcHex(epcHexRaw);

  return { epcHexRaw, epcHex, crcOk };
}

port.on("data", (buf) => {
  // INI kunci supaya gak jadi “��‰�…”
  console.log("HEX:", buf.toString("hex").toUpperCase());

  acc = Buffer.concat([acc, buf]);
  const frames = pullFrames();

  for (const f of frames) {
    const parsed = parseInventoryEpcFromFrame(f);
    if (parsed?.epcHex) {
      console.log(`✅ EPC: ${parsed.epcHex} (raw=${parsed.epcHexRaw}, crcOk=${parsed.crcOk})`);
    }
  }
});
