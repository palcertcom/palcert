import { describe, expect, it } from 'vitest';
import { WebhookUrlRejection, normalizeHost, validateWebhookUrl } from './webhook-url';

const POLICY = { allowedPorts: [443], ownHosts: ['api.palcert.test', 'app.palcert.test'] };

function reject(url: string): string | undefined {
  const result = validateWebhookUrl(url, POLICY);
  return result.ok ? undefined : result.rejection;
}

describe('webhook URL policy', () => {
  it('accepts an ordinary HTTPS endpoint', () => {
    const result = validateWebhookUrl('https://hooks.example.test/palcert', POLICY);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.host).toBe('hooks.example.test');
    expect(result.value.port).toBe(443);
    expect(result.value.path).toBe('/palcert');
    // The default port is not spelled out, so two ways of writing the same
    // destination produce one normalized URL and one digest.
    expect(result.value.url).toBe('https://hooks.example.test/palcert');
    expect(validateWebhookUrl('https://hooks.example.test:443/palcert', POLICY)).toEqual(result);
  });

  it('normalizes an internationalized host to punycode', () => {
    const result = validateWebhookUrl('https://дом.example/hook', POLICY);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.host).toBe('xn--d1aqf.example');
  });

  it('strips a trailing root dot before judging the host', () => {
    // Without this, `api.palcert.test.` would slip past the self-host check.
    expect(normalizeHost('API.PalCert.Test.')).toBe('api.palcert.test');
    expect(reject('https://api.palcert.test./hook')).toBe(WebhookUrlRejection.PALCERT_OWN_HOST);
  });

  it('refuses everything that is not plain HTTPS', () => {
    expect(reject('http://hooks.example.test/h')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('ftp://hooks.example.test/h')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('ws://hooks.example.test/h')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('wss://hooks.example.test/h')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('file:///etc/passwd')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('data:text/plain,hi')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('javascript:alert(1)')).toBe(WebhookUrlRejection.SCHEME_NOT_HTTPS);
    expect(reject('not a url at all')).toBe(WebhookUrlRejection.NOT_A_URL);
  });

  it('refuses credentials, fragments and query strings', () => {
    expect(reject('https://user:pw@hooks.example.test/h')).toBe(
      WebhookUrlRejection.CREDENTIALS_PRESENT,
    );
    expect(reject('https://hooks.example.test/h#frag')).toBe(WebhookUrlRejection.FRAGMENT_PRESENT);
    // A token in the query string is a credential in the one place logs and
    // proxies see it; the signature is what authenticates PalCert.
    expect(reject('https://hooks.example.test/h?token=abc')).toBe(
      WebhookUrlRejection.QUERY_PRESENT,
    );
  });

  it('refuses an address written as a host, however it is spelled', () => {
    for (const url of [
      'https://127.0.0.1/h',
      'https://10.0.0.1/h',
      'https://169.254.169.254/h',
      'https://0x7f.1/h',
      'https://2130706433/h',
      'https://017700000001/h',
      'https://127.1/h',
      'https://[::1]/h',
      'https://[fe80::1]/h',
      'https://[::ffff:10.0.0.1]/h',
    ]) {
      expect([url, reject(url)]).toEqual([url, WebhookUrlRejection.IP_LITERAL_HOST]);
    }
  });

  it('refuses names that resolve to whatever the host decides', () => {
    expect(reject('https://localhost/h')).toBe(WebhookUrlRejection.LOOPBACK_HOST);
    expect(reject('https://api.localhost/h')).toBe(WebhookUrlRejection.LOOPBACK_HOST);
    expect(reject('https://intranet/h')).toBe(WebhookUrlRejection.SINGLE_LABEL_HOST);
  });

  it('refuses PalCert’s own hosts so a webhook cannot loop back in', () => {
    expect(reject('https://api.palcert.test/h')).toBe(WebhookUrlRejection.PALCERT_OWN_HOST);
    expect(reject('https://APP.PALCERT.TEST/h')).toBe(WebhookUrlRejection.PALCERT_OWN_HOST);
  });

  it('refuses a port the deployment did not allow', () => {
    for (const port of [22, 25, 53, 80, 2375, 3306, 5432, 6379, 9200, 8080]) {
      expect([port, reject(`https://hooks.example.test:${port}/h`)]).toEqual([
        port,
        WebhookUrlRejection.PORT_NOT_ALLOWED,
      ]);
    }
    // And accepts one the platform explicitly allowed.
    const wider = { ...POLICY, allowedPorts: [443, 8443] };
    expect(validateWebhookUrl('https://hooks.example.test:8443/h', wider).ok).toBe(true);
  });

  it('refuses a malformed or overlong host', () => {
    expect(reject('https://has_underscore.example/h')).toBe(WebhookUrlRejection.MALFORMED_HOST);
    expect(reject(`https://hooks.example.test/${'a'.repeat(2100)}`)).toBe(
      WebhookUrlRejection.TOO_LONG,
    );
  });

  it('digests the normalized URL, so equality needs no plaintext', () => {
    const a = validateWebhookUrl('https://hooks.example.test:443/h', POLICY);
    const b = validateWebhookUrl('https://HOOKS.example.test/h', POLICY);
    expect(a.ok && b.ok && a.value.urlSha256 === b.value.urlSha256).toBe(true);
    const c = validateWebhookUrl('https://hooks.example.test/other', POLICY);
    expect(a.ok && c.ok && a.value.urlSha256 !== c.value.urlSha256).toBe(true);
  });
});
