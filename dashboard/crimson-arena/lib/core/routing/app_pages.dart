import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:get/get.dart';

import '../../features/achievements/bindings/achievements_bindings.dart';
import '../../features/achievements/views/achievements_page.dart';
import '../../features/agents/bindings/agents_bindings.dart';
import '../../features/agents/views/agents_page.dart';
import '../../features/home/bindings/home_bindings.dart';
import '../../features/home/views/home_page.dart';
import '../../features/instances/bindings/instances_bindings.dart';
import '../../features/instances/views/instances_page.dart';
import '../../features/skills/bindings/skills_bindings.dart';
import '../../features/skills/views/skills_page.dart';
import '../../shared/widgets/slide_page_transition.dart';
import 'app_routes.dart';

/// GetX page definitions for the Crimson Arena dashboard.
///
/// Each page binds its own ViewModel via a [Bindings] class.
/// Uses [SlidePageTransition] for kinetic slide-from-right navigation.
/// Duration: [FiftyMotion.compiling] (300ms) with [FiftyMotion.enter] curve.
///
/// FDL rule: NO FADES -- slides only.
class AppPages {
  AppPages._();

  static final _transition = SlidePageTransition();

  static final pages = <GetPage>[
    GetPage(
      name: AppRoutes.home,
      page: () => const HomePage(),
      binding: HomeBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
    GetPage(
      name: AppRoutes.instances,
      page: () => const InstancesPage(),
      binding: InstancesBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
    GetPage(
      name: AppRoutes.instanceDetail,
      page: () => const InstancesPage(),
      binding: InstancesBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
    GetPage(
      name: AppRoutes.agents,
      page: () => const AgentsPage(),
      binding: AgentsBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
    GetPage(
      name: AppRoutes.achievements,
      page: () => const AchievementsPage(),
      binding: AchievementsBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
    GetPage(
      name: AppRoutes.skills,
      page: () => const SkillsPage(),
      binding: SkillsBindings(),
      customTransition: _transition,
      transitionDuration: FiftyMotion.compiling,
    ),
  ];
}
