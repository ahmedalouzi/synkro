import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ProcessManager, escapeCmdArgument, windowsSpawnArgs, userProjectEnv } from '../../../apps/desktop/src/main/services/process-manager';
import { PlatformRegistry } from '../../../apps/desktop/src/main/services/platform-registry';
import { ProjectService } from '../../../apps/desktop/src/main/services/project-service';
import { managedFlutterFiles } from '../../../apps/desktop/src/main/services/providers/flutter-managed';

/**
 * New Project in managed mode: Flutter is written without a local SDK, .cmd tools start on Windows without
 * EINVAL and without shell injection, and a failed create leaves no folder behind.
 */
export default async function run() {
  // --- Windows command lines: .cmd/.bat and bare names go through cmd.exe with every argument quoted ---
  assert.deepEqual(windowsSpawnArgs('C:\\Program Files\\nodejs\\node.exe', ['-v']), { file: 'C:\\Program Files\\nodejs\\node.exe', args: ['-v'], verbatim: false });
  const npm = windowsSpawnArgs('npm.cmd', ['install', 'a&calc']);
  assert.deepEqual(npm.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(npm.args[3], '"npm.cmd ^"install^" ^"a^&calc^""');
  assert.equal(npm.verbatim, true);
  assert.equal(escapeCmdArgument('C:\\a b\\'), '^"C:\\a^ b\\\\^"');
  assert.equal(escapeCmdArgument('say "hi"'), '^"say^ \\^"hi\\^"^"');

  // pnpm's npm_* settings (pnpm dev) do not reach the user's npm/npx/expo processes; the rest does.
  assert.deepEqual(
    userProjectEnv({ PATH: 'p', npm_config_recursive: 'true', NPM_CONFIG_USER_AGENT: 'pnpm/9', npm_lifecycle_event: 'dev' }).env,
    { PATH: 'p' },
  );

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'managed-create-'));
  try {
    if (process.platform === 'win32') {
      // The real thing: a .cmd in a folder with a space gets every argument back unchanged, and nothing runs.
      const echo = path.join(tmp, 'echo args.cmd');
      fs.writeFileSync(echo, '@node -e "console.log(JSON.stringify(process.argv.slice(1)))" %*\r\n');
      const tricky = ['with space', 'a&echo INJECTED', 'x|y', '^caret', '%PATH%', 'say "hi"', 'C:\\dir with space\\', '@scope/pkg@^1.2.0', ''];
      const output: string = await new Promise((resolve, reject) => {
        const info = new ProcessManager().spawn(echo, tricky, tmp);
        info.process.on('error', reject);
        info.process.on('exit', () => resolve(info.stdout));
      });
      assert.deepEqual(JSON.parse(output.trim()), tricky);
    }

    // --- Managed Flutter files: a complete project without android/, the template's main.dart on top ---
    const blank = managedFlutterFiles('my_app', 'blank');
    const paths = blank.map((f) => f.relativePath).sort();
    assert.deepEqual(paths, ['.gitignore', 'analysis_options.yaml', 'lib/main.dart', 'pubspec.yaml', 'test/widget_test.dart']);
    assert.ok(blank.find((f) => f.relativePath === 'pubspec.yaml')!.content.startsWith('name: my_app\n'));
    assert.ok(blank.find((f) => f.relativePath === 'test/widget_test.dart')!.content.includes("import 'package:my_app/main.dart' as app;"));
    const material = managedFlutterFiles('my_app', 'material-app');
    assert.equal(material.length, blank.length, 'the template replaces lib/main.dart, it does not add a second one');
    assert.ok(material.find((f) => f.relativePath === 'lib/main.dart')!.content.includes('AtomvsMaterialApp'));

    // --- ProjectService: Flutter + managed does not use the React Native provider ---
    const noProviders = new ProjectService(new PlatformRegistry(), {} as any);
    const created = await noProviders.createFromTemplate({ name: 'fl_app', parentPath: tmp, templateId: 'bottom-nav', mode: 'beginner', framework: 'flutter' });
    assert.equal(created, path.join(tmp, 'fl_app'));
    assert.ok(fs.readFileSync(path.join(created, 'lib', 'main.dart'), 'utf8').includes('NavigationBar'));
    assert.ok(!fs.existsSync(path.join(created, 'android')));

    // An existing folder is refused and kept.
    fs.writeFileSync(path.join(created, 'keep.txt'), 'mine');
    await assert.rejects(noProviders.createFromTemplate({ name: 'fl_app', parentPath: tmp, templateId: 'blank', mode: 'beginner', framework: 'flutter' }), /Folder already exists/);
    assert.ok(fs.existsSync(path.join(created, 'keep.txt')));

    // A failure halfway removes the half-made folder, so the same name works on the next try.
    const failing = new PlatformRegistry();
    failing.register({
      id: 'react-native-managed',
      createProject: async (name: string, parent: string) => {
        fs.mkdirSync(path.join(parent, name));
        fs.writeFileSync(path.join(parent, name, 'package.json'), '{}');
        throw new Error('npm install failed with exit code 1');
      },
    } as any);
    const service = new ProjectService(failing, {} as any);
    const rnOptions = { name: 'rn_app', parentPath: tmp, templateId: 'blank-rn', mode: 'beginner' as const, framework: 'react-native' as const };
    await assert.rejects(service.createFromTemplate(rnOptions), /npm install failed/);
    assert.ok(!fs.existsSync(path.join(tmp, 'rn_app')), 'half-created folder removed');
    await assert.rejects(service.createFromTemplate(rnOptions), /npm install failed/, 'second try fails the same way, not with "Folder already exists"');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
