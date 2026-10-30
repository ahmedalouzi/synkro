import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import forge from 'node-forge';
import {
  SIGNING_KEY_ALIAS,
  decryptField,
  encryptField,
  fieldAad,
  generateUploadKeystore,
  loadSigningEncKey,
} from '../src/models/signing-keys.js';
import { DockerSandbox, createGradleHomeArchive, signingGradleProperties, ABI_INIT_SCRIPT } from '../src/models/docker-sandbox.js';
import { isDebugCertificate, parseApkVerifyOutput } from '../src/models/apk-verify.js';

/** Release signing without Docker or Postgres: encryption, the generated keystore, and no secrets in the container command. */
export default async function run() {
  const saved = process.env.SYNKRO_SIGNING_ENC_KEY;
  try {
    // --- SYNKRO_SIGNING_ENC_KEY ---
    delete process.env.SYNKRO_SIGNING_ENC_KEY;
    assert.throws(() => loadSigningEncKey(), /not set/);
    process.env.SYNKRO_SIGNING_ENC_KEY = crypto.randomBytes(16).toString('base64');
    assert.throws(() => loadSigningEncKey(), /32 bytes/);
    process.env.SYNKRO_SIGNING_ENC_KEY = crypto.randomBytes(32).toString('base64');
    const key = loadSigningEncKey();
    assert.equal(key.length, 32);

    // --- AES-256-GCM with AAD ---
    const user = crypto.randomUUID();
    const project = crypto.randomUUID();
    const aad = fieldAad(user, project, 'store_password');
    const secret = Buffer.from('correct horse battery staple');
    const blob = encryptField(secret, aad, key);
    assert.ok(!blob.includes(secret), 'ciphertext must not contain the plaintext');
    assert.notDeepEqual(encryptField(secret, aad, key), blob, 'a fresh IV every time');
    assert.deepEqual(decryptField(blob, aad, key), secret);
    // Moved to another project, another field or another user: refused.
    assert.throws(() => decryptField(blob, fieldAad(user, crypto.randomUUID(), 'store_password'), key));
    assert.throws(() => decryptField(blob, fieldAad(user, project, 'key_password'), key));
    assert.throws(() => decryptField(blob, fieldAad(crypto.randomUUID(), project, 'store_password'), key));
    // Wrong key, or any changed byte: refused.
    assert.throws(() => decryptField(blob, aad, crypto.randomBytes(32)));
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] ^= 1;
    assert.throws(() => decryptField(tampered, aad, key));
    assert.throws(() => decryptField(blob.subarray(0, 20), aad, key), /too short/);

    // --- Generated PKCS#12 upload key ---
    const generated = generateUploadKeystore();
    assert.match(generated.password, /^[A-Za-z0-9_-]{32}$/);
    const p12 = forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(generated.keystore.toString('binary')), generated.password);
    const keyBags = p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[forge.pki.oids.pkcs8ShroudedKeyBag]!;
    const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag]!;
    assert.equal(keyBags.length, 1);
    assert.equal(certBags.length, 1);
    assert.equal(keyBags[0].attributes.friendlyName?.[0], SIGNING_KEY_ALIAS);
    const cert = certBags[0].cert!;
    assert.equal((cert.publicKey as forge.pki.rsa.PublicKey).n.bitLength(), 2048);
    assert.equal(cert.siginfo.algorithmOid, forge.pki.oids.sha256WithRSAEncryption);
    const years = (cert.validity.notAfter.getTime() - Date.now()) / (365.25 * 24 * 3600 * 1000);
    assert.ok(years > 29.9, `certificate valid for ${years.toFixed(1)} years`);
    const der = Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary');
    assert.equal(crypto.createHash('sha256').update(der).digest('hex'), generated.certSha256);
    assert.throws(() => forge.pkcs12.pkcs12FromAsn1(forge.asn1.fromDer(generated.keystore.toString('binary')), 'wrong'));
    assert.notEqual(generateUploadKeystore().certSha256, generated.certSha256, 'every project gets its own key');

    // --- The sandbox never puts the signing secrets on the command line ---
    const signing = { keystore: generated.keystore, storePassword: generated.password, keyPassword: generated.password, alias: SIGNING_KEY_ALIAS };
    for (const framework of ['flutter', 'react-native'] as const) {
      const args = new DockerSandbox({ jobId: 'job', projectPath: '/tmp/p', framework, projectId: '3f9a1c07-be42-4d11-9a0e-123456789abc', signing }).createContainerArgs('build-restricted').join(' ');
      assert.ok(!args.includes(generated.password), `${framework}: password in docker create args`);
      assert.ok(!args.includes(generated.keystore.toString('base64').slice(0, 40)), `${framework}: keystore in docker create args`);
      assert.ok(!/MYAPP_UPLOAD|key\.properties|storePassword=/.test(args), `${framework}: old signing code is gone`);
      assert.ok(args.includes('GRADLE_USER_HOME=/tmp/.gradle'));
    }
    const props = signingGradleProperties(signing);
    assert.equal(props, [
      'android.injected.signing.store.file=/tmp/.gradle/synkro-upload.p12',
      `android.injected.signing.store.password=${generated.password}`,
      'android.injected.signing.key.alias=synkro-upload',
      `android.injected.signing.key.password=${generated.password}`,
      '',
    ].join('\n'));

    // The archive streamed into the container: owned by 1000, 0700 / 0600, with a valid ustar checksum.
    const archive = createGradleHomeArchive(signing);
    const entries: { name: string; mode: number; uid: number; size: number }[] = [];
    for (let off = 0; off + 512 <= archive.length;) {
      const header = archive.subarray(off, off + 512);
      if (header.every((b) => b === 0)) break;
      const text = (a: number, n: number) => header.toString('utf8', a, a + n).replace(/\0.*$/s, '');
      const stored = parseInt(text(148, 8).trim(), 8);
      const check = Buffer.from(header);
      check.fill(' ', 148, 156);
      assert.equal(check.reduce((sum, b) => sum + b, 0), stored, 'tar checksum');
      const size = parseInt(text(124, 12), 8);
      entries.push({ name: text(0, 100), mode: parseInt(text(100, 8), 8), uid: parseInt(text(108, 8), 8), size });
      off += 512 + Math.ceil(size / 512) * 512;
    }
    assert.deepEqual(entries.map((e) => [e.name, e.mode.toString(8), e.uid]), [
      ['tmp/.gradle/', '700', 1000],
      ['tmp/.gradle/init.d/', '700', 1000],
      ['tmp/.gradle/init.d/atomvs-abi.gradle', '600', 1000],
      ['tmp/.gradle/gradle.properties', '600', 1000],
      ['tmp/.gradle/synkro-upload.p12', '600', 1000],
    ]);
    assert.equal(entries[2].size, Buffer.byteLength(ABI_INIT_SCRIPT));
    assert.equal(entries[4].size, generated.keystore.length);
    // Unsigned builds still get the ABI init script, and nothing else.
    const unsigned = createGradleHomeArchive();
    assert.ok(unsigned.includes(Buffer.from('init.d/atomvs-abi.gradle')));
    assert.ok(!unsigned.includes(Buffer.from('gradle.properties')));
    assert.ok(ABI_INIT_SCRIPT.includes("def abis = ['arm64-v8a', 'armeabi-v7a']"));
    assert.ok(ABI_INIT_SCRIPT.includes('finalizeDsl'));

    // --- apksigner / aapt2 output ---
    const sample = (prefix: string, dn: string, sha: string) => [
      `${prefix}: certificate DN: ${dn}`,
      `${prefix}: certificate SHA-256 digest: ${sha}`,
      `${prefix}: certificate SHA-1 digest: 0123`,
      '--- badging',
      "package: name='com.synkro.demo' versionCode='1' versionName='1.0.0'",
    ].join('\n');
    const sha = 'a'.repeat(64);
    assert.deepEqual(parseApkVerifyOutput(sample('Signer #1', 'O=Synkro, CN=Synkro Upload Key', sha)), {
      certDn: 'O=Synkro, CN=Synkro Upload Key', certSha256: sha, packageName: 'com.synkro.demo',
    });
    assert.equal(parseApkVerifyOutput(sample('V3.0 Signer', 'O=Synkro, CN=Synkro Upload Key', sha)).certSha256, sha);
    assert.throws(() => parseApkVerifyOutput('DOES NOT VERIFY'), /did not report a signer/);
    assert.throws(() => parseApkVerifyOutput(sample('Signer #1', 'CN=A', sha) + '\n' + sample('Signer #2', 'CN=B', 'b'.repeat(64))), /more than one/);
    assert.equal(isDebugCertificate('CN=Android Debug, OU=Android, O=Unknown, L=Unknown, ST=Unknown, C=US'), true);
    assert.equal(isDebugCertificate('O=Unknown, CN=Android Debug'), true);
    assert.equal(isDebugCertificate('O=Synkro, CN=Synkro Upload Key'), false);
    assert.equal(isDebugCertificate('CN=Android Debugger Fan Club'), false);
  } finally {
    if (saved === undefined) delete process.env.SYNKRO_SIGNING_ENC_KEY;
    else process.env.SYNKRO_SIGNING_ENC_KEY = saved;
  }
}
