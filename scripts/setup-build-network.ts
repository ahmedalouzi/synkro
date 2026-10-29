// Sets up the Cloud Build sandbox firewall: the build-restricted Docker network (bridge build0), the ipset and
// iptables rules, and the dnsmasq allowlist. Needs root. Run at boot by synkro-build-network.service
// (installed by scripts/setup-production-server.sh) so the build worker itself can run without root.
//   sudo npx tsx scripts/setup-build-network.ts
import { execFileSync } from 'node:child_process';
import { setupBuildNetwork, verifySandboxDns } from '../packages/agent/src/models/network-setup';

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
  console.log('[setup-build-network] Build network ready: only allowlisted names resolve.');
}

main().catch((err) => {
  console.error('[setup-build-network] FAILED:', err.message || err);
  process.exit(1);
});
