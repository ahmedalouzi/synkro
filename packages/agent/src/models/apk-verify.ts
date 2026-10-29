import { spawn } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { FRAMEWORK_IMAGES } from './docker-sandbox';

// apksigner and aapt2 come from the React Native build image (Android build-tools), run with no network.
const VERIFY_IMAGE = FRAMEWORK_IMAGES['react-native'];
const VERIFY_SCRIPT = [
  'cat > /tmp/app.apk',
  'BT=$(ls -d /opt/android/build-tools/* | sort -V | tail -1)',
  '"$BT/apksigner" verify --print-certs /tmp/app.apk',
  'echo "--- badging"',
  '"$BT/aapt2" dump badging /tmp/app.apk | grep "^package:"',
].join(' && ');

export interface ApkSignature {
  certDn: string;
  certSha256: string;
  packageName: string;
}

/** Parses `apksigner verify --print-certs` + `aapt2 dump badging` output. Exported for tests. */
export function parseApkVerifyOutput(output: string): ApkSignature {
  const dns = [...output.matchAll(/certificate DN: (.+)/g)].map((m) => m[1].trim());
  const digests = [...output.matchAll(/certificate SHA-256 digest: ([0-9a-f]{64})/g)].map((m) => m[1]);
  const packageName = /^package: name='([^']+)'/m.exec(output)?.[1];
  if (dns.length === 0 || digests.length === 0) throw new Error('apksigner did not report a signer');
  if (new Set(digests).size !== 1) throw new Error('APK has more than one signing certificate');
  if (!packageName) throw new Error('aapt2 did not report a package name');
  return { certDn: dns[0], certSha256: digests[0], packageName };
}

/** True for the shared Android debug key (anyone can sign with it; Google Play rejects it). */
export function isDebugCertificate(certDn: string): boolean {
  return /(^|,\s*)CN=Android Debug(,|$)/.test(certDn);
}

/** Verifies the APK's signature and reads its signer and package name. Throws when the APK does not verify. */
export function verifyApk(apkPath: string): Promise<ApkSignature> {
  return new Promise((resolve, reject) => {
    const child = spawn('docker', [
      'run', '--rm', '-i', '--network', 'none', '--cap-drop=ALL', '--security-opt', 'no-new-privileges',
      '--user=1000:1000', '--memory=1g', '--entrypoint', 'sh', VERIFY_IMAGE, '-c', VERIFY_SCRIPT,
    ]);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`APK verification failed: ${(stderr || stdout).trim().slice(0, 500)}`));
        return;
      }
      try {
        resolve(parseApkVerifyOutput(stdout));
      } catch (err) {
        reject(err);
      }
    });
    createReadStream(apkPath).on('error', reject).pipe(child.stdin);
  });
}
