/**
 * A read-only, bounded reader for the OLE Compound File Binary format
 * ([MS-CFB]) — the container inside `word/embeddings/*.bin`.
 *
 * It exists to *classify* an embedded object, never to use one. It reads the
 * header, the allocation tables and the directory, and can return the bytes
 * of a small named stream. It never interprets stream contents as code, never
 * resolves a class id to a program, and never hands anything to the operating
 * system. Every structural value is checked against the buffer before it is
 * used, every chain walk is bounded and loop-checked, and any inconsistency
 * throws — a malformed container is a rejection, not a best effort.
 */

export class CompoundFileError extends Error {}

const SIGNATURE = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const HEADER_BYTES = 512;
const DIRECTORY_ENTRY_BYTES = 128;
const HEADER_DIFAT_ENTRIES = 109;

// Special sector numbers ([MS-CFB] 2.1).
const MAX_REGULAR_SECTOR = 0xfffffffa;
const DIFAT_SECTOR = 0xfffffffc;
const FAT_SECTOR = 0xfffffffd;
const END_OF_CHAIN = 0xfffffffe;
const FREE_SECTOR = 0xffffffff;

export const EntryType = {
  Unused: 0,
  Storage: 1,
  Stream: 2,
  Root: 5,
} as const;
export type EntryType = (typeof EntryType)[keyof typeof EntryType];

export interface CompoundFileEntry {
  readonly name: string;
  readonly type: EntryType;
  /** Upper-case, braced, registry form: `{0002CE03-0000-0000-C000-000000000046}`. */
  readonly clsid: string;
  readonly size: number;
}

export interface CompoundFileLimits {
  /** Largest directory the reader will walk. Equation objects have a handful. */
  readonly maxDirectoryEntries: number;
  /** Largest stream the reader will return. */
  readonly maxStreamBytes: number;
}

export const DEFAULT_COMPOUND_FILE_LIMITS: CompoundFileLimits = {
  maxDirectoryEntries: 64,
  maxStreamBytes: 256 * 1024,
};

export interface CompoundFile {
  readonly root: CompoundFileEntry;
  /** Every in-use entry other than the root, in directory order. */
  readonly entries: readonly CompoundFileEntry[];
  /** The bytes of a stream by exact name, or null when there is no such stream. */
  readStream(name: string): Buffer | null;
}

function fail(reason: string): never {
  throw new CompoundFileError(reason);
}

function formatClsid(bytes: Buffer): string {
  const hex = (buffer: Buffer) => buffer.toString('hex').toUpperCase();
  const d1 = Buffer.from(bytes.subarray(0, 4)).reverse();
  const d2 = Buffer.from(bytes.subarray(4, 6)).reverse();
  const d3 = Buffer.from(bytes.subarray(6, 8)).reverse();
  return `{${hex(d1)}-${hex(d2)}-${hex(d3)}-${hex(bytes.subarray(8, 10))}-${hex(bytes.subarray(10, 16))}}`;
}

export function parseCompoundFile(
  bytes: Buffer,
  limits: CompoundFileLimits = DEFAULT_COMPOUND_FILE_LIMITS,
): CompoundFile {
  if (bytes.length < HEADER_BYTES) fail('shorter than a header');
  if (!bytes.subarray(0, 8).equals(SIGNATURE)) fail('not a compound file');
  if (bytes.readUInt16LE(28) !== 0xfffe) fail('byte order mark');

  const major = bytes.readUInt16LE(26);
  const sectorShift = bytes.readUInt16LE(30);
  if (!((major === 3 && sectorShift === 9) || (major === 4 && sectorShift === 12))) {
    fail('unsupported version or sector size');
  }
  if (bytes.readUInt16LE(32) !== 6) fail('mini sector size');
  const sectorSize = 1 << sectorShift;
  const miniSectorSize = 64;
  const fatSectorCount = bytes.readUInt32LE(44);
  const firstDirectorySector = bytes.readUInt32LE(48);
  const miniStreamCutoff = bytes.readUInt32LE(56);
  if (miniStreamCutoff !== 4096) fail('mini stream cutoff');
  const firstMiniFatSector = bytes.readUInt32LE(60);
  const miniFatSectorCount = bytes.readUInt32LE(64);
  const firstDifatSector = bytes.readUInt32LE(68);
  const difatSectorCount = bytes.readUInt32LE(72);

  // Sectors that can exist in this buffer. Version 4 pads the header to a
  // full 4096-byte sector; sector N starts at (N + 1) * sectorSize either way.
  const sectorCount = Math.floor((bytes.length - sectorSize) / sectorSize);
  if (sectorCount <= 0) fail('no sectors');
  if (fatSectorCount > sectorCount || miniFatSectorCount > sectorCount) fail('table size');
  if (difatSectorCount > sectorCount) fail('difat size');

  const sector = (index: number): Buffer => {
    if (!Number.isInteger(index) || index < 0 || index >= sectorCount) {
      fail('sector out of range');
    }
    const start = (index + 1) * sectorSize;
    return bytes.subarray(start, start + sectorSize);
  };

  // --- DIFAT → FAT sector list ---------------------------------------------
  const fatSectors: number[] = [];
  for (let i = 0; i < HEADER_DIFAT_ENTRIES && fatSectors.length < fatSectorCount; i += 1) {
    const value = bytes.readUInt32LE(76 + i * 4);
    if (value === FREE_SECTOR) break;
    fatSectors.push(value);
  }
  let difat = firstDifatSector;
  const seenDifat = new Set<number>();
  while (fatSectors.length < fatSectorCount) {
    if (difat === END_OF_CHAIN || difat === FREE_SECTOR) fail('difat chain ends early');
    if (seenDifat.has(difat) || seenDifat.size >= difatSectorCount) fail('difat loop');
    seenDifat.add(difat);
    const block = sector(difat);
    const perSector = sectorSize / 4 - 1;
    for (let i = 0; i < perSector && fatSectors.length < fatSectorCount; i += 1) {
      fatSectors.push(block.readUInt32LE(i * 4));
    }
    difat = block.readUInt32LE(perSector * 4);
  }
  if (fatSectors.length !== fatSectorCount) fail('fat sector count');

  const fat: number[] = [];
  for (const index of fatSectors) {
    if (index > MAX_REGULAR_SECTOR) fail('fat sector id');
    const block = sector(index);
    for (let i = 0; i < sectorSize / 4; i += 1) fat.push(block.readUInt32LE(i * 4));
  }

  /** A chain of sector ids, loop-checked and bounded by what the file holds. */
  const chain = (start: number, table: readonly number[], bound: number): number[] => {
    const result: number[] = [];
    const seen = new Set<number>();
    let current = start;
    while (current !== END_OF_CHAIN) {
      if (current > MAX_REGULAR_SECTOR || current >= table.length) fail('chain out of range');
      if (seen.has(current)) fail('chain loop');
      if (result.length >= bound) fail('chain too long');
      seen.add(current);
      result.push(current);
      const next = table[current]!;
      if (next === FREE_SECTOR || next === FAT_SECTOR || next === DIFAT_SECTOR) {
        fail('chain enters an unallocated sector');
      }
      current = next;
    }
    return result;
  };

  // --- directory -------------------------------------------------------------
  const directorySectors = chain(firstDirectorySector, fat, sectorCount);
  if (directorySectors.length === 0) fail('empty directory');
  const directory = Buffer.concat(directorySectors.map(sector));
  const slots = directory.length / DIRECTORY_ENTRY_BYTES;
  if (slots > limits.maxDirectoryEntries * 4 + 4) fail('directory too large');

  interface RawEntry extends CompoundFileEntry {
    readonly start: number;
  }
  const raw: RawEntry[] = [];
  for (let slot = 0; slot < slots; slot += 1) {
    const entry = directory.subarray(
      slot * DIRECTORY_ENTRY_BYTES,
      (slot + 1) * DIRECTORY_ENTRY_BYTES,
    );
    const type = entry.readUInt8(66) as EntryType;
    if (type === EntryType.Unused) continue;
    if (type !== EntryType.Storage && type !== EntryType.Stream && type !== EntryType.Root) {
      fail('directory entry type');
    }
    const nameLength = entry.readUInt16LE(64);
    if (nameLength < 2 || nameLength > 64 || nameLength % 2 !== 0) fail('directory name length');
    const name = entry.subarray(0, nameLength - 2).toString('utf16le');
    // Version 3 keeps only the low 32 bits of a size; the high half must be 0.
    const sizeHigh = entry.readUInt32LE(124);
    if (major === 3 && sizeHigh !== 0) fail('stream size');
    if (sizeHigh !== 0) fail('stream too large');
    const size = entry.readUInt32LE(120);
    raw.push({
      name,
      type,
      clsid: formatClsid(entry.subarray(80, 96)),
      size,
      start: entry.readUInt32LE(116),
    });
    if (raw.length > limits.maxDirectoryEntries) fail('too many directory entries');
  }
  const root = raw[0];
  if (root === undefined || root.type !== EntryType.Root) fail('first entry is not the root');
  if (raw.slice(1).some((entry) => entry.type === EntryType.Root)) fail('second root');

  // --- mini stream -------------------------------------------------------------
  const miniFat: number[] = [];
  if (miniFatSectorCount > 0) {
    for (const index of chain(firstMiniFatSector, fat, miniFatSectorCount)) {
      const block = sector(index);
      for (let i = 0; i < sectorSize / 4; i += 1) miniFat.push(block.readUInt32LE(i * 4));
    }
  }
  let miniStream: Buffer | null = null;
  const loadMiniStream = (): Buffer => {
    if (miniStream !== null) return miniStream;
    if (root.size === 0) return (miniStream = Buffer.alloc(0));
    const sectors = chain(root.start, fat, sectorCount);
    const data = Buffer.concat(sectors.map(sector));
    if (data.length < root.size) fail('mini stream shorter than declared');
    return (miniStream = data.subarray(0, root.size));
  };

  const readEntry = (entry: RawEntry): Buffer => {
    if (entry.size > limits.maxStreamBytes) fail('stream exceeds the inspection limit');
    if (entry.size === 0) return Buffer.alloc(0);
    if (entry.size < miniStreamCutoff) {
      const mini = loadMiniStream();
      const count = Math.ceil(entry.size / miniSectorSize);
      const sectors = chain(entry.start, miniFat, count);
      if (sectors.length !== count) fail('mini chain length');
      const parts = sectors.map((index) => {
        const start = index * miniSectorSize;
        if (start >= mini.length) fail('mini sector range');
        return mini.subarray(start, start + miniSectorSize);
      });
      const data = Buffer.concat(parts);
      if (data.length < entry.size) fail('stream shorter than declared');
      return data.subarray(0, entry.size);
    }
    const count = Math.ceil(entry.size / sectorSize);
    const sectors = chain(entry.start, fat, count);
    if (sectors.length !== count) fail('chain length');
    return Buffer.concat(sectors.map(sector)).subarray(0, entry.size);
  };

  const entries = raw.slice(1);
  return {
    root: { name: root.name, type: root.type, clsid: root.clsid, size: root.size },
    entries: entries.map(({ name, type, clsid, size }) => ({ name, type, clsid, size })),
    readStream(name: string): Buffer | null {
      const entry = entries.find(
        (candidate) => candidate.type === EntryType.Stream && candidate.name === name,
      );
      return entry === undefined ? null : readEntry(entry);
    },
  };
}
