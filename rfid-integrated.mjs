// rfid-integrated.mjs
// Gabungan lengkap:
// - Register (serial) dari rfid-integrated.mjs asli (dengan Pusher)
// - TCP IN dari scan-rfid-in-tcp-ip.mjs
// - TCP OUT dari scan-rfid-out-tcp-ip.js
// Tidak ada logika yang diubah, hanya digabung dan diberi namespace internal.
// (Modifikasi: pada serial, EPC 24 hex dipotong menjadi 20 hex agar konsisten dengan TCP)

import net from 'net';
import fs from 'fs';
import path from 'path';
import { SerialPort } from 'serialport';
import Pusher from 'pusher';

// ==================== KONFIGURASI PUSHER (dari rfid-integrated.mjs) ====================
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '2115522',
  key: process.env.PUSHER_KEY || '225b816c1d4571b06f36',
  secret: process.env.PUSHER_SECRET || '44ac8c4c4ed510bc52dd',
  cluster: process.env.PUSHER_CLUSTER || 'ap1',
  useTLS: true,
});

// ==================== KONSTANTA LINGKUNGAN UMUM ====================
const BACKEND_URL = process.env.BACKEND_URL || 'https://bkad.kotabogor.go.id/api-arsip';
const BACKEND_AUTH = process.env.BACKEND_AUTH || '';
const BACKEND_TIMEOUT_MS = Number(process.env.BACKEND_TIMEOUT_MS || 5000);
const STATE_FILE = path.resolve(process.env.STATE_FILE || './rfid_state.txt');

// Konfigurasi serial (REGISTER) - dari rfid-integrated.mjs
const SERIAL_PATH = process.env.SERIAL_PATH || 'COM4';
const SERIAL_BAUD = Number(process.env.SERIAL_BAUD || 57600);
const SERIAL_COOLDOWN = Number(process.env.SERIAL_COOLDOWN_MS || 3000);

// Konfigurasi TCP IN - dari scan-rfid-in-tcp-ip.mjs (dengan prefix IN)
const IN_HOST = process.env.IN_HOST || process.env.RFID_READER_HOST || '192.168.179.201';
const IN_PORT = Number(process.env.IN_PORT || process.env.RFID_READER_PORT || 2022);
const IN_RSSI_MIN = Number(process.env.IN_RSSI_MIN || process.env.RSSI_MIN_DBM || -90);
const IN_HIT_WINDOW = Number(process.env.IN_HIT_WINDOW_MS || process.env.HIT_WINDOW_MS || 250);
const IN_MIN_HITS = Number(process.env.IN_MIN_HITS || process.env.MIN_HITS || 2);
const IN_COOLDOWN = Number(process.env.IN_COOLDOWN_MS || process.env.COOLDOWN_MS || 3000);
const IN_INVENTORY_POLL = process.env.IN_INVENTORY_POLL !== '0'; // default true
const IN_BACKEND_PRECHECK = process.env.IN_BACKEND_PRECHECK === '1';

// Konfigurasi TCP OUT - dari scan-rfid-out-tcp-ip.js (dengan prefix OUT)
const OUT_HOST = process.env.OUT_HOST || process.env.RFID_READER_HOST || '192.168.179.200';
const OUT_PORT = Number(process.env.OUT_PORT || process.env.RFID_READER_PORT || 2022);
const OUT_RSSI_MIN = Number(process.env.OUT_RSSI_MIN || process.env.RSSI_MIN_DBM || -127);
const OUT_HIT_WINDOW = Number(process.env.OUT_HIT_WINDOW_MS || process.env.HIT_WINDOW_MS || 0);
const OUT_MIN_HITS = Number(process.env.OUT_MIN_HITS || process.env.MIN_HITS || 1);
const OUT_COOLDOWN = Number(process.env.OUT_COOLDOWN_MS || process.env.COOLDOWN_MS || 0);
const OUT_INVENTORY_POLL = process.env.OUT_INVENTORY_POLL === '1'; // default false
const OUT_BACKEND_PRECHECK = process.env.OUT_BACKEND_PRECHECK === '1';

// Konfigurasi umum TCP
const INVENTORY_INTERVAL = Number(process.env.INVENTORY_INTERVAL_MS || 300);
const RECONNECT_MS = Number(process.env.RECONNECT_MS || 1500);
const DEBUG_RAW = process.env.DEBUG_RAW === '1';
const SYNC_STATE_FROM_DISK = process.env.SYNC_STATE_FROM_DISK !== '0';
const SINGLE_INSTANCE = process.env.SINGLE_INSTANCE !== '0';

// ==================== FUNGSI-FUNGSI UMUM (dari ketiga file, disatukan) ====================

// Normalisasi EPC (dari rfid-integrated.mjs)
function normalizeEpc(epcHex) {
  let hex = String(epcHex || '').toUpperCase();
  if (hex.startsWith('E280')) hex = hex.slice(4);
  if (/^[0-9A-F]{20}$/.test(hex) || /^[0-9A-F]{24}$/.test(hex)) return hex;
  return null;
}

// CRC16 (sama di semua file)
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

// Perintah inventory (sama di semua file)
function buildInventoryCmd() {
  const payload = Buffer.from([0x04, 0x00, 0x01]);
  const crcBE = crc16Mcrf4xx(payload);
  const crcLow = crcBE[1];
  const crcHigh = crcBE[0];
  return Buffer.from([...payload, crcLow, crcHigh]);
}

// Pull frame versi aman (dari rfid-integrated.mjs) – dapat diinstance
function pullFrames(acc) {
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
  return { frames, remaining: acc };
}

// Parse frame inventory (sama di semua file)
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

  const epcHexRaw = data.slice(epcStart, epcEnd).toString('hex').toUpperCase();
  const epc = normalizeEpc(epcHexRaw);
  if (!epc) return null;

  return { epc, rssiDbm, crcOk, mode: 'CF' };
}

// Parse EPC legacy (sama di semua file)
function parseEpcLegacy(buffer) {
  const hex = buffer.toString('hex').toUpperCase();
  const matchE280 = hex.match(/01000CE280([0-9A-F]{20})/);
  if (matchE280) return matchE280[1];
  const match12 = hex.match(/01000C([0-9A-F]{24})/);
  if (match12) return match12[1];
  return null;
}

// ==================== STATE BERSAMA UNTUK SEMUA ZONE ====================
const lastState = new Map(); // zone terakhir per EPC

function loadStateFromDisk() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const fresh = new Map();
    for (const line of fs.readFileSync(STATE_FILE, 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      const [epc, zone, time] = line.split('|');
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
    // abaikan
  }
}

function persistStateToDisk() {
  const lines = Array.from(lastState.entries()).map(
    ([e, v]) => `${e}|${v.zone}|${v.time}`
  );
  const tmpFile = `${STATE_FILE}.tmp-${process.pid}`;
  try {
    fs.writeFileSync(tmpFile, lines.join('\n'));
    fs.renameSync(tmpFile, STATE_FILE);
  } catch {
    try {
      fs.writeFileSync(STATE_FILE, lines.join('\n'));
    } catch {}
  }
}

function saveState(epc, zone) {
  const time = Date.now();
  lastState.set(epc, { zone, time });
  persistStateToDisk();
}

// Muat state awal
loadStateFromDisk();

// ==================== FUNGSI KIRIM KE BACKEND UNTUK REGISTER (Pusher) ====================
async function sendPusherEvent(epc) {
  try {
    await pusher.trigger('rfid-channel', 'tag-detected', {
      epc,
      zone: 'REGISTER',
      timestamp: Date.now(),
    });
    console.log(`📡 [PUSHER] EPC ${epc} dikirim ke frontend`);
    saveState(epc, 'REGISTER');
  } catch (err) {
    console.error('❌ Gagal trigger Pusher:', err.message);
  }
}

// ==================== FUNGSI KIRIM KE BACKEND UNTUK TCP (IN/OUT) ====================
async function sendToServer(zone, epc, meta = {}) {
  const url = `${BACKEND_URL.replace(/\/$/, '')}/api/documents/rfid/events`;
  const body = {
    epc,
    zone,
    reader_id: `${zone}-tcp:${meta.host || 'unknown'}:${meta.port || 'unknown'}`,
    payload: { source: 'uhf-reader', zone_origin: zone, ...meta },
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(BACKEND_AUTH ? { Authorization: BACKEND_AUTH } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      console.warn(`❌ [${zone}] backend ${resp.status}: ${text || resp.statusText}`);
      return false;
    }
    return true;
  } catch (e) {
    console.warn(`❌ [${zone}] fetch error: ${e.message}`);
    console.error(e);
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

// ==================== FUNGSI BACKEND PRECHECK (dari file IN/OUT) ====================
function zoneToPresence(zone) {
  if (zone === 'IN') return 'in_room';
  if (zone === 'OUT') return 'out_of_room';
  return 'unknown';
}

async function backendGetPresence(epc) {
  const url = `${BACKEND_URL.replace(/\/$/, '')}/api/documents/rfid/epc/${encodeURIComponent(epc)}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), BACKEND_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'GET',
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

// ==================== LOCK FILE (dari file IN/OUT) ====================
function acquireLockOrExit(zone, lockFile) {
  if (!SINGLE_INSTANCE) return null;

  const tryAcquire = () => {
    const fd = fs.openSync(lockFile, 'wx');
    fs.writeFileSync(fd, String(process.pid));
    return fd;
  };

  try {
    return tryAcquire();
  } catch (e) {
    if (e.code !== 'EEXIST') throw e;

    let stale = true;
    try {
      const pidText = fs.readFileSync(lockFile, 'utf-8').trim();
      const pid = Number(pidText);
      if (Number.isFinite(pid)) {
        process.kill(pid, 0);
        stale = false;
        console.error(`❌ ${zone} scanner already running (pid=${pid}). Stop it or set SINGLE_INSTANCE=0.`);
      }
    } catch {
      stale = true;
    }

    if (!stale) process.exit(1);

    try {
      fs.unlinkSync(lockFile);
    } catch {}
    return tryAcquire();
  }
}

function releaseLock(fd, lockFile) {
  if (!SINGLE_INSTANCE) return;
  try {
    if (fd !== null) fs.closeSync(fd);
  } catch {}
  try {
    if (fs.existsSync(lockFile)) fs.unlinkSync(lockFile);
  } catch {}
}

// ==================== READER SERIAL (REGISTER) ====================
function startSerialReader() {
  const port = new SerialPort({
    path: SERIAL_PATH,
    baudRate: SERIAL_BAUD,
  });

  port.on('open', () => {
    console.log(`🔌 Serial reader connected: ${SERIAL_PATH} @ ${SERIAL_BAUD}`);
    setInterval(() => {
      try {
        port.write(buildInventoryCmd());
      } catch {}
    }, INVENTORY_INTERVAL);
  });

  port.on('data', (buf) => {
    try {
      // Parsing sederhana dari rfid-integrated.mjs asli
      let offset = 5;
      const epcLen = buf[offset];
      offset++;
      const epcBytes = epcLen * 2;
      const rawEpc = buf.slice(offset, offset + epcBytes).toString('hex').toUpperCase();
      let epc = normalizeEpc(rawEpc);
      // Potong menjadi 20 karakter jika panjang 24 (agar konsisten dengan TCP IN/OUT)
      if (epc && epc.length === 24) {
        epc = epc.slice(0, 20);
      }
      if (epc) {
        const now = Date.now();
        const last = lastState.get(epc);
        if (last && last.zone === 'REGISTER' && now - last.time < SERIAL_COOLDOWN) {
          return;
        }
        sendPusherEvent(epc);
      }
    } catch (err) {
      // ignore
    }
  });

  port.on('error', (err) => {
    console.error('❌ Serial error:', err.message);
  });
}

// ==================== TCP READER GENERIK (untuk IN/OUT) ====================
function startTcpReader(zone, options) {
  const {
    host,
    port,
    rssiMin,
    hitWindowMs,
    minHits,
    cooldownMs,
    inventoryPoll,
    backendPrecheck,
  } = options;

  const lockFile = `/tmp/rfid-${zone.toLowerCase()}-tcp.lock`;
  let lockFd = null;
  if (SINGLE_INSTANCE) {
    lockFd = acquireLockOrExit(zone, lockFile);
  }

  let client = null;
  let pollTimer = null;
  let reconnectTimer = null;
  let shuttingDown = false;
  let acc = Buffer.alloc(0); // buffer per koneksi

  // candidates per zone (seperti di file asli)
  const candidates = new Map();

  const handleTag = async (epc, rssiDbm, meta) => {
    const now = Date.now();
    const c = candidates.get(epc) || { first: now, count: 0, maxRssi: -999, lastEmit: 0 };

    if (now - c.first > hitWindowMs) {
      c.first = now;
      c.count = 0;
      c.maxRssi = -999;
    }

    c.count += 1;
    if (Number.isFinite(rssiDbm)) c.maxRssi = Math.max(c.maxRssi, rssiDbm);
    candidates.set(epc, c);

    const enoughHits = c.count >= minHits;
    const cooldownOk = now - c.lastEmit >= cooldownMs;
    const rssiOk = Number.isFinite(rssiDbm) ? c.maxRssi >= rssiMin : true;

    if (!enoughHits || !cooldownOk || !rssiOk) {
      if (DEBUG_RAW) {
        console.log(`⏭ [${zone}] skip epc=${epc} hits=${c.count}/${minHits} cooldown=${now - c.lastEmit}/${cooldownMs} rssi=${Number.isFinite(c.maxRssi) ? c.maxRssi.toFixed(1) : 'n/a'} min=${rssiMin}`);
      }
      return;
    }

    if (SYNC_STATE_FROM_DISK) loadStateFromDisk();

    const last = lastState.get(epc);
    if (last && last.zone === zone) {
      c.lastEmit = now;
      return;
    }

    if (backendPrecheck) {
      const desiredPresence = zoneToPresence(zone);
      const backendPresence = await backendGetPresence(epc);
      if (backendPresence && backendPresence === desiredPresence) {
        saveState(epc, zone);
        c.lastEmit = now;
        return;
      }
    }

    c.lastEmit = now;
    const ok = await sendToServer(zone, epc, { ...meta, host, port });
    if (ok) {
      console.log(`✅ [${zone}] EPC ${epc}${Number.isFinite(rssiDbm) ? ` rssi=${rssiDbm.toFixed(1)}dBm` : ''}`);
      saveState(epc, zone);
    } else {
      console.warn(`❌ [${zone}] gagal kirim EPC ${epc}`);
    }
  };

  const clearTimers = () => {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  };

  const scheduleReconnect = (reason = 'close') => {
    if (shuttingDown) return;
    if (reconnectTimer) return;
    console.warn(`🔁 ${zone} reconnect in ${RECONNECT_MS}ms (${reason})`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connectReader();
    }, RECONNECT_MS);
  };

  const connectReader = () => {
    if (shuttingDown) return;
    acc = Buffer.alloc(0);
    client = net.createConnection({ host, port });

    client.setNoDelay(true);
    client.setKeepAlive(true, 15000);
    client.setTimeout(0);

    client.on('connect', () => {
      console.log(`🟢 ${zone} connected ${host}:${port}`);

      if (inventoryPoll) {
        const cmd = buildInventoryCmd();
        if (!client.destroyed) client.write(cmd);
        pollTimer = setInterval(() => {
          if (!client || client.destroyed) return;
          client.write(cmd);
        }, INVENTORY_INTERVAL);
        console.log(`📶 [${zone}] inventory poll ON (${INVENTORY_INTERVAL}ms)`);
      }
    });

    client.on('data', (buf) => {
      if (DEBUG_RAW) {
        console.log(`📥 [${zone}] raw ${buf.length} bytes: ${buf.toString('hex').slice(0, 120)}`);
      }

      acc = Buffer.concat([acc, buf]);
      const { frames, remaining } = pullFrames(acc);
      acc = remaining;

      let parsed = false;
      for (const f of frames) {
        const p = parseInventoryFromFrame(f);
        if (p) {
          parsed = true;
          handleTag(p.epc, p.rssiDbm, { mode: p.mode, crcOk: p.crcOk, rssiDbm: p.rssiDbm });
        }
      }
      if (!parsed) {
        const epcLegacy = parseEpcLegacy(buf);
        if (epcLegacy) handleTag(epcLegacy, null, { mode: 'LEGACY' });
      }
    });

    client.on('error', (e) => {
      console.error(`❌ ${zone} TCP error:`, e.message);
    });

    client.on('close', () => {
      console.log(`🔴 ${zone} TCP closed`);
      clearTimers();
      scheduleReconnect('close');
    });
  };

  const shutdown = (sig) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`🛑 ${zone} stopping (${sig})`);
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = null;
    clearTimers();
    if (client && !client.destroyed) client.destroy();
    releaseLock(lockFd, lockFile);
  };

  // Pasang handler shutdown untuk zone ini
  const shutdownHandler = () => shutdown('SIGINT');
  process.once('SIGINT', shutdownHandler);
  process.once('SIGTERM', shutdownHandler);

  connectReader();

  // Kembalikan fungsi shutdown jika ingin dipanggil manual
  return () => shutdown('manual');
}

// ==================== JALANKAN SEMUA LAYANAN ====================
console.log('🚀 Memulai integrated RFID service (Register + IN + OUT)...');

// Jalankan serial reader (REGISTER)
startSerialReader();

// Jalankan TCP IN
startTcpReader('IN', {
  host: IN_HOST,
  port: IN_PORT,
  rssiMin: IN_RSSI_MIN,
  hitWindowMs: IN_HIT_WINDOW,
  minHits: IN_MIN_HITS,
  cooldownMs: IN_COOLDOWN,
  inventoryPoll: IN_INVENTORY_POLL,
  backendPrecheck: IN_BACKEND_PRECHECK,
});

// Jalankan TCP OUT
startTcpReader('OUT', {
  host: OUT_HOST,
  port: OUT_PORT,
  rssiMin: OUT_RSSI_MIN,
  hitWindowMs: OUT_HIT_WINDOW,
  minHits: OUT_MIN_HITS,
  cooldownMs: OUT_COOLDOWN,
  inventoryPoll: OUT_INVENTORY_POLL,
  backendPrecheck: OUT_BACKEND_PRECHECK,
});

// Tangani shutdown global (selain per zone)
let shuttingDown = false;
process.on('SIGINT', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('🛑 Shutting down all services...');
  // Biarkan masing-masing zone membersihkan diri, lalu exit
  setTimeout(() => process.exit(0), 500);
});
process.on('SIGTERM', () => {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log('🛑 Shutting down all services...');
  setTimeout(() => process.exit(0), 500);
});