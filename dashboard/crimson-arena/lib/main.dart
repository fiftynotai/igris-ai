import 'package:fifty_theme/fifty_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter_web_plugins/url_strategy.dart';
import 'package:get/get.dart';

import 'core/bindings/app_bindings.dart';
import 'core/routing/app_pages.dart';
import 'core/routing/app_routes.dart';

void main() {
  // Use path URL strategy for clean URLs on web.
  usePathUrlStrategy();

  runApp(const CrimsonArenaApp());
}

/// Root widget for the Crimson Arena dashboard.
///
/// Uses [GetMaterialApp] for routing and DI. Theme is driven by
/// [FiftyTheme.dark()] from the fifty_theme package (FDL v2).
/// Dark mode is the primary (and only) environment.
class CrimsonArenaApp extends StatelessWidget {
  const CrimsonArenaApp({super.key});

  @override
  Widget build(BuildContext context) {
    return GetMaterialApp(
      title: 'CRIMSON ARENA',
      debugShowCheckedModeBanner: false,

      // FDL v2 dark theme from fifty_theme package.
      theme: FiftyTheme.dark(),
      darkTheme: FiftyTheme.dark(),
      themeMode: ThemeMode.dark,

      // Global service bindings (BrainApiService, WS, Cache, Pricing).
      initialBinding: AppBindings(),

      // Routing configuration.
      initialRoute: AppRoutes.home,
      getPages: AppPages.pages,

      // Transitions defined per-page in AppPages (slide from right).
      // FDL rule: NO FADES -- kinetic slide transitions only.
      defaultTransition: Transition.noTransition,
    );
  }
}
