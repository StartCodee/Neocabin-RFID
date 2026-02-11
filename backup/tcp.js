import net from "net";
import fs from "fs";
import path from "path";

/**
 * =============================
 * CONFIG
 * =============================
 */
const READER = {
  host: "192.168.1.200",
  port: 2022,
  zone: "IN", // reader ini khusus IN
};

const STATE_FILE = path.resolve("./rfid_state.txt");

/**
 * =============================
 * LOAD STATE FROM FILE
 * =============================
 */
const lastState = new Map();

if (fs.existsSync(STATE_FILE)) {
  const lines = fs.readFileSync(STATE_FILE, "utf-8").split("\n");
  for (const line of lines) {
    if (!line.trim()) continue;
    const [epc, zone, time] = line.split("|");
    lastState.set(epc, { zone, time: Number(time) });
  }
  console.log(`📂 Loaded ${lastState.size} RFID states`);
}

/**
 * =============================
 * SAVE STATE
 * =============================
 */
function saveState(epc, zone) {
  const time = Date.now();
  lastState.set(epc, { zone, time });

  const lines = Array.from(lastState.entries()).map(
    ([e, v]) => `${e}|${v.zone}|${v.time}`
  );

  fs.writeFileSync(STATE_FILE, lines.join("\n"));
}

/**
 * =============================
 * CONNECT TCP
 * =============================
 */
const client = net.createConnection(
  { host: READER.host, port: READER.port },
  () => {
    console.log(`🟢 Connected to UHF Reader (${READER.zone})`);
  }
);

/**
 * =============================
 * DATA FROM READER
 * =============================
 */
client.on("data", (buffer) => {
  const epc = parseEPC(buffer);
  if (!epc) return;

  // ✅ PRINT TERUS (DEBUG / MONITOR)
  console.log(`📡 EPC detected: ${epc}`);

  const last = lastState.get(epc);

  // ❌ sudah pernah IN → jangan kirim ke server
  if (last && last.zone === READER.zone) {
    return;
  }

  // ✅ pertama kali IN → kirim & simpan
  sendToServer(epc, READER.zone);
  saveState(epc, READER.zone);
});

/**
 * =============================
 * SEND TO SERVER (ONCE)
 * =============================
 */
function sendToServer(epc, zone) {
  console.log(`🚀 SEND TO SERVER: ${epc} → ${zone}`);

  // fetch("http://localhost:8000/api/rfid", { ... })
}

/**
 * =============================
 * EPC PARSER (RC4 ACTIVE MODE)
 * =============================
 */
function parseEPC(buffer) {
  const hex = buffer.toString("hex").toUpperCase();

  // EPC length 12 bytes → 01000C + 24 hex
  const match = hex.match(/01000C([0-9A-F]{24})/);
  if (match) return match[1];

  return null;
}

/**
 * =============================
 * ERROR HANDLER
 * =============================
 */
client.on("error", (err) => {
  console.error("❌ Reader error:", err.message);
});

client.on("close", () => {
  console.log("🔴 Connection closed");
});
