import { expoCheckProblems, npmLsProblems } from '../../../apps/desktop/src/main/services/build-deps-check';

/** The dependency check before a Cloud Build upload: which npm ls / expo install --check lines are problems. */
export default async function run() {
  console.log('  [deps] npm ls --depth=0: unmet peer dependencies (what makes the server npm ci fail with ERESOLVE)...');
  const npmLs = [
    'my-app@1.0.0 C:\\p\\my-app',
    '├── @react-navigation/bottom-tabs@7.21.0',
    '├── expo@51.0.39',
    '├── react-native-screens@3.31.1 invalid: ">= 4.0.0" from node_modules/@react-navigation/bottom-tabs',
    '└── UNMET DEPENDENCY react-native-safe-area-context@^4.10.0',
    '',
    'npm error code ELSPROBLEMS',
    'npm error invalid: react-native-screens@3.31.1 C:\\p\\my-app\\node_modules\\react-native-screens',
  ].join('\r\n');
  const problems = npmLsProblems(npmLs);
  const want = [
    'react-native-screens@3.31.1 invalid: ">= 4.0.0" from node_modules/@react-navigation/bottom-tabs',
    'UNMET DEPENDENCY react-native-safe-area-context@^4.10.0',
  ];
  if (JSON.stringify(problems) !== JSON.stringify(want)) throw new Error(`npmLsProblems: ${JSON.stringify(problems)}`);
  if (npmLsProblems('my-app@1.0.0 /p\n└── expo@51.0.39\n').length !== 0) throw new Error('A clean tree has no problems');

  console.log('  [deps] npx expo install --check: packages that do not match the SDK...');
  const expo = [
    'The following packages should be updated for best compatibility with the installed expo version:',
    '  expo-font@58.0.11 - expected version: ~12.0.10',
    '  react-native-screens@4.0.0 - expected version: 3.31.1',
    'Your project may not work correctly until you install the expected versions of the packages.',
  ].join('\n');
  const sdk = expoCheckProblems(expo);
  if (JSON.stringify(sdk) !== JSON.stringify([
    'expo-font@58.0.11 (the Expo SDK expects ~12.0.10)',
    'react-native-screens@4.0.0 (the Expo SDK expects 3.31.1)',
  ])) throw new Error(`expoCheckProblems: ${JSON.stringify(sdk)}`);
  if (expoCheckProblems('Dependencies are up to date').length !== 0) throw new Error('Up to date has no problems');

  console.log('  v Build dependency check tests passed.');
}
