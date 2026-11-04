/**
 * A zip reader for tests, written apart from scripts/deterministic-zip.mjs so
 * that an archive is checked by code that did not write it.
 *
 * It reads the end of central directory record (the archive must carry no
 * archive comment, so the record is the last 22 bytes), then each central
 * directory header and the local header it points at, and returns their
 * fields as the zip specification lays them out. A deflated entry is
 * inflated, so an archive written by the zip tool reads back too.
 */
import { inflateRawSync } from 'zlib';

export interface LocalHeader {
  needed: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  extraLength: number;
}

export interface ZipEntry {
  name: string;
  madeBy: number;
  needed: number;
  flags: number;
  method: number;
  time: number;
  date: number;
  crc: number;
  compressedSize: number;
  size: number;
  extraLength: number;
  commentLength: number;
  internal: number;
  external: number;
  local: LocalHeader;
  /** The entry's bytes as stored in the archive. */
  stored: Buffer;
  /** The entry's file content: stored bytes, inflated when deflated. */
  data: Buffer;
}

export interface ZipArchive {
  entries: ZipEntry[];
  commentLength: number;
  /** Where the end record ends: the archive's length when nothing follows it. */
  endsAt: number;
}

export function readZip(bytes: Uint8Array): ZipArchive {
  const zip = Buffer.from(bytes);
  const end = zip.length - 22;
  if (end < 0 || zip.readUInt32LE(end) !== 0x06054b50) throw new Error('no end of central directory record in the last 22 bytes');
  const count = zip.readUInt16LE(end + 10);
  const centralSize = zip.readUInt32LE(end + 12);
  const centralAt = zip.readUInt32LE(end + 16);
  const entries: ZipEntry[] = [];
  let at = centralAt;
  for (let i = 0; i < count; i++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`no central directory header at ${at}`);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    if (zip.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`no local header at ${localAt}`);
    const localExtraLength = zip.readUInt16LE(localAt + 28);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + localExtraLength;
    const stored = zip.subarray(dataAt, dataAt + compressedSize);
    if (method !== 0 && method !== 8) throw new Error(`entry ${i} uses compression method ${method}`);
    entries.push({
      name: zip.subarray(at + 46, at + 46 + nameLength).toString('utf8'),
      madeBy: zip.readUInt16LE(at + 4),
      needed: zip.readUInt16LE(at + 6),
      flags: zip.readUInt16LE(at + 8),
      method,
      time: zip.readUInt16LE(at + 12),
      date: zip.readUInt16LE(at + 14),
      crc: zip.readUInt32LE(at + 16),
      compressedSize,
      size: zip.readUInt32LE(at + 24),
      extraLength,
      commentLength,
      internal: zip.readUInt16LE(at + 36),
      external: zip.readUInt32LE(at + 38),
      local: {
        needed: zip.readUInt16LE(localAt + 4),
        flags: zip.readUInt16LE(localAt + 6),
        method: zip.readUInt16LE(localAt + 8),
        time: zip.readUInt16LE(localAt + 10),
        date: zip.readUInt16LE(localAt + 12),
        crc: zip.readUInt32LE(localAt + 14),
        extraLength: localExtraLength,
      },
      stored: Buffer.from(stored),
      data: method === 8 ? inflateRawSync(stored) : Buffer.from(stored),
    });
    at += 46 + nameLength + extraLength + commentLength;
  }
  if (at !== centralAt + centralSize) throw new Error('the central directory size does not match its entries');
  return { entries, commentLength: zip.readUInt16LE(end + 20), endsAt: end + 22 };
}
