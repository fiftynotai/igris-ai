import 'dart:convert';

import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:flutter/foundation.dart';
import 'package:get/get.dart';

import '../../../core/constants/achievement_catalog.dart';

/// ViewModel for the Achievements page.
///
/// Wraps [AchievementController] from the fifty_achievement_engine package
/// and exposes reactive state for the UI through GetX observables.
///
/// Responsibilities:
/// - Initializes the engine with the full [AchievementCatalog]
/// - Exposes filtered / sorted achievement lists
/// - Tracks events and stats that trigger unlocks
/// - Persists progress via JSON serialization (in-memory for now)
/// - Queues unlock notifications for the popup system
class AchievementsViewModel extends GetxController {
  /// The underlying achievement engine controller.
  late final AchievementController<void> engine;

  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------

  /// Loading flag while engine initializes.
  final RxBool isLoading = true.obs;

  /// Currently selected filter category. 'All' shows everything.
  final RxString filterCategory = 'All'.obs;

  /// Total earned points (reactive).
  final RxInt earnedPoints = 0.obs;

  /// Count of unlocked achievements (reactive).
  final RxInt unlockedCount = 0.obs;

  /// Total achievement count.
  int get totalCount => AchievementCatalog.count;

  /// Maximum possible points.
  int get maxPoints => AchievementCatalog.maxPoints;

  /// Queue of recently unlocked achievements waiting to be shown as popups.
  final RxList<Achievement<void>> unlockQueue = <Achievement<void>>[].obs;

  /// Bump counter to force Obx rebuilds after engine state changes.
  final RxInt _revision = 0.obs;

  // ignore: unused — accessed inside Obx to trigger rebuilds.
  int get revision => _revision.value;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onInit() {
    super.onInit();
    _initializeEngine();
  }

  @override
  void onClose() {
    engine.dispose();
    super.onClose();
  }

  // ---------------------------------------------------------------------------
  // Initialization
  // ---------------------------------------------------------------------------

  void _initializeEngine() {
    engine = AchievementController<void>(
      achievements: AchievementCatalog.all,
      onUnlock: _onUnlock,
    );

    // Attempt to load saved progress (no-op if none exists).
    _loadProgress();

    _syncReactiveState();
    isLoading.value = false;
  }

  // ---------------------------------------------------------------------------
  // Public API — event & stat tracking
  // ---------------------------------------------------------------------------

  /// Track a named event (e.g., 'hunt_complete', 'brief_registered').
  void trackEvent(String event, {int count = 1}) {
    engine.trackEvent(event, count: count);
    _syncReactiveState();
  }

  /// Set a stat to an absolute value (e.g., 'unique_agents_session' = 5).
  void updateStat(String stat, num value) {
    engine.updateStat(stat, value);
    _syncReactiveState();
  }

  /// Increment a stat by a delta (e.g., 'total_agent_invocations' += 1).
  void incrementStat(String stat, num delta) {
    engine.incrementStat(stat, delta);
    _syncReactiveState();
  }

  /// Force-unlock an achievement (bypasses conditions).
  void forceUnlock(String achievementId) {
    engine.forceUnlock(achievementId);
    _syncReactiveState();
  }

  // ---------------------------------------------------------------------------
  // Filtering
  // ---------------------------------------------------------------------------

  /// Change the active category filter.
  void filterBy(String category) {
    filterCategory.value = category;
  }

  /// Returns the list of achievements for the current filter, sorted:
  /// unlocked first, then by rarity descending, then by points descending.
  List<Achievement<void>> get filteredAchievements {
    // Access revision to register Obx dependency.
    _revision.value;

    List<Achievement<void>> list;
    if (filterCategory.value == 'All') {
      list = List<Achievement<void>>.from(engine.achievements);
    } else {
      list = engine.getByCategory(filterCategory.value);
    }

    list.sort((a, b) {
      final aUnlocked = engine.isUnlocked(a.id);
      final bUnlocked = engine.isUnlocked(b.id);

      // Unlocked first.
      if (aUnlocked && !bUnlocked) return -1;
      if (!aUnlocked && bUnlocked) return 1;

      // Then by rarity (legendary > common).
      final rarityCompare = b.rarity.index.compareTo(a.rarity.index);
      if (rarityCompare != 0) return rarityCompare;

      // Then by points descending.
      return b.points.compareTo(a.points);
    });

    return list;
  }

  /// Returns per-rarity counts of unlocked achievements.
  Map<AchievementRarity, int> get unlockedRarityBreakdown {
    _revision.value;
    final map = <AchievementRarity, int>{};
    for (final a in engine.unlockedAchievements) {
      map[a.rarity] = (map[a.rarity] ?? 0) + 1;
    }
    return map;
  }

  /// Returns progress (0.0 - 1.0) for a given achievement.
  double getProgress(String achievementId) {
    _revision.value;
    return engine.getProgress(achievementId);
  }

  /// Returns the [AchievementState] for a given achievement.
  AchievementState getState(String achievementId) {
    _revision.value;
    return engine.getState(achievementId);
  }

  /// Returns detailed progress info for a given achievement.
  AchievementProgress getProgressDetails(String achievementId) {
    _revision.value;
    return engine.getProgressDetails(achievementId);
  }

  /// Whether a specific achievement is unlocked.
  bool isUnlocked(String achievementId) {
    _revision.value;
    return engine.isUnlocked(achievementId);
  }

  // ---------------------------------------------------------------------------
  // Popup queue
  // ---------------------------------------------------------------------------

  /// Dequeue the next unlock notification (returns null if empty).
  Achievement<void>? dequeueUnlock() {
    if (unlockQueue.isEmpty) return null;
    return unlockQueue.removeAt(0);
  }

  // ---------------------------------------------------------------------------
  // Persistence (JSON — in-memory placeholder)
  // ---------------------------------------------------------------------------

  /// In-memory store for serialized progress.
  /// In production this will be replaced by brain API calls.
  static Map<String, dynamic>? _savedProgress;

  /// Export current progress as JSON.
  Map<String, dynamic> exportProgress() => engine.exportProgress();

  /// Import progress from a JSON map.
  void importProgress(Map<String, dynamic> data) {
    engine.importProgress(data);
    _syncReactiveState();
  }

  /// Save progress to in-memory store.
  void saveProgress() {
    _savedProgress = engine.exportProgress();
    if (kDebugMode) {
      // ignore: avoid_print
      print('[AchievementsVM] Progress saved: '
          '${jsonEncode(_savedProgress).length} bytes');
    }
  }

  /// Export progress as a JSON string for external persistence.
  String toJsonString() => jsonEncode(engine.exportProgress());

  /// Import progress from a JSON string.
  void fromJsonString(String json) {
    final data = jsonDecode(json) as Map<String, dynamic>;
    importProgress(data);
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  void _onUnlock(Achievement<void> achievement) {
    unlockQueue.add(achievement);
    _syncReactiveState();
    saveProgress();
  }

  void _syncReactiveState() {
    earnedPoints.value = engine.earnedPoints;
    unlockedCount.value = engine.unlockedIds.length;
    _revision.value++;
  }

  void _loadProgress() {
    if (_savedProgress != null) {
      engine.importProgress(_savedProgress!);
    }
  }
}
