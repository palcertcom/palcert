/**
 * The SmartFix request frame (Phase 12).
 *
 * The analyzer's boundary puts the document in the raw body and its two
 * identifiers in headers, which works because those identifiers are short.
 * SmartFix cannot: a plan is a JSON document with up to a hundred thousand
 * actions in it, and a change manifest is the same size again.
 *
 * `multipart/form-data` would mean a parser dependency and a second way for
 * PalCert's own bytes to be misframed. Base64 inside a JSON envelope would
 * inflate a 200 MB thesis by a third and force the whole document through a
 * string. So the body is framed explicitly: eight bytes of big-endian length,
 * that many bytes of UTF-8 JSON, and the document immediately after. Nothing
 * to sniff, and no boundary token that could occur inside the payload.
 *
 * This is the mirror of `app/smartfix/framing.py`; the cross-language tests in
 * the Phase 12 e2e suite run a real frame through both.
 */

const HEADER_BYTES = 8;
/** A JSON header larger than this is not a plan; it is a bug or an attack. */
const MAX_JSON_BYTES = 64 * 1024 * 1024;

export class SmartFixFramingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SmartFixFramingError';
  }
}

export function encodeFrame(payload: unknown, document: Buffer): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeBigUInt64BE(BigInt(json.byteLength));
  return Buffer.concat([header, json, document]);
}

export function decodeFrame(data: Buffer): { payload: Record<string, unknown>; document: Buffer } {
  if (data.byteLength < HEADER_BYTES) {
    throw new SmartFixFramingError('the body is shorter than its length prefix');
  }
  const declared = data.readBigUInt64BE(0);
  if (declared > BigInt(MAX_JSON_BYTES)) {
    throw new SmartFixFramingError('the JSON header exceeds the permitted size');
  }
  const length = Number(declared);
  const end = HEADER_BYTES + length;
  if (data.byteLength < end) {
    throw new SmartFixFramingError('the body is shorter than its JSON header claims');
  }

  let payload: unknown;
  try {
    payload = JSON.parse(data.subarray(HEADER_BYTES, end).toString('utf8'));
  } catch {
    throw new SmartFixFramingError('the JSON header is not valid JSON');
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new SmartFixFramingError('the JSON header is not an object');
  }
  return { payload: payload as Record<string, unknown>, document: data.subarray(end) };
}
