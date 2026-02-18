import 'package:get/get.dart';

import '../controllers/agents_view_model.dart';

/// Dependency bindings for the Agents page.
class AgentsBindings implements Bindings {
  @override
  void dependencies() {
    Get.lazyPut<AgentsViewModel>(() => AgentsViewModel(), fenix: true);
  }
}
