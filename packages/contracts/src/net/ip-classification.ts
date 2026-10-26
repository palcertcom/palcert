import { IANA_SPECIAL_IPV4, IANA_SPECIAL_IPV6 } from './iana-special-registry.generated.js';

/**
 * Is this address one PalCert will open a webhook connection to?
 *
 * The policy is a single sentence: an address inside any entry of the IANA
 * special-purpose or multicast registries is refused, with zero exceptions in
 * Phase 17. The ranges themselves are generated from committed snapshots
 * (see `security/iana/`), so adding or removing one is a reviewable diff
 * rather than an edit to a condition somebody wrote from memory.
 *
 * Everything here works on parsed bytes rather than on text. That matters: an
 * attacker's leverage is in the spelling — `0x7f.1`, `2130706433`,
 * `::ffff:10.0.0.1`, `2002:0a00:0001::` — and none of those survive being
 * turned into the sixteen bytes they actually mean.
 */

/** Sixteen bytes. IPv4 is held in its IPv4-mapped form so one path covers both. */
type Bytes = Uint8Array;

interface ParsedRange {
  readonly bytes: Bytes;
  readonly prefixBits: number;
  readonly label: string;
  /** True when the range was written as IPv4, so it also matches mapped forms. */
  readonly v4: boolean;
}

function ipv4ToBytes(text: string): Bytes | null {
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  const out = new Uint8Array(16);
  // ::ffff:0:0/96 prefix, so a v4 address and its mapped form are one value.
  out[10] = 0xff;
  out[11] = 0xff;
  for (let i = 0; i < 4; i += 1) {
    const part = parts[i] ?? '';
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out[12 + i] = value;
  }
  return out;
}

function ipv6ToBytes(text: string): Bytes | null {
  let input = text;
  let tail: Bytes | null = null;

  // A trailing dotted quad, as in ::ffff:192.0.2.1 or 64:ff9b::198.51.100.7.
  const lastColon = input.lastIndexOf(':');
  const suffix = input.slice(lastColon + 1);
  if (suffix.includes('.')) {
    const embedded = ipv4ToBytes(suffix);
    if (embedded === null) return null;
    tail = embedded.slice(12);
    input = `${input.slice(0, lastColon + 1)}0:0`;
  }

  const halves = input.split('::');
  if (halves.length > 2) return null;

  const head = halves[0] === '' ? [] : (halves[0] ?? '').split(':');
  const rest = halves.length === 2 ? (halves[1] === '' ? [] : (halves[1] ?? '').split(':')) : null;

  const groups: number[] = [];
  const pushGroup = (group: string): boolean => {
    if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return false;
    groups.push(Number.parseInt(group, 16));
    return true;
  };

  for (const group of head) if (!pushGroup(group)) return null;

  if (rest === null) {
    if (groups.length !== 8) return null;
  } else {
    const tailGroups: number[] = [];
    for (const group of rest) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(group)) return null;
      tailGroups.push(Number.parseInt(group, 16));
    }
    const missing = 8 - groups.length - tailGroups.length;
    if (missing < 0) return null;
    for (let i = 0; i < missing; i += 1) groups.push(0);
    groups.push(...tailGroups);
  }
  if (groups.length !== 8) return null;

  const out = new Uint8Array(16);
  for (let i = 0; i < 8; i += 1) {
    const group = groups[i] ?? 0;
    out[i * 2] = (group >> 8) & 0xff;
    out[i * 2 + 1] = group & 0xff;
  }
  if (tail !== null) out.set(tail, 12);
  return out;
}

/**
 * A parsed address, and — crucially — which notation it was written in.
 *
 * The family is not cosmetic. IPv4 is stored in its mapped form so one set of
 * byte comparisons covers both, but `::ffff:0:0/96` is itself an entry in the
 * IPv6 special registry. Without the family, every ordinary IPv4 address would
 * match that entry and the classifier would refuse the whole internet.
 */
export interface ParsedAddress {
  readonly bytes: Bytes;
  readonly family: 4 | 6;
}

/**
 * Parse an address into sixteen bytes and its notation.
 *
 * Deliberately strict: only the forms `dns.resolve4`/`dns.resolve6` actually
 * produce. Lenient parsing is where alternate spellings get their power, and
 * nothing here needs to accept `0x7f.1` — a URL containing one is refused as
 * an IP literal long before classification.
 */
export function parseAddress(text: string): ParsedAddress | null {
  const trimmed = text.trim().replace(/^\[|\]$/g, '');
  // A scoped link-local such as fe80::1%eth0 is still fe80::1.
  const scoped = trimmed.split('%')[0] ?? trimmed;
  if (scoped.includes(':')) {
    const bytes = ipv6ToBytes(scoped);
    return bytes === null ? null : { bytes, family: 6 };
  }
  const bytes = ipv4ToBytes(scoped);
  return bytes === null ? null : { bytes, family: 4 };
}

/** The bytes alone, for callers that do not care how it was spelled. */
export function parseIpAddress(text: string): Bytes | null {
  return parseAddress(text)?.bytes ?? null;
}

function parseRange(cidr: string, label: string): ParsedRange {
  const [address, bits] = cidr.split('/');
  const bytes = parseIpAddress(address ?? '');
  if (bytes === null) throw new Error(`unparseable IANA range ${cidr}`);
  const declared = Number(bits);
  const v4 = !(address ?? '').includes(':');
  // An IPv4 range is stored mapped, so its prefix shifts by the 96-bit prefix.
  return { bytes, prefixBits: v4 ? declared + 96 : declared, label, v4 };
}

const RANGES: readonly ParsedRange[] = [
  ...IANA_SPECIAL_IPV4.map((entry) => parseRange(entry.cidr, entry.label)),
  ...IANA_SPECIAL_IPV6.map((entry) => parseRange(entry.cidr, entry.label)),
];

function withinPrefix(address: Bytes, range: ParsedRange): boolean {
  const fullBytes = Math.floor(range.prefixBits / 8);
  const remainderBits = range.prefixBits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (address[i] !== range.bytes[i]) return false;
  }
  if (remainderBits === 0) return true;
  const mask = (0xff << (8 - remainderBits)) & 0xff;
  return ((address[fullBytes] ?? 0) & mask) === ((range.bytes[fullBytes] ?? 0) & mask);
}

const MAPPED_PREFIX = new Uint8Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xff, 0xff]);

function isMapped(address: Bytes): boolean {
  for (let i = 0; i < 12; i += 1) if (address[i] !== MAPPED_PREFIX[i]) return false;
  return true;
}

/** True when every one of the first twelve bytes is zero: ::a.b.c.d and friends. */
function isCompatible(address: Bytes): boolean {
  for (let i = 0; i < 12; i += 1) if (address[i] !== 0) return false;
  return true;
}

export interface DestinationVerdict {
  readonly allowed: boolean;
  /** The registry entry that refused it, for a safe normalized log line. */
  readonly reason?: string;
}

/**
 * Classify one resolved address.
 *
 * Embedded IPv4 is unwrapped and classified again, so a public-looking IPv6
 * wrapper around a private IPv4 address is refused on the inner address:
 * `::ffff:10.0.0.1`, `::10.0.0.1`, `64:ff9b::10.0.0.1` and the 6to4 form
 * `2002:0a00:0001::` all name 10.0.0.1 in the end.
 */
export function classifyDestination(text: string): DestinationVerdict {
  const parsed = parseAddress(text);
  if (parsed === null) return { allowed: false, reason: 'UNPARSEABLE_ADDRESS' };

  const { bytes, family } = parsed;

  for (const range of RANGES) {
    // An IPv4 address is compared only against IPv4 ranges, and an IPv6
    // address only against IPv6 ones. Mixing them would make `::ffff:0:0/96`
    // — a legitimate IPv6 registry entry — refuse every IPv4 address, since
    // that is the form IPv4 is stored in here.
    if (range.v4 !== (family === 4)) continue;
    if (withinPrefix(bytes, range)) return { allowed: false, reason: range.label };
  }

  // A public-looking IPv6 wrapper around a private IPv4 address is refused on
  // the address it actually names.
  for (const embedded of embeddedIpv4Forms(bytes, family)) {
    const verdict = classifyDestination(embedded);
    if (!verdict.allowed) return { allowed: false, reason: `EMBEDDED_${verdict.reason ?? 'IPV4'}` };
  }

  return { allowed: true };
}

/** Any IPv4 address this IPv6 address carries inside it, in dotted form. */
function embeddedIpv4Forms(address: Bytes, family: 4 | 6): string[] {
  const dotted = (a: number, b: number, c: number, d: number): string => `${a}.${b}.${c}.${d}`;
  const at = (i: number): number => address[i] ?? 0;
  const forms: string[] = [];

  // An IPv4 address carries nothing inside it.
  if (family === 4) return forms;

  // Mapped and compatible forms are already refused by the registry entries
  // for `::ffff:0:0/96` and `::/96`, and re-entering here would not terminate.
  if (isMapped(address) || isCompatible(address)) return forms;

  // 6to4: 2002:AABB:CCDD::/48 carries AA.BB.CC.DD.
  if (at(0) === 0x20 && at(1) === 0x02) forms.push(dotted(at(2), at(3), at(4), at(5)));

  // NAT64 well-known 64:ff9b::/96 carries the IPv4 in the last four bytes.
  if (at(0) === 0x00 && at(1) === 0x64 && at(2) === 0xff && at(3) === 0x9b) {
    forms.push(dotted(at(12), at(13), at(14), at(15)));
  }

  return forms;
}
