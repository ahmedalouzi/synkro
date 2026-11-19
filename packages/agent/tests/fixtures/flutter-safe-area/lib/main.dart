// Test fixture for the Atomvs preview (dev/test only): a Scaffold with an AppBar and a bottom NavigationBar, as
// generated apps use them. Every 300 ms it reports to the preview host what Flutter sees (MediaQuery padding and
// viewPadding) and where the header and the navigation bar ended up, measured from the render tree.
import 'dart:async';
import 'dart:js_interop';
import 'dart:js_interop_unsafe';

import 'package:flutter/material.dart';

void main() => runApp(const FixtureApp());

final titleKey = GlobalKey();
final navKey = GlobalKey();

class FixtureApp extends StatelessWidget {
  const FixtureApp({super.key});

  @override
  Widget build(BuildContext context) =>
      const MaterialApp(debugShowCheckedModeBanner: false, home: Home());
}

class Home extends StatefulWidget {
  const Home({super.key});

  @override
  State<Home> createState() => _HomeState();
}

class _HomeState extends State<Home> {
  int index = 0;
  Timer? timer;

  @override
  void initState() {
    super.initState();
    timer = Timer.periodic(const Duration(milliseconds: 300), (_) => report());
  }

  @override
  void dispose() {
    timer?.cancel();
    super.dispose();
  }

  List<double> rect(GlobalKey key) {
    final box = key.currentContext?.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return [-1, -1];
    final top = box.localToGlobal(Offset.zero).dy;
    return [top, top + box.size.height];
  }

  void report() {
    if (!mounted) return;
    final mq = MediaQuery.of(context);
    final data = <String, Object?>{
      'type': 'fixture:flutter',
      'size': [mq.size.width, mq.size.height],
      'padding': [mq.padding.top, mq.padding.bottom, mq.padding.left, mq.padding.right],
      'viewPadding': [mq.viewPadding.top, mq.viewPadding.bottom],
      'title': rect(titleKey),
      'nav': rect(navKey),
    };
    (globalContext['parent'] as JSObject).callMethod('postMessage'.toJS, data.jsify(), '*'.toJS);
  }

  // --dart-define=MODE=broken: the user's screen (a header at the very top of the body without SafeArea, and a
  // 7-item bottom navigation with long labels): the layout check must report it.
  static const broken = String.fromEnvironment('MODE') == 'broken';

  @override
  Widget build(BuildContext context) {
    if (broken) {
      return Scaffold(
        body: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text('Merhaba, hoş geldin', key: titleKey, style: const TextStyle(fontSize: 22)),
          const Expanded(child: Center(child: Text('Etkinlikler'))),
        ]),
        bottomNavigationBar: NavigationBar(
          key: navKey,
          selectedIndex: index,
          onDestinationSelected: (i) => setState(() => index = i),
          destinations: const [
            NavigationDestination(icon: Icon(Icons.home), label: 'Ana Sayfa'),
            NavigationDestination(icon: Icon(Icons.event), label: 'Etkinlikler'),
            NavigationDestination(icon: Icon(Icons.campaign), label: 'Duyurular'),
            NavigationDestination(icon: Icon(Icons.groups), label: 'Topluluklar'),
            NavigationDestination(icon: Icon(Icons.message), label: 'Mesajlar'),
            NavigationDestination(icon: Icon(Icons.settings), label: 'Ayarlar'),
            NavigationDestination(icon: Icon(Icons.person), label: 'Profil'),
          ],
        ),
      );
    }
    return Scaffold(
      appBar: AppBar(title: Text('Ana Sayfa', key: titleKey)),
      body: const Center(child: Text('Etkinlikler')),
      bottomNavigationBar: NavigationBar(
        key: navKey,
        selectedIndex: index,
        onDestinationSelected: (i) => setState(() => index = i),
        destinations: const [
          NavigationDestination(icon: Icon(Icons.home), label: 'Ana Sayfa'),
          NavigationDestination(icon: Icon(Icons.event), label: 'Etkinlikler'),
          NavigationDestination(icon: Icon(Icons.campaign), label: 'Duyurular'),
          NavigationDestination(icon: Icon(Icons.person), label: 'Profil'),
        ],
      ),
    );
  }
}
