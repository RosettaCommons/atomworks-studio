/**
 * A store-only (uncompressed) zip writer, enough for "Save all (.zip)": structure files are text that browsers and
 * unzip tools open anyway, and it needs no library. Entries get CRC-32, UTF-8 names and a DOS timestamp; archives stay
 * under 4 GB and 65535 entries (no zip64).
 */

export type ZipEntry = { name: string; data: Uint8Array | string; date?: Date };

let crcTable: Uint32Array | null = null;

/** CRC-32 (the zip/PNG polynomial) of `bytes`. */
export function crc32(bytes: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) crc = crcTable[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/** The zip file holding `files`, in order, uncompressed. Names may contain "/" for folders. */
export function zipStore(files: ZipEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const entries = files.map((file) => {
    const name = encoder.encode(file.name);
    const data = typeof file.data === "string" ? encoder.encode(file.data) : file.data;
    return { name, data, crc: crc32(data), ...dosDateTime(file.date ?? new Date()) };
  });
  if (entries.length > 0xffff) throw new Error("too many files for a zip (65535 at most)");
  let size = 22;
  for (const e of entries) size += 30 + e.name.length + e.data.length + 46 + e.name.length;
  if (size > 0xffffffff) throw new Error("zip larger than 4 GB");
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  const FLAG_UTF8 = 0x0800;
  for (const e of entries) {
    offsets.push(at);
    view.setUint32(at, 0x04034b50, true);
    view.setUint16(at + 4, 20, true); // version needed
    view.setUint16(at + 6, FLAG_UTF8, true);
    view.setUint16(at + 8, 0, true); // stored
    view.setUint16(at + 10, e.time, true);
    view.setUint16(at + 12, e.day, true);
    view.setUint32(at + 14, e.crc, true);
    view.setUint32(at + 18, e.data.length, true);
    view.setUint32(at + 22, e.data.length, true);
    view.setUint16(at + 26, e.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(e.name, at + 30);
    out.set(e.data, at + 30 + e.name.length);
    at += 30 + e.name.length + e.data.length;
  }
  const centralStart = at;
  entries.forEach((e, k) => {
    view.setUint32(at, 0x02014b50, true);
    view.setUint16(at + 4, 20, true); // version made by
    view.setUint16(at + 6, 20, true); // version needed
    view.setUint16(at + 8, FLAG_UTF8, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, e.time, true);
    view.setUint16(at + 14, e.day, true);
    view.setUint32(at + 16, e.crc, true);
    view.setUint32(at + 20, e.data.length, true);
    view.setUint32(at + 24, e.data.length, true);
    view.setUint16(at + 28, e.name.length, true);
    // extra, comment, disk, internal and external attributes: zero
    view.setUint32(at + 42, offsets[k], true);
    out.set(e.name, at + 46);
    at += 46 + e.name.length;
  });
  view.setUint32(at, 0x06054b50, true);
  view.setUint16(at + 8, entries.length, true);
  view.setUint16(at + 10, entries.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  return out;
}
