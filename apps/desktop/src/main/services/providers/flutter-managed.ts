import { join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { getTemplate } from '@peep/flutter-adapter';

/**
 * Managed Flutter: a project written straight to disk, so no local Flutter SDK is needed. It has no android/
 * folder; Cloud Build runs `flutter create` in the sandbox, which adds the platform folders without touching
 * these files. Preview and analysis need a local SDK (the flutter-local provider opens the project).
 */

const BLANK_MAIN = `import 'package:flutter/material.dart';

void main() {
  runApp(const MyApp());
}

class MyApp extends StatelessWidget {
  const MyApp({super.key});

  @override
  Widget build(BuildContext context) {
    return const MaterialApp(
      debugShowCheckedModeBanner: false,
      home: Scaffold(
        body: Center(child: Text('Hello from Atomvs')),
      ),
    );
  }
}
`;

/** Exported for tests. */
export function managedFlutterFiles(name: string, templateId?: string): { relativePath: string; content: string }[] {
  const files = [
    {
      relativePath: 'pubspec.yaml',
      content: `name: ${name}
description: A Flutter app made with Atomvs.
publish_to: 'none'
version: 1.0.0+1

environment:
  sdk: ^3.5.0

dependencies:
  flutter:
    sdk: flutter
  cupertino_icons: ^1.0.8

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^5.0.0

flutter:
  uses-material-design: true
`,
    },
    { relativePath: 'analysis_options.yaml', content: 'include: package:flutter_lints/flutter.yaml\n' },
    {
      relativePath: '.gitignore',
      content: ['.dart_tool/', '.flutter-plugins', '.flutter-plugins-dependencies', '.pub-cache/', '.pub/', 'build/', ''].join('\n'),
    },
    // Without its own test, `flutter create` would add one that expects a MyApp class.
    {
      relativePath: 'test/widget_test.dart',
      content: `import 'package:flutter_test/flutter_test.dart';
import 'package:${name}/main.dart' as app;

void main() {
  testWidgets('app starts', (tester) async {
    app.main();
    await tester.pump();
  });
}
`,
    },
    { relativePath: 'lib/main.dart', content: BLANK_MAIN },
  ];
  // The chosen template replaces the defaults it ships (Material App and Bottom Navigation ship lib/main.dart).
  for (const file of getTemplate(templateId ?? '')?.files ?? []) {
    const existing = files.find((f) => f.relativePath === file.relativePath);
    if (existing) existing.content = file.content;
    else files.push({ ...file });
  }
  return files;
}

export async function createManagedFlutterProject(name: string, parentPath: string, templateId?: string): Promise<string> {
  const projectPath = join(parentPath, name);
  await mkdir(projectPath, { recursive: false });
  for (const file of managedFlutterFiles(name, templateId)) {
    const fullPath = join(projectPath, file.relativePath);
    await mkdir(join(fullPath, '..'), { recursive: true });
    await writeFile(fullPath, file.content, 'utf-8');
  }
  return projectPath;
}
