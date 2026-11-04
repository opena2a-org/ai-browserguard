/**
 * Writes dist.zip so that the same files at the same commit give the same
 * bytes on every machine.
 *
 * - The entries are the regular files content-digest.mjs lists, in bytewise
 *   order of their paths, with no directory entries. A symbolic link under
 *   the directory is refused, never followed.
 * - Every entry carries one time, the source date (sourceDate below:
 *   SOURCE_DATE_EPOCH when it is set, else the commit time of HEAD), written
 *   as UTC at the two-second precision of the zip format.
 * - Entries are stored without compression. Deflate output depends on the
 *   zlib build: the same file deflates to different bytes under the zlib
 *   bundled with Node and under a system zlib. Stored entries keep the
 *   archive a function of the paths, the file contents and the source date.
 * - No extra fields, no comments and no data descriptors. Every entry gets
 *   the same "made by" value and file mode (0644), whatever the mode of the
 *   file it was read from.
 */
import { spawnSync } from 'child_process';
import { createHash } from 'crypto';
import { readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'fs';
import { listFiles } from './content-digest.mjs';

const LOCAL_HEADER = 0x04034b50;
const CENTRAL_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const VERSION_MADE_BY = (3 << 8) | 20; // made on Unix, zip specification 2.0
const VERSION_NEEDED = 10; // 1.0 is enough to extract a stored entry
const STORED = 0;
const UTF8_NAME = 0x0800;
const FILE_MODE = 0o100644; // regular file, rw-r--r--
const MAX_U16 = 0xffff;
const MAX_U32 = 0xffffffff;

const DOS_EARLIEST = Date.UTC(1980, 0, 1, 0, 0, 0);
const DOS_LATEST = Date.UTC(2107, 11, 31, 23, 59, 58);

/** The earliest time a zip entry can carry: 1980-01-01T00:00:00Z. */
export const EARLIEST_ZIP_DATE = new Date(DOS_EARLIEST);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (the zip and gzip polynomial) of data. */
export function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * The MS-DOS time and date fields for date, read in UTC so the machine's
 * time zone never changes them. Dates outside 1980 to 2107 are clamped.
 */
export function dosDateTime(date) {
  const ms = date instanceof Date ? date.getTime() : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error('the zip entry time is not a valid date');
  const d = new Date(Math.min(Math.max(ms, DOS_EARLIEST), DOS_LATEST));
  return {
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | Math.floor(d.getUTCSeconds() / 2),
    date: ((d.getUTCFullYear() - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
  };
}

function checkEntryPath(path) {
  const segments = path.split('/');
  if (
    path.length === 0 ||
    path.includes('\\') ||
    /[\u0000-\u001f]/.test(path) ||
    segments.some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    throw new Error(`${JSON.stringify(path)} is not a relative path that a zip entry can hold`);
  }
}

/**
 * The bytes of a zip archive holding entries ({ path, data }), stored, in
 * bytewise order of path, every entry carrying the time date. Throws on an
 * unusable path, a repeated path, or an archive that would need ZIP64.
 */
export function zipFiles(entries, date) {
  const { time, date: day } = dosDateTime(date);
  const sorted = entries
    .map(({ path, data }) => ({ path, name: Buffer.from(path, 'utf8'), data }))
    .sort((a, b) => Buffer.compare(a.name, b.name));
  if (sorted.length > MAX_U16) throw new Error(`${sorted.length} files is more than a zip without ZIP64 can hold`);

  const parts = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < sorted.length; i++) {
    const { path, name, data } = sorted[i];
    checkEntryPath(path);
    if (i > 0 && Buffer.compare(sorted[i - 1].name, name) === 0) throw new Error(`${path} is listed twice`);
    if (name.length > MAX_U16) throw new Error(`${path}: the path is too long for a zip entry`);
    if (!(data instanceof Uint8Array)) throw new Error(`${path}: the entry data is not a byte array`);
    if (data.length > MAX_U32) throw new Error(`${path} is too large for a zip without ZIP64`);

    const flags = /^[\x20-\x7e]*$/.test(path) ? 0 : UTF8_NAME;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOCAL_HEADER, 0);
    local.writeUInt16LE(VERSION_NEEDED, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(STORED, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18); // compressed size
    local.writeUInt32LE(data.length, 22); // uncompressed size
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field

    const header = Buffer.alloc(46);
    header.writeUInt32LE(CENTRAL_HEADER, 0);
    header.writeUInt16LE(VERSION_MADE_BY, 4);
    header.writeUInt16LE(VERSION_NEEDED, 6);
    header.writeUInt16LE(flags, 8);
    header.writeUInt16LE(STORED, 10);
    header.writeUInt16LE(time, 12);
    header.writeUInt16LE(day, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(data.length, 20);
    header.writeUInt32LE(data.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // no extra field
    header.writeUInt16LE(0, 32); // no comment
    header.writeUInt16LE(0, 34); // disk number
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE((FILE_MODE << 16) >>> 0, 38); // external attributes
    header.writeUInt32LE(offset, 42); // where the local header starts

    parts.push(local, name, data);
    central.push(header, name);
    offset += local.length + name.length + data.length;
    if (offset > MAX_U32) throw new Error('the files are too large for a zip without ZIP64');
  }

  const centralSize = central.reduce((total, part) => total + part.length, 0);
  if (offset + centralSize > MAX_U32) throw new Error('the files are too large for a zip without ZIP64');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(END_OF_CENTRAL_DIRECTORY, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // disk where the central directory starts
  end.writeUInt16LE(sorted.length, 8);
  end.writeUInt16LE(sorted.length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment
  return Buffer.concat([...parts, ...central, end]);
}

function git(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? result.stdout.trim() : null;
}

function samePath(a, b) {
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
}

/**
 * The time every entry of the package carries, and where it came from:
 * SOURCE_DATE_EPOCH when it is set (it must be a whole number of seconds),
 * else the commit time of HEAD when root is the top of a git checkout,
 * else EARLIEST_ZIP_DATE with source 'none'.
 */
export function sourceDate(root, env = process.env) {
  const epoch = env.SOURCE_DATE_EPOCH;
  if (epoch !== undefined && epoch !== '') {
    if (!/^\d+$/.test(epoch)) {
      throw new Error(`SOURCE_DATE_EPOCH must be a whole number of seconds since 1970, not ${JSON.stringify(epoch)}`);
    }
    return { date: new Date(Number(epoch) * 1000), source: 'SOURCE_DATE_EPOCH' };
  }
  const top = git(root, ['rev-parse', '--show-toplevel']);
  if (top !== null && samePath(top, root)) {
    const seconds = git(root, ['log', '-1', '--no-show-signature', '--format=%ct', 'HEAD']);
    if (seconds !== null && /^\d+$/.test(seconds)) {
      return { date: new Date(Number(seconds) * 1000), source: 'commit' };
    }
  }
  return { date: new Date(DOS_EARLIEST), source: 'none' };
}

/**
 * Packs the regular files under dir into outFile, every entry carrying the
 * time date. The archive is written next to outFile and renamed into place,
 * so a failure never leaves a partial outFile behind. Returns the number of
 * files, the archive size in bytes and its sha256.
 */
export function packDirectory(dir, outFile, date) {
  const files = listFiles(dir);
  const zip = zipFiles(files.map(({ path, file }) => ({ path, data: readFileSync(file) })), date);
  const partial = `${outFile}.partial`;
  rmSync(partial, { force: true });
  try {
    writeFileSync(partial, zip, { flag: 'wx' });
    renameSync(partial, outFile);
  } finally {
    rmSync(partial, { force: true });
  }
  return { files: files.length, bytes: zip.length, sha256: createHash('sha256').update(zip).digest('hex') };
}
