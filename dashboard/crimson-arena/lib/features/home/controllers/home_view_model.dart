import 'dart:async';

import 'package:get/get.dart';

import '../../../core/constants/agent_constants.dart';
import '../../../data/models/agent_model.dart';
import '../../../data/models/battle_log_entry.dart';
import '../../../data/models/brief_model.dart';
import '../../../data/models/budget_model.dart';
import '../../../data/models/context_window_model.dart';
import '../../../data/models/project_model.dart';
import '../../../data/models/session_model.dart';
import '../../../data/models/sync_status_model.dart';
import '../../../services/brain_api_service.dart';
import '../../../services/brain_websocket_service.dart';
import '../../../services/pricing_service.dart';

/// ViewModel for the Home page.
///
/// Manages all dashboard state: budget, context window, agents, battle log,
/// skill heatmap, brain health, brain command center data, knowledge,
/// sync status, cost estimates, and overall totals.
///
/// Data flows from two sources:
/// 1. REST polling (initial load + periodic fallback)
/// 2. WebSocket streams (real-time updates)
class HomeViewModel extends GetxController {
  final BrainApiService _apiService = Get.find();
  final BrainWebSocketService _wsService = Get.find();
  final PricingService _pricingService = Get.find();

  // ---------------------------------------------------------------------------
  // Loading state
  // ---------------------------------------------------------------------------

  /// True during initial data fetch.
  final RxBool isLoading = true.obs;

  // ---------------------------------------------------------------------------
  // Time range filter
  // ---------------------------------------------------------------------------

  /// Current time range: 'today', 'week', or 'all'.
  final RxString currentRange = 'today'.obs;

  // ---------------------------------------------------------------------------
  // Budget
  // ---------------------------------------------------------------------------

  /// Token budget consumption for the day.
  final Rx<BudgetModel?> budget = Rx<BudgetModel?>(null);

  // ---------------------------------------------------------------------------
  // Context window
  // ---------------------------------------------------------------------------

  /// Active context window state.
  final Rx<ContextWindowModel?> contextWindow = Rx<ContextWindowModel?>(null);

  // ---------------------------------------------------------------------------
  // Agents
  // ---------------------------------------------------------------------------

  /// Agent roster indexed by agent name.
  final RxMap<String, AgentModel> agents = <String, AgentModel>{}.obs;

  // ---------------------------------------------------------------------------
  // Battle log
  // ---------------------------------------------------------------------------

  /// Recent events (newest first).
  final RxList<BattleLogEntry> battleLog = <BattleLogEntry>[].obs;

  // ---------------------------------------------------------------------------
  // Skill heatmap
  // ---------------------------------------------------------------------------

  /// Skill name -> invocation count.
  final RxMap<String, int> skillHeatmap = <String, int>{}.obs;

  /// Total skill invocations.
  final RxInt skillHeatmapTotal = 0.obs;

  // ---------------------------------------------------------------------------
  // Brain health
  // ---------------------------------------------------------------------------

  /// Brain health data (version, uptime, db size, counts).
  final Rx<Map<String, dynamic>?> brainHealth = Rx<Map<String, dynamic>?>(null);

  /// Whether the brain server is reachable.
  final RxBool brainAvailable = false.obs;

  // ---------------------------------------------------------------------------
  // Brain command center (projects, briefs, sessions)
  // ---------------------------------------------------------------------------

  /// Registered projects.
  final RxList<ProjectModel> brainProjects = <ProjectModel>[].obs;

  /// Tracked briefs.
  final RxList<BriefModel> brainBriefs = <BriefModel>[].obs;

  /// Recent sessions.
  final RxList<SessionModel> brainSessions = <SessionModel>[].obs;

  // ---------------------------------------------------------------------------
  // Sync status
  // ---------------------------------------------------------------------------

  /// Sync pipeline state.
  final Rx<SyncStatusModel?> syncStatus = Rx<SyncStatusModel?>(null);

  // ---------------------------------------------------------------------------
  // Knowledge
  // ---------------------------------------------------------------------------

  /// Knowledge base counts (learnings, errors, patterns).
  final RxInt knowledgeLearnings = 0.obs;
  final RxInt knowledgeErrors = 0.obs;
  final RxInt knowledgePatterns = 0.obs;

  /// Recent knowledge entries (raw maps for display).
  final RxList<Map<String, dynamic>> knowledgeRecent =
      <Map<String, dynamic>>[].obs;

  // ---------------------------------------------------------------------------
  // Overall totals
  // ---------------------------------------------------------------------------

  /// Total invocations across all agents.
  final RxInt totalInvocations = 0.obs;

  /// Total tokens across all agents (all 4 buckets).
  final RxInt totalTokens = 0.obs;

  /// Estimated total cost for the current range.
  final RxDouble totalCost = 0.0.obs;

  /// Aggregated input tokens.
  final RxInt totalInputTokens = 0.obs;

  /// Aggregated output tokens.
  final RxInt totalOutputTokens = 0.obs;

  /// Aggregated cache read tokens.
  final RxInt totalCacheReadTokens = 0.obs;

  /// Aggregated cache create tokens.
  final RxInt totalCacheCreateTokens = 0.obs;

  // ---------------------------------------------------------------------------
  // Agent metrics summary (cross-instance)
  // ---------------------------------------------------------------------------

  /// Per-agent performance summary from brain server.
  final Rx<Map<String, dynamic>?> agentMetricsSummary =
      Rx<Map<String, dynamic>?>(null);

  // ---------------------------------------------------------------------------
  // Polling timers
  // ---------------------------------------------------------------------------

  Timer? _stateTimer;
  Timer? _healthTimer;

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onInit() {
    super.onInit();
    _fetchInitialData();
    _setupWebSocketListeners();
    _setupPollingTimers();
  }

  @override
  void onClose() {
    _stateTimer?.cancel();
    _healthTimer?.cancel();
    super.onClose();
  }

  // ---------------------------------------------------------------------------
  // Initial data fetch
  // ---------------------------------------------------------------------------

  Future<void> _fetchInitialData() async {
    isLoading.value = true;

    // Fetch pricing first so cost estimates work.
    final pricing = await _apiService.getPricing();
    if (pricing != null) {
      _pricingService.updateRates(pricing);
    }

    // Fetch all data in parallel.
    await Future.wait([
      _fetchState(),
      _fetchEvents(),
      _fetchSkillHeatmap(),
      _fetchBrainHealth(),
      _fetchSyncStatus(),
      _fetchKnowledge(),
      _fetchAgentMetricsSummary(),
    ]);

    isLoading.value = false;
  }

  // ---------------------------------------------------------------------------
  // REST data fetching
  // ---------------------------------------------------------------------------

  Future<void> _fetchState() async {
    final state = await _apiService.getState(range: currentRange.value);
    if (state != null) {
      _parseState(state);
    }
  }

  Future<void> _fetchEvents() async {
    final events = await _apiService.getEvents(
      limit: AgentConstants.maxBattleLog,
      range: currentRange.value,
    );
    battleLog.clear();
    for (final e in events) {
      battleLog.add(BattleLogEntry.fromJson(e));
    }
  }

  Future<void> _fetchSkillHeatmap() async {
    final data = await _apiService.getSkillHeatmap(
      range: currentRange.value,
    );
    if (data != null) {
      _parseSkillHeatmap(data);
    }
  }

  Future<void> _fetchBrainHealth() async {
    final data = await _apiService.getBrainHealth();
    if (data != null) {
      brainHealth.value = data;
      brainAvailable.value = true;
    }
  }

  Future<void> _fetchSyncStatus() async {
    final data = await _apiService.getSyncStatus();
    if (data != null) {
      syncStatus.value = SyncStatusModel.fromJson(data);
    }
  }

  Future<void> _fetchKnowledge() async {
    final data = await _apiService.getBrainKnowledge();
    if (data != null) {
      _parseKnowledge(data);
    }
  }

  Future<void> _fetchAgentMetricsSummary() async {
    final data = await _apiService.getAgentMetricsSummary();
    if (data != null) {
      agentMetricsSummary.value = data;
    }
  }

  // ---------------------------------------------------------------------------
  // State parsing
  // ---------------------------------------------------------------------------

  void _parseState(Map<String, dynamic> state) {
    // Budget
    final budgetData = state['budget'] as Map<String, dynamic>?;
    if (budgetData != null) {
      budget.value = BudgetModel.fromJson(budgetData);
    }

    // Context window
    final ctxData = state['context_window'] as Map<String, dynamic>?;
    if (ctxData != null) {
      contextWindow.value = ContextWindowModel.fromJson(ctxData);
    }

    // Agents
    final agentsData = state['agents'] as Map<String, dynamic>?;
    if (agentsData != null) {
      _parseAgents(agentsData);
    }

    // Totals
    final totals = state['totals'] as Map<String, dynamic>?;
    if (totals != null) {
      totalInvocations.value = totals['total_invocations'] as int? ?? 0;
    }

    // Skill heatmap from state (if included)
    final heatmapData = state['skill_heatmap'] as Map<String, dynamic>?;
    if (heatmapData != null) {
      _parseSkillHeatmap(heatmapData);
    }

    _recalculateTotals();
  }

  void _parseAgents(Map<String, dynamic> agentsData) {
    agents.clear();
    for (final entry in agentsData.entries) {
      if (entry.value is Map<String, dynamic>) {
        agents[entry.key] = AgentModel.fromJson(
          entry.key,
          entry.value as Map<String, dynamic>,
        );
      }
    }
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

  void _parseKnowledge(Map<String, dynamic> data) {
    knowledgeLearnings.value = data['learnings_count'] as int? ?? 0;
    knowledgeErrors.value = data['errors_count'] as int? ?? 0;
    knowledgePatterns.value = data['patterns_count'] as int? ?? 0;

    final recent = data['recent'] as List<dynamic>?;
    knowledgeRecent.clear();
    if (recent != null) {
      for (final item in recent) {
        if (item is Map<String, dynamic>) {
          knowledgeRecent.add(item);
        }
      }
    }
  }

  void _parseBrainState(Map<String, dynamic> data) {
    brainAvailable.value = true;

    // Health
    final health = data['health'] as Map<String, dynamic>?;
    if (health != null) {
      brainHealth.value = health;
    }

    // Projects
    final projectsData = data['projects'];
    if (projectsData != null) {
      _parseProjects(projectsData);
    }

    // Briefs
    final briefsData = data['briefs'];
    if (briefsData != null) {
      _parseBriefs(briefsData);
    }

    // Sessions
    final sessionsData = data['sessions'];
    if (sessionsData != null) {
      _parseSessions(sessionsData);
    }
  }

  void _parseProjects(dynamic data) {
    brainProjects.clear();
    List<dynamic> projectsList;
    if (data is List) {
      projectsList = data;
    } else if (data is Map<String, dynamic>) {
      projectsList = data['projects'] as List<dynamic>? ?? [];
    } else {
      return;
    }
    for (final item in projectsList) {
      if (item is Map<String, dynamic>) {
        brainProjects.add(ProjectModel.fromJson(item));
      }
    }
  }

  void _parseBriefs(dynamic data) {
    brainBriefs.clear();
    List<dynamic> briefsList;
    if (data is List) {
      briefsList = data;
    } else if (data is Map<String, dynamic>) {
      briefsList = data['briefs'] as List<dynamic>? ?? [];
    } else {
      return;
    }
    for (final item in briefsList) {
      if (item is Map<String, dynamic>) {
        brainBriefs.add(BriefModel.fromJson(item));
      }
    }
  }

  void _parseSessions(dynamic data) {
    brainSessions.clear();
    List<dynamic> sessionsList;
    if (data is List) {
      sessionsList = data;
    } else if (data is Map<String, dynamic>) {
      sessionsList = data['sessions'] as List<dynamic>? ?? [];
    } else {
      return;
    }
    for (final item in sessionsList) {
      if (item is Map<String, dynamic>) {
        brainSessions.add(SessionModel.fromJson(item));
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Totals recalculation
  // ---------------------------------------------------------------------------

  void _recalculateTotals() {
    int inputTok = 0;
    int outputTok = 0;
    int cacheReadTok = 0;
    int cacheCreateTok = 0;
    int invocations = 0;

    for (final agent in agents.values) {
      inputTok += agent.totalInputTokens;
      outputTok += agent.totalOutputTokens;
      cacheReadTok += agent.totalCacheReadTokens;
      cacheCreateTok += agent.totalCacheCreateTokens;
      invocations += agent.invocations;
    }

    totalInputTokens.value = inputTok;
    totalOutputTokens.value = outputTok;
    totalCacheReadTokens.value = cacheReadTok;
    totalCacheCreateTokens.value = cacheCreateTok;
    totalTokens.value = inputTok + outputTok + cacheReadTok + cacheCreateTok;
    if (totalInvocations.value == 0) {
      totalInvocations.value = invocations;
    }

    // Cost estimate
    final modelId = contextWindow.value?.modelId ?? '';
    final cost = _pricingService.calculateCost(
      inputTokens: inputTok,
      outputTokens: outputTok,
      cacheRead: cacheReadTok,
      cacheCreate: cacheCreateTok,
      modelId: modelId,
    );
    totalCost.value = cost?.total ?? 0.0;
  }

  // ---------------------------------------------------------------------------
  // Cost estimate helpers (exposed for cost card widget)
  // ---------------------------------------------------------------------------

  /// Get the full cost breakdown for the current token totals.
  CostEstimate? get costEstimate {
    final modelId = contextWindow.value?.modelId ?? '';
    return _pricingService.calculateCost(
      inputTokens: totalInputTokens.value,
      outputTokens: totalOutputTokens.value,
      cacheRead: totalCacheReadTokens.value,
      cacheCreate: totalCacheCreateTokens.value,
      modelId: modelId,
    );
  }

  /// Whether pricing data is available.
  bool get hasPricing => _pricingService.hasRates;

  /// Get rates for display.
  PricingModel? get currentRates {
    final modelId = contextWindow.value?.modelId ?? '';
    return _pricingService.getRatesForModel(modelId);
  }

  /// Model short name for display.
  String get modelShortName {
    return contextWindow.value?.modelShortName ?? 'Unknown';
  }

  /// Range display label.
  String get rangeLabel {
    switch (currentRange.value) {
      case 'today':
        return 'Today';
      case 'week':
        return 'This Week';
      case 'all':
        return 'All Time';
      default:
        return 'Today';
    }
  }

  // ---------------------------------------------------------------------------
  // WebSocket listeners
  // ---------------------------------------------------------------------------

  void _setupWebSocketListeners() {
    // Full state updates
    ever(_wsService.state, (Map<String, dynamic>? wsState) {
      if (wsState != null) {
        _parseState(wsState);
      }
    });

    // Brain state composite
    ever(_wsService.brainState, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseBrainState(data);
      }
    });

    // Brain health
    ever(_wsService.brainHealth, (Map<String, dynamic>? data) {
      if (data != null) {
        brainHealth.value = data;
        brainAvailable.value = true;
      }
    });

    // Brain projects
    ever(_wsService.brainProjects, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseProjects(data);
      }
    });

    // Brain briefs
    ever(_wsService.brainBriefs, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseBriefs(data);
      }
    });

    // Brain sessions
    ever(_wsService.brainSessions, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseSessions(data);
      }
    });

    // Real-time event stream -> prepend to battle log
    ever(_wsService.eventStream, (List<Map<String, dynamic>> events) {
      if (events.isNotEmpty) {
        final latest = events.last;
        final entry = BattleLogEntry.fromJson(latest);
        battleLog.insert(0, entry);
        // Trim to max
        while (battleLog.length > AgentConstants.maxBattleLog) {
          battleLog.removeLast();
        }
      }
    });

    // Sync status
    ever(_wsService.syncStatus, (Map<String, dynamic>? data) {
      if (data != null) {
        syncStatus.value = SyncStatusModel.fromJson(data);
      }
    });

    // Knowledge state
    ever(_wsService.knowledgeState, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseKnowledge(data);
      }
    });

    // Skill events -> increment heatmap
    ever(_wsService.skillEvent, (Map<String, dynamic>? data) {
      if (data != null) {
        final skillName = data['skill_name'] as String?;
        if (skillName != null) {
          skillHeatmap[skillName] =
              (skillHeatmap[skillName] ?? 0) + 1;
          skillHeatmapTotal.value++;
        }
      }
    });
  }

  // ---------------------------------------------------------------------------
  // Polling fallback
  // ---------------------------------------------------------------------------

  void _setupPollingTimers() {
    // State polling every 10s as fallback
    _stateTimer = Timer.periodic(
      const Duration(milliseconds: 10000),
      (_) {
        if (!_wsService.isConnected.value) {
          _fetchState();
        }
      },
    );

    // Health polling every 60s
    _healthTimer = Timer.periodic(
      const Duration(milliseconds: 60000),
      (_) => _fetchBrainHealth(),
    );
  }

  // ---------------------------------------------------------------------------
  // Public actions
  // ---------------------------------------------------------------------------

  /// Refresh all data.
  Future<void> refreshData() async {
    await Future.wait([
      _fetchState(),
      _fetchEvents(),
      _fetchSkillHeatmap(),
      _fetchBrainHealth(),
      _fetchSyncStatus(),
      _fetchKnowledge(),
      _fetchAgentMetricsSummary(),
    ]);
  }

  /// Change the time range filter and refresh data.
  void setRange(String range) {
    currentRange.value = range;
    refreshData();
  }

  /// Brief status counts for display.
  Map<String, int> get briefStatusCounts {
    final counts = <String, int>{};
    for (final brief in brainBriefs) {
      counts[brief.status] = (counts[brief.status] ?? 0) + 1;
    }
    return counts;
  }
}
