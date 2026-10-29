import assert from 'node:assert/strict';
import {
  generateDnsmasqConfig,
  ALLOWLISTED_FQDNS,
  RESOLVER_IP,
  IPSET_NAME,
} from '../src/models/network-setup.js';

export default async function runNetworkSetupTests() {
  console.log('\n--- Network Setup & DNS Isolation Unit Tests ---');

  const config = generateDnsmasqConfig();
  const lines = config.split('\n');

  // Test 1: Critical Security - No Global Forwarders
  console.log('  [Test 1] Verify zero global server= forwarders');
  {
    const globalServerRegex = /^server=\s*[^/]/m;
    assert.equal(
      globalServerRegex.test(config),
      false,
      'CRITICAL: Global server= forwarders detected! Must be removed to prevent DNS exfiltration.',
    );
    console.log('  ✓ No global server= directives found.');
  }

  // Test 2: Required Domain Inclusions
  console.log('  [Test 2] Verify maven.google.com is allowed and oss.sonatype.org is not (until a Linux build needs it)');
  {
    assert.equal(
      ALLOWLISTED_FQDNS.includes('maven.google.com'),
      true,
      'maven.google.com must be in ALLOWLISTED_FQDNS',
    );
    assert.equal(
      ALLOWLISTED_FQDNS.some((d) => d.endsWith('sonatype.org')),
      false,
      'oss.sonatype.org stays blocked until a firewalled Linux build shows it is needed',
    );
    console.log('  ✓ Allowlist matches the tested builds.');
  }

  // Test 3: Per-Domain Upstream & IPSet Directives
  console.log('  [Test 3] Verify domain-specific server= and ipset= for every allowlisted FQDN');
  {
    for (const fqdn of ALLOWLISTED_FQDNS) {
      assert.equal(
        lines.includes(`server=/${fqdn}/8.8.8.8`),
        true,
        `Expected server=/${fqdn}/8.8.8.8 in dnsmasq config`,
      );
      assert.equal(
        lines.includes(`server=/${fqdn}/1.1.1.1`),
        true,
        `Expected server=/${fqdn}/1.1.1.1 in dnsmasq config`,
      );
      assert.equal(
        lines.includes(`ipset=/${fqdn}/${IPSET_NAME}`),
        true,
        `Expected ipset=/${fqdn}/${IPSET_NAME} in dnsmasq config`,
      );
    }
    console.log(`  ✓ All ${ALLOWLISTED_FQDNS.length} domains properly configured with domain-isolated upstreams.`);
  }

  // Test 4: Base Directives & Sinkhole
  console.log('  [Test 4] Verify listen-address, no-resolv, and catch-all NXDOMAIN sinkhole');
  {
    assert.equal(lines.includes(`listen-address=${RESOLVER_IP}`), true);
    assert.equal(lines.includes('bind-interfaces'), true);
    assert.equal(lines.includes('no-resolv'), true);
    assert.equal(lines.includes('address=/#/'), true, 'Catch-all address=/#/ must be present');
    console.log('  ✓ Base directives and NXDOMAIN sinkhole verified.');
  }

  console.log('🟢 All Network Setup unit tests passed.\n');
}
