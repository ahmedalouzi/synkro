// Sets up the Cloud Build sandbox firewall: the build-restricted Docker network (bridge build0), the ipset and
// iptables rules, and the dnsmasq allowlist. Needs root. Run at boot by synkro-build-network.service
// (installed by scripts/setup-production-server.sh) so the build worker itself can run without root.
//   sudo SYNKRO_DNS_CHECK_IMAGE=synkro/rn-sandbox:1 npx tsx scripts/setup-build-network.ts
import { execFileSync } from 'node:child_process';
import { setupBuildNetwork, verifySandboxDns, verifySandboxDnsInContainer } from '../packages/agent/src/models/network-setup';

function imageExists(image: string): boolean {
  try {
    execFileSync('docker', ['image', 'inspect', image], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function main() {
  if (process.platform !== 'linux' || process.getuid?.() !== 0) {
    throw new Error('Run this on the Linux build host as root.');
  }
  await setupBuildNetwork();
  try {
    await verifySandboxDns();
  } catch {
    // At boot dnsmasq can start before Docker brings up build0 (172.30.0.1) and fail to bind; setupBuildNetwork
    // only restarts it when the config file changed.
    execFileSync('systemctl', ['restart', 'dnsmasq']);
    await verifySandboxDns();
  }
  // The check above queries from the host; builds resolve through Docker's embedded DNS inside the container.
  const image = process.env.SYNKRO_DNS_CHECK_IMAGE;
  if (!image || !imageExists(image)) {
    console.warn(`[setup-build-network] WARNING: no sandbox image (${image || 'SYNKRO_DNS_CHECK_IMAGE not set'}): in-container DNS check skipped.`);
    console.log('[setup-build-network] Build network set up; checked from the host only.');
    return;
  }
  await verifySandboxDnsInContainer(image);
  console.log(`[setup-build-network] Build network ready: only allowlisted names resolve (checked inside a ${image} container).`);
}

main().catch((err) => {
  console.error('[setup-build-network] FAILED:', err.message || err);
  process.exit(1);
});
