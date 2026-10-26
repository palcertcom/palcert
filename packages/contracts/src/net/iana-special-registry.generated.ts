/**
 * GENERATED FILE — do not edit by hand.
 *
 * Produced by scripts/generate-iana-registry.mjs from the committed snapshots
 * in security/iana/: IANA registry snapshots plus reviewed supplemental deny
 * entries. CI regenerates this file and requires an empty diff, so the table
 * below is reproducible offline from artifacts that are in the repository
 * beside it.
 *
 * Not every source is a registry export, and the distinction is kept rather
 * than smoothed over: a registry entry is a fact PalCert imported, while a
 * supplemental entry is a decision PalCert made and is answerable for.
 *
 * PalCert policy: an address inside ANY range below is refused as a webhook
 * destination. Phase 17 has zero allow exceptions.
 *
 * Snapshots retrieved 2026-09-17:
 *   [iana] ipv4-special-registry.csv  sha256 e4c26b2b412c524bbb323806070e622514088bbd835b3aa8cf16473e1dbec1e6
 *   [iana] ipv6-special-registry.csv  sha256 cab0a9cdba043e4824a03a529cc9afc490df290eab1cff1afa23e16afadedc60
 *   [iana] ipv4-multicast-registry.csv  sha256 7e6a6c7c85fe1a2e7dcd3abfbd6c4f7e2bfffa6d1e8178eb311175232f9af208
 *   [iana] ipv6-multicast-registry.csv  sha256 f8c65e8dc05ec1a4aa2d810dff824c715d26d6f81f758e2c020749adde47b43d
 *   [supplemental] ipv6-deprecated-extra.csv  sha256 10bb066109308849621cba5b442067972f79f8fda5940943f89f145459f4198c
 */

export interface SpecialPurposeRange {
  readonly cidr: string;
  readonly label: string;
}

/** IPv4 ranges IANA reserves for a special purpose, plus multicast. */
export const IANA_SPECIAL_IPV4: readonly SpecialPurposeRange[] = [
  { cidr: '0.0.0.0/8', label: 'This network' },
  { cidr: '0.0.0.0/32', label: 'This host on this network' },
  { cidr: '10.0.0.0/8', label: 'Private-Use' },
  { cidr: '100.64.0.0/10', label: 'Shared Address Space' },
  { cidr: '127.0.0.0/8', label: 'Loopback' },
  { cidr: '169.254.0.0/16', label: 'Link Local' },
  { cidr: '172.16.0.0/12', label: 'Private-Use' },
  { cidr: '192.0.0.0/24', label: 'IETF Protocol Assignments' },
  { cidr: '192.0.0.0/29', label: 'IPv4 Service Continuity Prefix' },
  { cidr: '192.0.0.8/32', label: 'IPv4 dummy address' },
  { cidr: '192.0.0.9/32', label: 'Port Control Protocol Anycast' },
  { cidr: '192.0.0.10/32', label: 'Traversal Using Relays around NAT Anycast' },
  { cidr: '192.0.0.170/32', label: 'NAT64/DNS64 Discovery' },
  { cidr: '192.0.0.171/32', label: 'NAT64/DNS64 Discovery' },
  { cidr: '192.0.2.0/24', label: 'Documentation (TEST-NET-1)' },
  { cidr: '192.31.196.0/24', label: 'AS112-v4' },
  { cidr: '192.52.193.0/24', label: 'AMT' },
  { cidr: '192.88.99.0/24', label: 'Deprecated (6to4 Relay Anycast)' },
  { cidr: '192.168.0.0/16', label: 'Private-Use' },
  { cidr: '192.175.48.0/24', label: 'Direct Delegation AS112 Service' },
  { cidr: '198.18.0.0/15', label: 'Benchmarking' },
  { cidr: '198.51.100.0/24', label: 'Documentation (TEST-NET-2)' },
  { cidr: '203.0.113.0/24', label: 'Documentation (TEST-NET-3)' },
  { cidr: '240.0.0.0/4', label: 'Reserved' },
  { cidr: '255.255.255.255/32', label: 'Limited Broadcast' },
  { cidr: '224.0.0.0/4', label: 'Multicast' },
];

/** IPv6 ranges IANA reserves for a special purpose, plus multicast. */
export const IANA_SPECIAL_IPV6: readonly SpecialPurposeRange[] = [
  { cidr: '::1/128', label: 'Loopback Address' },
  { cidr: '::/128', label: 'Unspecified Address' },
  { cidr: '::ffff:0:0/96', label: 'IPv4-mapped Address' },
  { cidr: '64:ff9b::/96', label: 'IPv4-IPv6 Translat.' },
  { cidr: '64:ff9b:1::/48', label: 'IPv4-IPv6 Translat.' },
  { cidr: '100::/64', label: 'Discard-Only Address Block' },
  { cidr: '2001::/23', label: 'IETF Protocol Assignments' },
  { cidr: '2001::/32', label: 'TEREDO' },
  { cidr: '2001:1::1/128', label: 'Port Control Protocol Anycast' },
  { cidr: '2001:1::2/128', label: 'Traversal Using Relays around NAT Anycast' },
  { cidr: '2001:1::3/128', label: 'DNS-SD Service Registration Protocol Anycast' },
  { cidr: '2001:2::/48', label: 'Benchmarking' },
  { cidr: '2001:3::/32', label: 'AMT' },
  { cidr: '2001:4:112::/48', label: 'AS112-v6' },
  { cidr: '2001:10::/28', label: 'Deprecated (previously ORCHID)' },
  { cidr: '2001:20::/28', label: 'ORCHIDv2' },
  { cidr: '2001:30::/28', label: 'Drone Remote ID Protocol Entity Tags (DETs) Prefix' },
  { cidr: '2001:db8::/32', label: 'Documentation' },
  { cidr: '2002::/16', label: '6to4' },
  { cidr: '2620:4f:8000::/48', label: 'Direct Delegation AS112 Service' },
  { cidr: '3fff::/20', label: 'Documentation' },
  { cidr: '5f00::/16', label: 'Segment Routing (SRv6) SIDs' },
  { cidr: 'fc00::/7', label: 'Unique-Local' },
  { cidr: 'fe80::/10', label: 'Link-Local Unicast' },
  { cidr: 'ff00::/8', label: 'Multicast' },
  { cidr: '::/96', label: 'IPv4-compatible Address (deprecated)' },
];
