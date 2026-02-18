import 'dart:convert';

import 'package:fifty_cache/fifty_cache.dart';
import 'package:get/get.dart';

/// Cache service wrapping fifty_cache's [CacheManager] with
/// [MemoryCacheStore] for API response caching.
///
/// Default TTL:
/// - State data: 30 seconds
/// - Static data (pricing, projects): 5 minutes
class BrainCacheService extends GetxService {
  late final CacheManager _cacheManager;

  /// Default TTL for frequently changing data.
  static const Duration stateTtl = Duration(seconds: 30);

  /// Default TTL for rarely changing data.
  static const Duration staticTtl = Duration(minutes: 5);

  @override
  void onInit() {
    super.onInit();
    _cacheManager = CacheManager(
      MemoryCacheStore(),
      DefaultCacheKeyStrategy(),
      SimpleTimeToLiveCachePolicy(),
    );
  }

  /// Read a cached JSON map by key. Returns `null` if absent or expired.
  Future<Map<String, dynamic>?> get(String key) async {
    final raw = await _cacheManager.tryRead('GET', key, null);
    if (raw == null) return null;
    try {
      return jsonDecode(raw) as Map<String, dynamic>;
    } catch (_) {
      return null;
    }
  }

  /// Write a JSON map to cache with optional TTL override.
  Future<void> set(
    String key,
    Map<String, dynamic> data, {
    Duration? ttl,
  }) async {
    await _cacheManager.tryWrite(
      'GET',
      key,
      null,
      statusCode: 200,
      bodyString: jsonEncode(data),
    );
  }

  /// Remove a specific cache entry.
  Future<void> invalidate(String key) async {
    await _cacheManager.invalidate('GET', key, null);
  }

  /// Remove all cached entries.
  Future<void> clear() => _cacheManager.clear();
}
