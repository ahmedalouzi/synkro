export interface TemplateFile {
  relativePath: string;
  content: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  files: TemplateFile[];
}

export const PROJECT_TEMPLATES: ProjectTemplate[] = [
  {
    id: 'blank',
    name: 'Blank',
    description: 'A minimal Flutter app with no customizations.',
    files: [
      {
        relativePath: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';

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
`,
      },
    ],
  },
  {
    id: 'material-app',
    name: 'Material App',
    description: 'Material 3 theme with a welcome home screen.',
    files: [
      {
        relativePath: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';

void main() {
  runApp(const AtomvsMaterialApp());
}

class AtomvsMaterialApp extends StatelessWidget {
  const AtomvsMaterialApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Atomvs App',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF6750A4)),
        useMaterial3: true,
      ),
      home: const HomeScreen(),
    );
  }
}

class HomeScreen extends StatelessWidget {
  const HomeScreen({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(title: const Text('Welcome')),
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Icon(Icons.flutter_dash, size: 72, color: Theme.of(context).colorScheme.primary),
            const SizedBox(height: 16),
            Text('Your app is ready', style: Theme.of(context).textTheme.headlineSmall),
            const SizedBox(height: 8),
            Text('Start building with Atomvs', style: Theme.of(context).textTheme.bodyMedium),
          ],
        ),
      ),
    );
  }
}
`,
      },
    ],
  },
  {
    id: 'bottom-nav',
    name: 'Bottom Navigation',
    description: 'Material 3 app with bottom navigation and three tabs.',
    files: [
      {
        relativePath: 'lib/main.dart',
        content: `import 'package:flutter/material.dart';

void main() {
  runApp(const AtomvsNavApp());
}

class AtomvsNavApp extends StatelessWidget {
  const AtomvsNavApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Atomvs Nav App',
      debugShowCheckedModeBanner: false,
      theme: ThemeData(
        colorScheme: ColorScheme.fromSeed(seedColor: const Color(0xFF006874)),
        useMaterial3: true,
      ),
      home: const RootShell(),
    );
  }
}

class RootShell extends StatefulWidget {
  const RootShell({super.key});

  @override
  State<RootShell> createState() => _RootShellState();
}

class _RootShellState extends State<RootShell> {
  int _index = 0;

  static const _tabs = [
    _TabData('Home', Icons.home_outlined, Icons.home),
    _TabData('Explore', Icons.explore_outlined, Icons.explore),
    _TabData('Profile', Icons.person_outline, Icons.person),
  ];

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: IndexedStack(
        index: _index,
        children: [
          _TabPage(title: 'Home', icon: Icons.home),
          _TabPage(title: 'Explore', icon: Icons.explore),
          _TabPage(title: 'Profile', icon: Icons.person),
        ],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _index,
        onDestinationSelected: (i) => setState(() => _index = i),
        destinations: [
          for (final tab in _tabs)
            NavigationDestination(icon: Icon(tab.icon), selectedIcon: Icon(tab.selectedIcon), label: tab.label),
        ],
      ),
    );
  }
}

class _TabData {
  const _TabData(this.label, this.icon, this.selectedIcon);
  final String label;
  final IconData icon;
  final IconData selectedIcon;
}

class _TabPage extends StatelessWidget {
  const _TabPage({required this.title, required this.icon});

  final String title;
  final IconData icon;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        children: [
          Icon(icon, size: 64, color: Theme.of(context).colorScheme.primary),
          const SizedBox(height: 12),
          Text(title, style: Theme.of(context).textTheme.headlineSmall),
        ],
      ),
    );
  }
}
`,
      },
    ],
  },
  {
    id: 'blank-rn',
    name: 'Blank React Native',
    description: 'Minimal React Native component using TypeScript and StyleSheet.',
    files: [
      {
        relativePath: 'App.tsx',
        content: `import { StyleSheet, Text, View } from 'react-native';

export default function App() {
  return (
    <View style={styles.container}>
      <Text style={styles.title}>Welcome to React Native</Text>
      <Text style={styles.subtitle}>Open App.tsx to start editing.</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
    alignItems: 'center',
    justifyContent: 'center',
  },
  title: {
    fontSize: 20,
    fontWeight: 'bold',
    color: '#f0f6fc',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 14,
    color: '#8b949e',
  },
});
`,
      },
    ],
  },
  {
    id: 'rn-tabs',
    name: 'React Native Tabs',
    description: 'React Native app with tab bar navigation and active screen states.',
    files: [
      {
        relativePath: 'App.tsx',
        content: `import { StyleSheet, View, Text, SafeAreaView, Pressable } from 'react-native';
import { useState } from 'react';

const TABS = ['Home', 'Search', 'Profile'] as const;
type Tab = (typeof TABS)[number];

export default function App() {
  const [activeTab, setActiveTab] = useState<Tab>('Home');

  return (
    <SafeAreaView style={styles.container}>
      <View style={styles.screen}>
        <Text style={styles.screenTitle}>{activeTab}</Text>
        <Text style={styles.screenSub}>This is the {activeTab} screen</Text>
      </View>

      <View style={styles.tabBar}>
        {TABS.map((tab) => (
          <Pressable
            key={tab}
            style={styles.tabItem}
            onPress={() => setActiveTab(tab)}
          >
            <Text style={[styles.tabLabel, activeTab === tab && styles.tabLabelActive]}>
              {tab === 'Home' ? '🏠' : tab === 'Search' ? '🔍' : '👤'}
            </Text>
            <Text style={[styles.tabText, activeTab === tab && styles.tabTextActive]}>
              {tab}
            </Text>
          </Pressable>
        ))}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0d1117',
  },
  screen: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: 24,
  },
  screenTitle: {
    fontSize: 26,
    fontWeight: '700',
    color: '#f0f6fc',
    marginBottom: 8,
  },
  screenSub: {
    fontSize: 14,
    color: '#6e7681',
  },
  tabBar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    borderTopColor: '#21262d',
    backgroundColor: '#161b22',
  },
  tabItem: {
    flex: 1,
    alignItems: 'center',
    paddingVertical: 10,
    gap: 2,
  },
  tabLabel: {
    fontSize: 20,
    opacity: 0.5,
  },
  tabLabelActive: {
    opacity: 1,
  },
  tabText: {
    fontSize: 10,
    color: '#6e7681',
  },
  tabTextActive: {
    color: '#a78bfa',
    fontWeight: '600',
  },
});
`,
      },
    ],
  },
];

export function getTemplate(id: string): ProjectTemplate | undefined {
  return PROJECT_TEMPLATES.find((t) => t.id === id);
}
