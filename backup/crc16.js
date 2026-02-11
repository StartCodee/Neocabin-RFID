export function crc16(buffer) {
  let crc = 0xFFFF;

  for (let b of buffer) {
    crc ^= b;
    for (let i = 0; i < 8; i++) {
      if (crc & 0x0001) {
        crc = (crc >> 1) ^ 0x8408;
      } else {
        crc >>= 1;
      }
    }
  }

  return crc & 0xFFFF;
}
