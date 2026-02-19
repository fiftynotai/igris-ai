import 'package:get/get.dart';

import '../controllers/skills_view_model.dart';

/// Dependency bindings for the Skills page.
class SkillsBindings implements Bindings {
  @override
  void dependencies() {
    Get.lazyPut<SkillsViewModel>(
      () => SkillsViewModel(),
      fenix: true,
    );
  }
}
