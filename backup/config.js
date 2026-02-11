export default {
  SERIAL_PORT: '/dev/cu.usbserial-1110', // GANTI sesuai hasil ls
  BAUD_RATE: 57600,

  // kirim query setiap X ms
  QUERY_INTERVAL_MS: 200,

  // anti double tap (ms)
  TAP_COOLDOWN_MS: 3000,

  // DEBUG
  LOG_RAW_HEX: false,
};
