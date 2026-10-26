import { cleanObjectKey, isPalCertObjectKey, quarantineObjectKey } from './storage-keys';

const OWNER = '11111111-1111-4111-8111-111111111111';
const DOCUMENT = '22222222-2222-4222-8222-222222222222';
const VERSION = '33333333-3333-4333-8333-333333333333';

describe('storage keys', () => {
  it('builds opaque keys from identifiers only', () => {
    const key = cleanObjectKey({ ownerUserId: OWNER, documentId: DOCUMENT, versionId: VERSION });
    expect(key).toBe(`users/${OWNER}/documents/${DOCUMENT}/versions/${VERSION}/source`);
  });

  it('gives every upload session its own staging key', () => {
    const params = { ownerUserId: OWNER, documentId: DOCUMENT, versionId: VERSION };
    const first = quarantineObjectKey(params);
    const second = quarantineObjectKey(params);
    expect(first).not.toBe(second);
    expect(
      first.startsWith(`staging/users/${OWNER}/documents/${DOCUMENT}/versions/${VERSION}/upload-`),
    ).toBe(true);
  });

  it('refuses anything that is not an identifier, so a name can never become a key', () => {
    expect(() =>
      cleanObjectKey({
        ownerUserId: 'alice@example.test',
        documentId: DOCUMENT,
        versionId: VERSION,
      }),
    ).toThrow(/UUID/);
    expect(() =>
      quarantineObjectKey({ ownerUserId: OWNER, documentId: '../etc', versionId: VERSION }),
    ).toThrow(/UUID/);
  });

  it('recognizes its own keys and nothing else', () => {
    expect(
      isPalCertObjectKey(
        cleanObjectKey({ ownerUserId: OWNER, documentId: DOCUMENT, versionId: VERSION }),
      ),
    ).toBe(true);
    expect(
      isPalCertObjectKey(
        quarantineObjectKey({ ownerUserId: OWNER, documentId: DOCUMENT, versionId: VERSION }),
      ),
    ).toBe(true);
    expect(isPalCertObjectKey('users/alice/thesis.pdf')).toBe(false);
    expect(
      isPalCertObjectKey(
        `users/${OWNER}/documents/${DOCUMENT}/versions/${VERSION}/source/../other`,
      ),
    ).toBe(false);
  });
});
