import 'package:get/get.dart';

import '../../services/brain_api_service.dart';
import '../../services/brain_cache_service.dart';
import '../../services/brain_websocket_service.dart';
import '../../services/pricing_service.dart';

/// Global dependency bindings for the Crimson Arena app.
///
/// Services registered here are permanent -- they survive page transitions
/// and are available throughout the app lifecycle.
class AppBindings extends Bindings {
  @override
  void dependencies() {
    // Cache layer (permanent -- wraps fifty_cache MemoryCacheStore)
    Get.put(BrainCacheService(), permanent: true);

    // REST API service (permanent -- handles all HTTP calls)
    Get.put(BrainApiService(), permanent: true);

    // WebSocket service (permanent -- maintains live connection)
    Get.put(BrainWebSocketService(), permanent: true);

    // Pricing calculator (permanent -- caches model pricing rates)
    Get.put(PricingService(), permanent: true);
  }
}
