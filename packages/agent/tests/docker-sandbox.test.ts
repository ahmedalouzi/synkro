import assert from 'node:assert/strict';
import { FRAMEWORK_IMAGES, getBuildCommand } from '../src/models/docker-sandbox.js';

export default async function runDockerSandboxTests() {
  console.log('\n--- Docker Sandbox Configuration Unit Tests ---');

  // Test 1: FRAMEWORK_IMAGES Image Tags
  console.log('  [Test 1] Verify framework image mappings');
  {
    assert.equal(FRAMEWORK_IMAGES.flutter, 'synkro/flutter-sandbox:2');
    assert.equal(FRAMEWORK_IMAGES['react-native'], 'synkro/rn-sandbox:1');
    console.log('  ✓ FRAMEWORK_IMAGES uses synkro/rn-sandbox:1 and synkro/flutter-sandbox:2.');
  }

  // Test 2: React Native Build Command ABI Optimization & Directory Safety
  console.log('  [Test 2] Verify ABI filter optimizations & directory safety in RN build command');
  {
    const rnCommandNoKey = getBuildCommand('react-native');
    assert.equal(
      rnCommandNoKey.includes('mkdir -p android && touch android/gradle.properties'),
      true,
      'RN build command must create android directory and properties file before redirecting',
    );
    assert.equal(
      rnCommandNoKey.includes('([ -f android/gradlew ] && chmod +x android/gradlew || true)'),
      true,
      'RN build command must safely check if gradlew exists before chmod',
    );
    assert.equal(
      rnCommandNoKey.includes('reactNativeArchitectures=arm64-v8a,armeabi-v7a'),
      true,
      'RN build command must inject reactNativeArchitectures=arm64-v8a,armeabi-v7a into gradle.properties',
    );
    assert.equal(
      rnCommandNoKey.includes('-Pandroid.injected.build.abi=arm64-v8a,armeabi-v7a'),
      true,
      'RN build command must pass -Pandroid.injected.build.abi to gradlew assembleRelease',
    );

    // Signing no longer changes the command (it is injected through GRADLE_USER_HOME, see createSigningArchive).
    console.log('  ✓ React Native ABI filters and directory safety verified.');
  }

  // Test 3: Flutter Build Command Preservation
  console.log('  [Test 3] Verify Flutter build command remains intact');
  {
    const flutterCmd = getBuildCommand('flutter');
    assert.equal(
      flutterCmd.includes('flutter build apk --release'),
      true,
      'Flutter build command must remain release APK build',
    );
    console.log('  ✓ Flutter build command verified.');
  }

  console.log('🟢 All Docker Sandbox unit tests passed.\n');
}
