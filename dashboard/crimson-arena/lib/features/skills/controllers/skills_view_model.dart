import 'package:get/get.dart';

import '../../../core/constants/skill_constants.dart';
import '../../../data/models/skill_card_model.dart';
import '../../../services/brain_api_service.dart';
import '../../../services/brain_websocket_service.dart';

/// ViewModel for the Skills page.
///
/// Fetches skill heatmap data from the brain API, listens for real-time
/// skill invocation events via WebSocket, and merges static
/// [SkillConstants.registry] metadata with live usage counts.
///
/// Exposes a filtered + sorted list of [SkillCardModel] for the UI.
class SkillsViewModel extends GetxController {
  final BrainApiService _apiService = Get.find();
  final BrainWebSocketService _wsService = Get.find();

  // ---------------------------------------------------------------------------
  // Reactive state
  // ---------------------------------------------------------------------------

  /// Loading flag during initial data fetch.
  final RxBool isLoading = true.obs;

  /// Currently selected category filter. 'All' shows everything.
  final RxString filterCategory = 'All'.obs;

  /// Current sort mode: 'usage', 'alpha', or 'rarity'.
  final RxString sortMode = 'usage'.obs;

  /// Skill name -> invocation count (live data).
  final RxMap<String, int> skillHeatmap = <String, int>{}.obs;

  /// Total skill invocations across all skills.
  final RxInt skillHeatmapTotal = 0.obs;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onInit() {
    super.onInit();
    _fetchSkillHeatmap();
    _setupWebSocketListeners();
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  Future<void> _fetchSkillHeatmap() async {
    isLoading.value = true;
    final data = await _apiService.getSkillHeatmap(range: 'all');
    if (data != null) {
      _parseSkillHeatmap(data);
    }
    isLoading.value = false;
  }

  void _parseSkillHeatmap(Map<String, dynamic> data) {
    final skills = data['skills'] as Map<String, dynamic>?;
    if (skills != null) {
      skillHeatmap.clear();
      for (final entry in skills.entries) {
        skillHeatmap[entry.key] = (entry.value as num?)?.toInt() ?? 0;
      }
    }
    skillHeatmapTotal.value = (data['total'] as num?)?.toInt() ?? 0;
  }

  // ---------------------------------------------------------------------------
  // WebSocket listeners
  // ---------------------------------------------------------------------------

  void _setupWebSocketListeners() {
    // Skill events -> increment heatmap counts in real-time.
    ever(_wsService.skillEvent, (Map<String, dynamic>? data) {
      if (data != null) {
        final skillName = data['skill_name'] as String?;
        if (skillName != null) {
          skillHeatmap[skillName] = (skillHeatmap[skillName] ?? 0) + 1;
          skillHeatmapTotal.value++;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Card building
  // ---------------------------------------------------------------------------

  /// Build the full list of [SkillCardModel] by merging static metadata
  /// with live heatmap data.
  List<SkillCardModel> _buildCards() {
    return SkillConstants.registry.values.map((meta) {
      final invocations = skillHeatmap[meta.name] ?? 0;
      return SkillCardModel.fromMeta(meta, invocations: invocations);
    }).toList();
  }

  // ---------------------------------------------------------------------------
  // Filtered + sorted output
  // ---------------------------------------------------------------------------

  /// Returns the list of skill cards, filtered by category and sorted
  /// by the current sort mode.
  List<SkillCardModel> get filteredSkills {
    // Access reactive values to register Obx dependency.
    filterCategory.value;
    sortMode.value;
    skillHeatmap.length;

    List<SkillCardModel> cards = _buildCards();

    // Filter by category.
    if (filterCategory.value != 'All') {
      final category =
          SkillConstants.categoryFromString(filterCategory.value);
      if (category != null) {
        cards = cards.where((c) => c.category == category).toList();
      }
    }

    // Sort by mode.
    switch (sortMode.value) {
      case 'alpha':
        cards.sort((a, b) => a.name.compareTo(b.name));
      case 'rarity':
        cards.sort((a, b) {
          final rarityCompare = b.rarity.index.compareTo(a.rarity.index);
          if (rarityCompare != 0) return rarityCompare;
          return b.invocations.compareTo(a.invocations);
        });
      case 'usage':
      default:
        cards.sort((a, b) => b.invocations.compareTo(a.invocations));
    }

    return cards;
  }

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  /// Change the active category filter.
  void filterBy(String category) {
    filterCategory.value = category;
  }

  /// Change the sort mode.
  void sortBy(String mode) {
    sortMode.value = mode;
  }

  /// Refresh data from the brain API.
  Future<void> refreshData() async {
    await _fetchSkillHeatmap();
  }
}
