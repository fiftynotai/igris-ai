import 'package:get/get.dart';

import '../controllers/achievements_view_model.dart';

/// Dependency bindings for the Achievements page.
class AchievementsBindings implements Bindings {
  @override
  void dependencies() {
    Get.lazyPut<AchievementsViewModel>(
      () => AchievementsViewModel(),
      fenix: true,
    );
  }
}
