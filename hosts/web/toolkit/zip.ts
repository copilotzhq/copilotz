/**
 * A zip archive of files as they are (stored, not compressed), with each
 * file's CRC-32: what an Office Open XML file (`.xlsx`) is. No dependency,
 * in the browser or on a server.
 *
 * ```ts
 * const bytes = zip([{ name: "hello.txt", content: "Hello" }]);
 * ```
 */

const TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** The CRC-32 of some bytes (zip's and PNG's: `crc32("123456789")` is `0xcbf43926`). */
export function crc32(bytes: Uint8Array | string): number {
  const data = typeof bytes === "string" ? new TextEncoder().encode(bytes) : bytes;
  let crc = 0xffffffff;
  for (const byte of data) crc = TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A file in the archive: its path (`xl/workbook.xml`) and what it holds (text as UTF-8). */
export type ZipEntry = { name: string; content: Uint8Array | string };

/** An archive of `entries`, stored, dated `at` (1 January 1980 by default, zip's first day). */
export function zip(entries: ZipEntry[], at = new Date(1980, 0, 1)): Uint8Array {
  const encode = (text: string) => new TextEncoder().encode(text);
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1);
  const date = ((Math.max(at.getFullYear(), 1980) - 1980) << 9) | ((at.getMonth() + 1) << 5) |
    at.getDate();
  const files = entries.map((entry) => {
    const data = typeof entry.content === "string" ? encode(entry.content) : entry.content;
    return { name: encode(entry.name), data, crc: crc32(data) };
  });
  const size = files.reduce((sum, f) => sum + 30 + f.name.length + f.data.length, 0) +
    files.reduce((sum, f) => sum + 46 + f.name.length, 0) + 22;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let pos = 0;
  const u16 = (value: number) => {
    view.setUint16(pos, value, true);
    pos += 2;
  };
  const u32 = (value: number) => {
    view.setUint32(pos, value >>> 0, true);
    pos += 4;
  };
  const bytes = (data: Uint8Array) => {
    out.set(data, pos);
    pos += data.length;
  };
  // Version 2.0; bit 11: names are UTF-8; method 0: stored.
  const header = (f: (typeof files)[number]) => {
    for (const value of [20, 0x0800, 0, time, date]) u16(value);
    for (const value of [f.crc, f.data.length, f.data.length]) u32(value);
    u16(f.name.length);
    u16(0);
  };
  const offsets: number[] = [];
  for (const f of files) {
    offsets.push(pos);
    u32(0x04034b50);
    header(f);
    bytes(f.name);
    bytes(f.data);
  }
  const directory = pos;
  files.forEach((f, i) => {
    u32(0x02014b50);
    u16(20);
    header(f);
    for (const value of [0, 0, 0]) u16(value); // comment, disk, internal attributes
    u32(0); // external attributes
    u32(offsets[i]);
    bytes(f.name);
  });
  const directorySize = pos - directory;
  u32(0x06054b50);
  for (const value of [0, 0, files.length, files.length]) u16(value);
  u32(directorySize);
  u32(directory);
  u16(0);
  return out;
}
