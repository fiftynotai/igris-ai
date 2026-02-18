import 'package:get/get.dart';

import '../../../core/constants/agent_skill_trees.dart';
import '../../../data/models/agent_model.dart';
import '../../../services/brain_api_service.dart';
import '../../../services/brain_websocket_service.dart';

/// ViewModel for the Agents page.
///
/// Manages the agent roster with levels, RPG stats, performance metrics,
/// skill tree progress, comparison mode, and cross-instance agent metrics
/// summary from the brain server.
class AgentsViewModel extends GetxController {
  final BrainApiService _apiService = Get.find();
  final BrainWebSocketService _wsService = Get.find();

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------

  /// Parsed agent models indexed by agent name.
  final RxMap<String, AgentModel> agents = <String, AgentModel>{}.obs;

  /// Current time range filter.
  final RxString currentRange = 'all'.obs;

  /// Loading flag.
  final RxBool isLoading = true.obs;

  /// Selected agent name for detail panel (null = no selection).
  final RxnString selectedAgent = RxnString();

  /// Agent being compared against the selected agent.
  final RxnString comparedAgent = RxnString();

  /// Comparison mode (show side-by-side agent comparison).
  final RxBool comparisonMode = false.obs;

  /// Cross-instance agent metrics summary from brain.
  final Rx<Map<String, dynamic>?> agentMetricsSummary =
      Rx<Map<String, dynamic>?>(null);

  /// Unlocked skill IDs per agent (computed from invocation thresholds).
  final RxMap<String, Set<String>> skillProgress =
      <String, Set<String>>{}.obs;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onInit() {
    super.onInit();
    _fetchAllData();
    _setupWebSocketListeners();
  }

  // ---------------------------------------------------------------------------
  // Data fetching
  // ---------------------------------------------------------------------------

  Future<void> _fetchAllData() async {
    isLoading.value = true;
    await Future.wait([
      _fetchAgents(),
      _fetchAgentMetricsSummary(),
    ]);
    _computeSkillProgress();
    isLoading.value = false;
  }

  Future<void> _fetchAgents() async {
    final data = await _apiService.getAgents(range: currentRange.value);
    if (data != null) {
      agents.clear();
      for (final entry in data.entries) {
        if (entry.value is Map<String, dynamic>) {
          agents[entry.key] = AgentModel.fromJson(
            entry.key,
            entry.value as Map<String, dynamic>,
          );
        }
      }
    }
  }

  Future<void> _fetchAgentMetricsSummary() async {
    final data = await _apiService.getAgentMetricsSummary();
    if (data != null) {
      agentMetricsSummary.value = data;
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket listeners
  // ---------------------------------------------------------------------------

  void _setupWebSocketListeners() {
    // Full state updates include agents
    ever(_wsService.state, (Map<String, dynamic>? wsState) {
      if (wsState != null) {
        final agentsData = wsState['agents'] as Map<String, dynamic>?;
        if (agentsData != null) {
          agents.clear();
          for (final entry in agentsData.entries) {
            if (entry.value is Map<String, dynamic>) {
              agents[entry.key] = AgentModel.fromJson(
                entry.key,
                entry.value as Map<String, dynamic>,
              );
            }
          }
          _computeSkillProgress();
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Skill progress computation
  // ---------------------------------------------------------------------------

  /// Compute unlocked skills for each agent based on invocation thresholds.
  void _computeSkillProgress() {
    final updated = <String, Set<String>>{};
    for (final agentName in AgentSkillTrees.all.keys) {
      final agent = agents[agentName];
      final invocations = agent?.invocations ?? 0;
      final maxTier = AgentSkillTrees.maxUnlockedTier(invocations);
      final skills = AgentSkillTrees.all[agentName] ?? [];
      final unlocked = <String>{};
      for (final skill in skills) {
        if (skill.tier <= maxTier) {
          unlocked.add(skill.id);
        }
      }
      updated[agentName] = unlocked;
    }
    skillProgress.assignAll(updated);
  }

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  /// Refresh all agent data.
  Future<void> refreshData() => _fetchAllData();

  /// Change the time range filter and refresh.
  void setRange(String range) {
    currentRange.value = range;
    _fetchAllData();
  }

  /// Select an agent for the detail panel.
  void selectAgent(String agentName) {
    if (selectedAgent.value == agentName) {
      selectedAgent.value = null;
      comparisonMode.value = false;
      comparedAgent.value = null;
    } else {
      selectedAgent.value = agentName;
      // If in comparison mode, set as compared agent instead
      if (comparisonMode.value && comparedAgent.value == null) {
        comparedAgent.value = agentName;
      }
    }
  }

  /// Toggle comparison mode.
  void toggleComparisonMode() {
    comparisonMode.value = !comparisonMode.value;
    if (!comparisonMode.value) {
      comparedAgent.value = null;
    }
  }

  /// Start comparing against a specific agent.
  void startCompare(String agentName) {
    comparedAgent.value = agentName;
  }

  /// Clear the comparison target.
  void clearCompare() {
    comparedAgent.value = null;
  }

  /// Clear agent selection and exit comparison mode.
  void clearSelection() {
    selectedAgent.value = null;
    comparisonMode.value = false;
    comparedAgent.value = null;
  }

  // ---------------------------------------------------------------------------
  // Computed properties
  // ---------------------------------------------------------------------------

  /// Get the selected agent model.
  AgentModel? get selectedAgentModel {
    final name = selectedAgent.value;
    if (name == null) return null;
    return agents[name];
  }

  /// Get the compared agent model.
  AgentModel? get comparedAgentModel {
    final name = comparedAgent.value;
    if (name == null) return null;
    return agents[name];
  }

  /// Total invocations across all agents.
  int get totalInvocations {
    int total = 0;
    for (final agent in agents.values) {
      total += agent.invocations;
    }
    return total;
  }

  /// Total unlocked skills across all agents.
  int get totalUnlockedSkills {
    int total = 0;
    for (final skills in skillProgress.values) {
      total += skills.length;
    }
    return total;
  }

  /// Total possible skills across all agents.
  int get totalPossibleSkills {
    int total = 0;
    for (final skills in AgentSkillTrees.all.values) {
      total += skills.length;
    }
    return total;
  }
}
