import 'package:get/get.dart';

import '../controllers/home_view_model.dart';

/// Dependency bindings for the Home page.
class HomeBindings implements Bindings {
  @override
  void dependencies() {
    Get.lazyPut<HomeViewModel>(() => HomeViewModel(), fenix: true);
  }
}
