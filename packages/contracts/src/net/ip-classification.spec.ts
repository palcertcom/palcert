import { describe, expect, it } from 'vitest';
import { classifyDestination, parseIpAddress } from './ip-classification';
import { IANA_SPECIAL_IPV4, IANA_SPECIAL_IPV6 } from './iana-special-registry.generated';

/**
 * The SSRF classifier, checked against the registries it is generated from.
 *
 * These assertions are the security property, not a smoke test: everything
 * else in Phase 17 assumes that an address reaching the socket has been
 * through this function and came back allowed.
 */

/** The first address of a CIDR, which is the one guaranteed to be inside it. */
function firstAddressOf(cidr: string): string {
  return (cidr.split('/')[0] ?? '').trim();
}

describe('IANA special-purpose classification', () => {
  it('refuses the first address of every generated IPv4 range', () => {
    for (const range of IANA_SPECIAL_IPV4) {
      const verdict = classifyDestination(firstAddressOf(range.cidr));
      expect([range.cidr, verdict.allowed]).toEqual([range.cidr, false]);
    }
  });

  it('refuses the first address of every generated IPv6 range', () => {
    for (const range of IANA_SPECIAL_IPV6) {
      const verdict = classifyDestination(firstAddressOf(range.cidr));
      expect([range.cidr, verdict.allowed]).toEqual([range.cidr, false]);
    }
  });

  it('covers the ranges an SSRF actually aims at', () => {
    // Named individually because these are the ones that matter, and a
    // generated list that silently lost one should fail here too.
    const refused = [
      ['loopback', '127.0.0.1'],
      ['loopback, high in the range', '127.255.255.254'],
      ['this network', '0.0.0.0'],
      ['private 10/8', '10.0.0.1'],
      ['private 172.16/12', '172.16.0.1'],
      ['private 172.31 edge', '172.31.255.254'],
      ['private 192.168/16', '192.168.1.1'],
      ['link-local metadata', '169.254.169.254'],
      ['carrier-grade NAT', '100.64.0.1'],
      ['benchmarking', '198.18.0.1'],
      ['documentation TEST-NET-1', '192.0.2.1'],
      ['documentation TEST-NET-2', '198.51.100.1'],
      ['documentation TEST-NET-3', '203.0.113.1'],
      ['6to4 relay anycast', '192.88.99.1'],
      ['reserved 240/4', '240.0.0.1'],
      ['limited broadcast', '255.255.255.255'],
      ['multicast v4', '224.0.0.1'],
      ['multicast v4, high', '239.255.255.255'],
      ['IPv6 loopback', '::1'],
      ['IPv6 unspecified', '::'],
      ['IPv6 link-local', 'fe80::1'],
      ['IPv6 unique-local', 'fc00::1'],
      ['IPv6 unique-local, fd', 'fd12:3456::1'],
      ['IPv6 multicast', 'ff02::1'],
      ['IPv6 documentation', '2001:db8::1'],
      ['IPv6 documentation, new', '3fff::1'],
      ['Teredo', '2001::1'],
      ['ORCHID v1 (deprecated)', '2001:10::1'],
      ['ORCHIDv2', '2001:20::1'],
      ['IPv6 benchmarking', '2001:2::1'],
      ['discard-only', '100::1'],
      ['SRv6 SIDs', '5f00::1'],
      ['NAT64 well-known', '64:ff9b::1'],
      ['NAT64 local-use second prefix', '64:ff9b:1::1'],
    ] as const;

    for (const [label, address] of refused) {
      expect([label, classifyDestination(address).allowed]).toEqual([label, false]);
    }
  });

  it('unwraps an IPv4 address hidden inside an IPv6 one', () => {
    // A public-looking wrapper around a private address is the interesting
    // case: each of these names 10.0.0.1 or 169.254.169.254 in the end.
    const smuggled = [
      ['IPv4-mapped private', '::ffff:10.0.0.1'],
      ['IPv4-mapped metadata', '::ffff:169.254.169.254'],
      ['IPv4-compatible private', '::10.0.0.1'],
      ['NAT64-embedded private', '64:ff9b::10.0.0.1'],
      ['NAT64-embedded metadata', '64:ff9b::169.254.169.254'],
      ['6to4-embedded private', '2002:0a00:0001::1'],
      ['6to4-embedded metadata', '2002:a9fe:a9fe::1'],
    ] as const;

    for (const [label, address] of smuggled) {
      expect([label, classifyDestination(address).allowed]).toEqual([label, false]);
    }
  });

  it('allows ordinary public addresses', () => {
    for (const address of [
      '93.184.216.34',
      '8.8.8.8',
      '1.1.1.1',
      '2606:2800:220:1:248:1893:25c8:1946',
      '2a00:1450:4001:80e::200e',
    ]) {
      expect([address, classifyDestination(address).allowed]).toEqual([address, true]);
    }
  });

  it('does not let a v4 range match a v6 address sharing its low bytes', () => {
    // 2001:db8::7f00:1 ends in 127.0.0.1's bytes but is not 127.0.0.1; it is
    // refused for being documentation space, not for being loopback.
    expect(classifyDestination('2606:2800:220:1:248:1893:7f00:0001').allowed).toBe(true);
  });

  it('refuses what it cannot parse rather than guessing', () => {
    for (const bad of [
      '',
      'not-an-address',
      '999.1.1.1',
      '1.2.3',
      '::fffff:1.2.3.4',
      'fe80::1::2',
    ]) {
      expect([bad, classifyDestination(bad).allowed]).toEqual([bad, false]);
    }
  });

  it('treats a scoped link-local as link-local', () => {
    expect(classifyDestination('fe80::1%eth0').allowed).toBe(false);
  });

  it('parses the forms a resolver actually returns', () => {
    expect(parseIpAddress('192.0.2.1')).not.toBeNull();
    expect(parseIpAddress('2001:db8::1')).not.toBeNull();
    expect(parseIpAddress('[2001:db8::1]')).not.toBeNull();
    // And refuses the alternate spellings a URL might carry, which never
    // reach here anyway because an IP-literal host is rejected outright.
    expect(parseIpAddress('0x7f.1')).toBeNull();
    expect(parseIpAddress('2130706433')).toBeNull();
    expect(parseIpAddress('017700000001')).toBeNull();
  });
});
