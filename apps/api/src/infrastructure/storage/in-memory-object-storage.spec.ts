import { InMemoryObjectStorage } from './in-memory-object-storage';
import { ObjectStorageUnavailableError } from './object-storage.port';

async function collect(stream: AsyncIterable<Buffer>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}

describe('InMemoryObjectStorage (the contract the pipeline relies on)', () => {
  it('creates a new version on every write to the same key', async () => {
    const storage = new InMemoryObjectStorage();
    const first = await storage.store('quarantine', 'k', Buffer.from('one'));
    const second = await storage.store('quarantine', 'k', Buffer.from('two'));

    expect(first.versionId).not.toBe(second.versionId);
    expect(storage.versionCount('quarantine', 'k')).toBe(2);
  });

  it('reads exactly the requested version even after a newer write', async () => {
    // The presigned-URL-reuse defence (ADR-0034): finalize captured `first`.
    const storage = new InMemoryObjectStorage();
    const first = await storage.store('quarantine', 'k', Buffer.from('finalized'));
    await storage.store('quarantine', 'k', Buffer.from('reused url wrote this'));

    const { stream, identity } = await storage.getObjectStream({
      zone: 'quarantine',
      key: 'k',
      versionId: first.versionId,
    });
    expect((await collect(stream)).toString()).toBe('finalized');
    expect(identity.versionId).toBe(first.versionId);
  });

  it('honours upload authorizations only within their constraints', async () => {
    const storage = new InMemoryObjectStorage();
    const grant = await storage.createUploadAuthorization({
      zone: 'quarantine',
      key: 'k',
      contentLength: 3,
      contentType: 'application/pdf',
      expiresInSeconds: 60,
    });

    expect((await storage.uploadWithAuthorization(grant.url, Buffer.from('abcd'))).status).toBe(
      400,
    );
    expect((await storage.uploadWithAuthorization(grant.url, Buffer.from('abc'))).status).toBe(200);
    expect(
      (
        await storage.uploadWithAuthorization(
          'memory://quarantine/k?token=forged',
          Buffer.from('abc'),
        )
      ).status,
    ).toBe(403);
  });

  it('copies an exact version and never overwrites an existing destination', async () => {
    const storage = new InMemoryObjectStorage();
    const source = await storage.store('quarantine', 'q', Buffer.from('clean bytes'));
    const promoted = await storage.copyImmutable({
      source: { zone: 'quarantine', key: 'q', versionId: source.versionId },
      destination: { zone: 'clean', key: 'c' },
      contentType: 'application/pdf',
    });
    await storage.store('quarantine', 'q', Buffer.from('later bytes'));
    const again = await storage.copyImmutable({
      source: { zone: 'quarantine', key: 'q', versionId: null },
      destination: { zone: 'clean', key: 'c' },
      contentType: 'application/pdf',
    });

    expect(again.versionId).toBe(promoted.versionId);
    expect(
      (
        await collect((await storage.getObjectStream({ zone: 'clean', key: 'c' })).stream)
      ).toString(),
    ).toBe('clean bytes');
  });

  it('deletes idempotently and by version', async () => {
    const storage = new InMemoryObjectStorage();
    const a = await storage.store('quarantine', 'k', Buffer.from('a'));
    await storage.store('quarantine', 'k', Buffer.from('b'));
    await storage.deleteObject({ zone: 'quarantine', key: 'k', versionId: a.versionId });
    expect(storage.versionCount('quarantine', 'k')).toBe(1);
    await storage.deleteObject({ zone: 'quarantine', key: 'k' });
    await storage.deleteObject({ zone: 'quarantine', key: 'k' });
    expect(await storage.headObject({ zone: 'quarantine', key: 'k' })).toBeNull();
  });

  it('models an outage as the one error callers classify as transient', async () => {
    const storage = new InMemoryObjectStorage();
    storage.failing.add('head');
    await expect(storage.headObject({ zone: 'clean', key: 'x' })).rejects.toBeInstanceOf(
      ObjectStorageUnavailableError,
    );
  });
});
