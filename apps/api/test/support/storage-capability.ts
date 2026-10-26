/**
 * What the S3 implementation under test actually enforces.
 *
 * PalCert defends an upload twice, and the two layers are independent:
 *
 *  1. **The storage service** enforces what the presigned URL signed — the
 *     content length, the client checksum, the expiry. A PUT that contradicts
 *     its own authorization is refused at the edge and the bytes never land.
 *  2. **PalCert's ingestion** re-derives the size and the SHA-256 from the
 *     bytes that did land and refuses anything that disagrees with what was
 *     declared, because "the storage checked it" is not a security property
 *     PalCert controls.
 *
 * Real S3 and MinIO do (1). The in-process emulator used for fast local runs
 * does not: it accepts the contradictory PUT, which is what makes layer (2)
 * reachable from a test at all.
 *
 * So a test that deliberately uploads bytes contradicting their authorization
 * has two correct outcomes, and must assert whichever one it got rather than
 * assume an emulator. Refusal at the edge is the stronger of the two — the
 * bad bytes never reached the platform — and is never treated as a skip.
 */
const ENFORCES = process.env['STORAGE_ENFORCES_SIGNATURES'] !== 'false';

export function storageEnforcesSignatures(): boolean {
  return ENFORCES;
}
