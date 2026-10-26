import { createHash } from 'node:crypto';
import { encodeVerificationQr } from './verification-qr';

// QR rendering is CPU-bound and slower on the repository's self-hosted WSL runner.
// Keep the relaxed timeout scoped to this file so unrelated tests retain Jest's strict default.
jest.setTimeout(15_000);

/**
 * The QR encoder on its own, with no PDF anywhere near it.
 *
 * Rendering a certificate to check a property of the QR is both slow and
 * indirect: the answer arrives compressed inside a PDF, so the assertion ends
 * up being about document bytes rather than about the code. These tests ask
 * the encoder directly.
 */
describe('The certificate verification QR', () => {
  const url = 'https://palcert.example/verify/PC-0123456789ABCDEFGHJKMNPQRSTVWX';

  const digest = async (value: string): Promise<string> =>
    createHash('sha256')
      .update(await encodeVerificationQr(value))
      .digest('hex');

  it('encodes the same URL to the same bytes', async () => {
    // §48, §162: the artifact hash is published to verifiers, so every input
    // to it has to be deterministic. A default that changed with a library
    // version, or a timestamp in the PNG, would break that here first.
    expect(await digest(url)).toBe(await digest(url));
  });

  it('encodes a different URL to different bytes', async () => {
    // The other half: the code really is a function of the URL, so a test
    // that passes the wrong URL cannot pass by accident.
    expect(await digest(url)).not.toBe(await digest(`${url}X`));
    expect(await digest(url)).not.toBe(
      await digest('https://palcert.example/verify/PC-ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ'),
    );
  });

  it('produces a PNG, which is what the renderer embeds', async () => {
    const bytes = await encodeVerificationQr(url);
    expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('takes a URL and nothing else', async () => {
    // The signature is the privacy guarantee: there is no second parameter to
    // smuggle a claim, a code or a tracking id into, and the deterministic
    // options are the encoder's own rather than a caller's to choose.
    expect(encodeVerificationQr).toHaveLength(1);
  });
});
