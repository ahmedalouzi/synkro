import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import {
  FlutterService,
  isFlutterSdkNotFoundError,
  FLUTTER_SDK_NOT_FOUND_MSG
} from '../../../apps/desktop/src/main/services/flutter-service';
import { getTemplate } from '@peep/flutter-adapter';

export default async function run() {
  console.log('  Testing isFlutterSdkNotFoundError helper...');

  // 1. Windows missing flutter / cmd error patterns
  assert.equal(
    isFlutterSdkNotFoundError("'flutter.bat' is not recognized as an internal or external command, operable program or batch file."),
    true,
    'Windows flutter.bat unrecognized command'
  );
  assert.equal(
    isFlutterSdkNotFoundError('The system cannot find the path specified.'),
    true,
    'Windows path not found'
  );
  assert.equal(
    isFlutterSdkNotFoundError('The system cannot find the file specified.'),
    true,
    'Windows file not found'
  );

  // 2. Unix missing flutter error patterns
  assert.equal(
    isFlutterSdkNotFoundError('/bin/sh: flutter: command not found'),
    true,
    'Unix command not found'
  );
  assert.equal(
    isFlutterSdkNotFoundError('flutter: not found'),
    true,
    'Unix not found'
  );
  assert.equal(
    isFlutterSdkNotFoundError('spawn flutter enoent'),
    true,
    'Node ENOENT spawn'
  );
  assert.equal(
    isFlutterSdkNotFoundError('Command failed: exited with code 127'),
    true,
    'Exit code 127'
  );
  assert.equal(
    isFlutterSdkNotFoundError('Flutter SDK not found. A local Flutter SDK is required for live preview.'),
    true,
    'Standardized flutter sdk not found'
  );
  assert.equal(
    isFlutterSdkNotFoundError('Preview startup timed out after 120s. Is Flutter SDK installed?'),
    true,
    'Timeout asking if SDK is installed'
  );

  // 3. Normal Flutter compilation / runtime errors must NOT be classified as SDK missing
  assert.equal(
    isFlutterSdkNotFoundError("lib/main.dart:14:5: Error: Method not found: 'runApp'."),
    false,
    'Dart compilation error should not trigger SDK missing'
  );
  assert.equal(
    isFlutterSdkNotFoundError("Unhandled exception: LateInitializationError: Field 'user' has not been initialized."),
    false,
    'Dart runtime exception should not trigger SDK missing'
  );
  assert.equal(
    isFlutterSdkNotFoundError(''),
    false,
    'Empty string should return false'
  );
  assert.equal(
    isFlutterSdkNotFoundError(null as any),
    false,
    'Null should return false'
  );

  console.log('  Testing Flutter templates (blank, material-app, bottom-nav)...');

  // Verify blank template has starter file
  const blankTemplate = getTemplate('blank');
  assert.ok(blankTemplate, 'blank template exists');
  assert.equal(blankTemplate.files.length, 1, 'blank template now provides lib/main.dart');
  assert.equal(blankTemplate.files[0]!.relativePath, 'lib/main.dart');
  assert.ok(blankTemplate.files[0]!.content.includes('class MyApp extends StatelessWidget'));
  assert.ok(blankTemplate.files[0]!.content.includes('Hello from Atomvs'));

  // Verify material-app template
  const matTemplate = getTemplate('material-app');
  assert.ok(matTemplate, 'material-app template exists');
  assert.ok(matTemplate.files[0]!.content.includes('AtomvsMaterialApp'));

  // Verify bottom-nav template
  const navTemplate = getTemplate('bottom-nav');
  assert.ok(navTemplate, 'bottom-nav template exists');
  assert.ok(navTemplate.files[0]!.content.includes('AtomvsNavApp'));

  console.log('  Testing FlutterService.createProject template writing and --org com.atomvs...');

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flutter-svc-test-'));

  try {
    let capturedCmds: { command: string; args: string[]; cwd: string }[] = [];

    // Mock ProcessManager
    const mockProcessManager: any = {
      spawn: (command: string, args: string[], cwd: string) => {
        capturedCmds.push({ command, args, cwd });
        const emitter: any = new EventEmitter();
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        // Simulate successful command
        process.nextTick(() => {
          emitter.emit('close', 0);
          emitter.emit('exit', 0);
        });
        return { id: 101, process: emitter };
      },
    };

    const service = new FlutterService(mockProcessManager);

    // Test 1: createProject with material-app (default)
    const p1 = await service.createProject('sample_mat', tmp, 'material-app');
    assert.equal(p1, path.join(tmp, 'sample_mat'));

    // Check args passed to flutter create
    const createCmd1 = capturedCmds.find((c) => c.args.includes('sample_mat'));
    assert.ok(createCmd1, 'flutter create was called');
    assert.deepEqual(
      createCmd1.args,
      ['create', 'sample_mat', '--project-name', 'sample_mat', '--org', 'com.atomvs'],
      'flutter create must include --org com.atomvs to avoid Google Play com.example rejection'
    );

    // Check applied files
    const mainDart1 = fs.readFileSync(path.join(p1, 'lib', 'main.dart'), 'utf8');
    assert.ok(mainDart1.includes('AtomvsMaterialApp'), 'lib/main.dart applied from material-app');

    const testDart1 = fs.readFileSync(path.join(p1, 'test', 'widget_test.dart'), 'utf8');
    assert.ok(testDart1.includes("import 'package:sample_mat/main.dart' as app;"));
    assert.ok(testDart1.includes('app.main();'));

    // Test 2: createProject with bottom-nav
    capturedCmds = [];
    const p2 = await service.createProject('sample_nav', tmp, 'bottom-nav');
    const mainDart2 = fs.readFileSync(path.join(p2, 'lib', 'main.dart'), 'utf8');
    assert.ok(mainDart2.includes('AtomvsNavApp'), 'lib/main.dart applied from bottom-nav');

    // Test 3: createProject with blank template
    capturedCmds = [];
    const p3 = await service.createProject('sample_blank', tmp, 'blank');
    const mainDart3 = fs.readFileSync(path.join(p3, 'lib', 'main.dart'), 'utf8');
    assert.ok(mainDart3.includes('MyApp'), 'lib/main.dart applied from blank template');
    assert.ok(mainDart3.includes('Hello from Atomvs'));

    console.log('  Testing FlutterService error formatting when SDK is not found...');

    // Mock ProcessManager for missing SDK (exit with 'flutter.bat is not recognized')
    const mockMissingSdkManager: any = {
      spawn: (command: string, args: string[], cwd: string) => {
        const emitter: any = new EventEmitter();
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        process.nextTick(() => {
          emitter.stderr.emit(
            'data',
            Buffer.from("'flutter.bat' is not recognized as an internal or external command,\r\noperable program or batch file.\r\n")
          );
          emitter.emit('close', 1);
          emitter.emit('exit', 1);
        });
        return { id: 102, process: emitter };
      },
    };

    const failingService = new FlutterService(mockMissingSdkManager);

    // Test startWebPreview error
    await assert.rejects(
      async () => {
        await failingService.startWebPreview(tmp);
      },
      (err: Error) => {
        assert.equal(err.message, FLUTTER_SDK_NOT_FOUND_MSG);
        return true;
      },
      'startWebPreview formats missing flutter.bat as FLUTTER_SDK_NOT_FOUND_MSG'
    );

    // Test runCommand error via pubGet
    await assert.rejects(
      async () => {
        await failingService.pubGet(tmp);
      },
      (err: Error) => {
        assert.equal(err.message, FLUTTER_SDK_NOT_FOUND_MSG);
        return true;
      },
      'runCommand formats missing flutter.bat as FLUTTER_SDK_NOT_FOUND_MSG'
    );

    // Mock ProcessManager for ENOENT error event
    const mockEnoentManager: any = {
      spawn: () => {
        const emitter: any = new EventEmitter();
        emitter.stdout = new EventEmitter();
        emitter.stderr = new EventEmitter();
        process.nextTick(() => {
          const enoentErr: any = new Error('spawn flutter ENOENT');
          enoentErr.code = 'ENOENT';
          emitter.emit('error', enoentErr);
        });
        return { id: 103, process: emitter };
      },
    };

    const enoentService = new FlutterService(mockEnoentManager);

    await assert.rejects(
      async () => {
        await enoentService.startWebPreview(tmp);
      },
      (err: Error) => {
        assert.equal(err.message, FLUTTER_SDK_NOT_FOUND_MSG);
        return true;
      },
      'startWebPreview formats ENOENT error event as FLUTTER_SDK_NOT_FOUND_MSG'
    );

  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log('  🟢 All Flutter service and template tests passed.');
}
