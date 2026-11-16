import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PREPARE_EXPO_CONFIG_JS } from '../src/models/docker-sandbox.js';

/**
 * The app.json preparation the sandbox runs before `expo prebuild` (docker-sandbox.ts), run with plain Node on a
 * throwaway project: no Docker, no Gradle. Returns the resulting app.json and what the script printed.
 */
function prepare(appJson: object, opts: { expoVersion?: string; files?: string[] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'expo-prepare-'));
  try {
    fs.writeFileSync(path.join(dir, 'app.json'), JSON.stringify(appJson));
    if (opts.expoVersion) {
      fs.mkdirSync(path.join(dir, 'node_modules', 'expo'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'node_modules', 'expo', 'package.json'), JSON.stringify({ version: opts.expoVersion }));
    }
    for (const f of opts.files ?? []) {
      fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
      fs.writeFileSync(path.join(dir, f), 'x');
    }
    const script = path.join(dir, 'prepare.js');
    fs.writeFileSync(script, PREPARE_EXPO_CONFIG_JS);
    const log = execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' });
    return { json: JSON.parse(fs.readFileSync(path.join(dir, 'app.json'), 'utf8')), log };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const SPLASH_LINE = /expo\.splash\.backgroundColor is not set, using #ffffff \(Expo SDK 51 needs it to build\)/;

export default async function run() {
  console.log('  Running Expo app.json preparation tests...');

  // SDK 51 without any splash config: the build failed in processReleaseResources (splashscreen_background).
  {
    const { json, log } = prepare({ expo: { name: 'synkro-expo-app', slug: 'synkro-expo-app' } }, { expoVersion: '51.0.39' });
    assert.equal(json.expo.splash.backgroundColor, '#ffffff');
    assert.match(log, SPLASH_LINE);
    assert.equal(json.expo.android.package, 'com.atomvs.synkroexpoapp');
    assert.match(log, /android\.package is not set, using com\.atomvs\.synkroexpoapp/);
    console.log('    ✓ SDK 51, no splash: backgroundColor #ffffff with a build-log line; android.package com.atomvs.*');
  }

  // SDK 51 with a splash image but no color: the image stays, the color is added.
  {
    const { json, log } = prepare(
      { expo: { slug: 'a', splash: { image: './assets/splash.png', resizeMode: 'contain' } } },
      { expoVersion: '51.0.0', files: ['assets/splash.png'] },
    );
    assert.deepEqual(json.expo.splash, { image: './assets/splash.png', resizeMode: 'contain', backgroundColor: '#ffffff' });
    assert.match(log, SPLASH_LINE);
    console.log('    ✓ SDK 51, splash image without color: color added, image kept');
  }

  // A color the user set is never changed, at the top level or under android.
  {
    const top = prepare({ expo: { slug: 'a', splash: { backgroundColor: '#123456' } } }, { expoVersion: '51.0.0' });
    assert.equal(top.json.expo.splash.backgroundColor, '#123456');
    assert.doesNotMatch(top.log, /backgroundColor is not set/);
    const android = prepare({ expo: { slug: 'a', android: { package: 'com.x.y', splash: { backgroundColor: '#000000' } } } }, { expoVersion: '50.0.0' });
    assert.equal(android.json.expo.splash, undefined);
    assert.equal(android.json.expo.android.splash.backgroundColor, '#000000');
    assert.doesNotMatch(android.log, /backgroundColor is not set/);
    console.log('    ✓ User colors (expo.splash / expo.android.splash) are left as they are');
  }

  // SDK 52+ builds without a splash color, so its app.json is not touched (only android.package, as before).
  {
    const { json, log } = prepare({ expo: { slug: 'a', android: { package: 'com.x.y' } } }, { expoVersion: '52.0.49' });
    assert.equal(json.expo.splash, undefined);
    assert.doesNotMatch(log, /backgroundColor/);
    console.log('    ✓ SDK 52+: no splash default added');
  }

  // A missing splash image is still dropped (older templates), and the SDK 51 color default still applies.
  {
    const { json, log } = prepare({ expo: { slug: 'a', splash: { image: './assets/gone.png' } } }, { expoVersion: '51.0.0' });
    assert.deepEqual(json.expo.splash, { backgroundColor: '#ffffff' });
    assert.match(log, /expo\.splash\.image points to a missing image/);
    console.log('    ✓ Missing splash image dropped, color default added');
  }

  console.log('  🟢 All Expo app.json preparation tests passed.');
}
