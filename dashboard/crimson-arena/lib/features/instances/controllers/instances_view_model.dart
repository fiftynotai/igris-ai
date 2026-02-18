import 'package:get/get.dart';

import '../../../core/constants/agent_constants.dart';
import '../../../data/models/agent_nexus_entry.dart';
import '../../../data/models/execution_log_entry.dart';
import '../../../data/models/instance_model.dart';
import '../../../data/models/team_status_model.dart';
import '../../../services/brain_api_service.dart';
import '../../../services/brain_websocket_service.dart';

/// ViewModel for the Instances page.
///
/// Manages the list of active brain instances and their
/// per-instance agent stats and execution logs.
class InstancesViewModel extends GetxController {
  final BrainApiService _apiService = Get.find();
  final BrainWebSocketService _wsService = Get.find();

  /// Parsed instance models.
  final RxList<InstanceModel> instances = <InstanceModel>[].obs;

  /// Currently expanded instance ID (for detail view).
  final RxnString expandedInstanceId = RxnString();

  /// Loading flag.
  final RxBool isLoading = true.obs;

  /// Per-instance agent nexus data: instanceId -> list of agent entries.
  final RxMap<String, List<AgentNexusEntry>> agentNexus =
      <String, List<AgentNexusEntry>>{}.obs;

  /// Per-instance execution logs: instanceId -> list of log entries.
  final RxMap<String, List<ExecutionLogEntry>> executionLogs =
      <String, List<ExecutionLogEntry>>{}.obs;

  /// Team status data from WebSocket.
  final Rx<TeamStatusModel?> teamStatus = Rx<TeamStatusModel?>(null);

  /// Per-instance retry counters: instanceId -> retry count.
  final RxMap<String, int> retryCounts = <String, int>{}.obs;

  @override
  void onInit() {
    super.onInit();
    _fetchInstances();
    _setupWebSocketListeners();
  }

  Future<void> _fetchInstances() async {
    isLoading.value = true;
    final data = await _apiService.getBrainInstances();
    if (data != null) {
      _parseInstances(data);
    }
    isLoading.value = false;
  }

  void _parseInstances(Map<String, dynamic> data) {
    final raw = data['instances'] as List<dynamic>? ?? [];
    instances.value = raw
        .map((e) => InstanceModel.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Future<void> refreshData() => _fetchInstances();

  void _setupWebSocketListeners() {
    // Listen for full instance list updates.
    ever(_wsService.brainInstances, (Map<String, dynamic>? data) {
      if (data != null) {
        _parseInstances(data);
      }
    });

    // Listen for per-instance agent execution events.
    ever(_wsService.instanceAgentEvent, (Map<String, dynamic>? data) {
      if (data != null) {
        _handleAgentEvent(data);
      }
    });

    // Listen for team status updates.
    ever(_wsService.teamStatus, (Map<String, dynamic>? data) {
      if (data != null) {
        teamStatus.value = TeamStatusModel.fromJson(data);
      }
    });
  }

  void _handleAgentEvent(Map<String, dynamic> data) {
    final instanceId = data['instance_id'] as String? ?? '';
    if (instanceId.isEmpty) return;

    // Parse and append execution log entry.
    final entry = ExecutionLogEntry.fromJson(data);
    final logs = executionLogs[instanceId] ?? [];
    logs.add(entry);

    // Keep only the latest 50 entries per instance.
    if (logs.length > AgentConstants.maxBattleLog) {
      logs.removeRange(0, logs.length - AgentConstants.maxBattleLog);
    }
    executionLogs[instanceId] = List.from(logs);

    // Update agent nexus for this instance.
    _updateNexusFromEvent(instanceId, data);

    // Track retries.
    if (entry.eventType == 'retry') {
      retryCounts[instanceId] = (retryCounts[instanceId] ?? 0) + 1;
    }
  }

  void _updateNexusFromEvent(String instanceId, Map<String, dynamic> data) {
    final agent = data['agent'] as String? ?? '';
    final eventType = data['event_type'] as String? ?? '';
    final durationMs = data['duration_ms'] as int? ?? 0;
    final inputTokens = data['input_tokens'] as int? ?? 0;
    final outputTokens = data['output_tokens'] as int? ?? 0;

    final entries =
        List<AgentNexusEntry>.from(agentNexus[instanceId] ?? []);

    // Find or create entry for this agent.
    final idx = entries.indexWhere((e) => e.agent == agent);
    if (idx >= 0) {
      final existing = entries[idx];
      String newStatus;
      switch (eventType) {
        case 'start':
          newStatus = 'WORKING';
        case 'stop':
          newStatus = data['result'] == 'success' || data['result'] == 'APPROVE'
              ? 'DONE'
              : 'FAIL';
        case 'error':
          newStatus = 'FAIL';
        default:
          newStatus = existing.status ?? 'IDLE';
      }
      entries[idx] = AgentNexusEntry(
        agent: agent,
        status: newStatus,
        totalDurationMs: existing.totalDurationMs + durationMs,
        totalTokens: existing.totalTokens + inputTokens + outputTokens,
        eventCount: existing.eventCount + 1,
      );
    } else {
      entries.add(AgentNexusEntry(
        agent: agent,
        status: eventType == 'start' ? 'WORKING' : 'IDLE',
        totalDurationMs: durationMs,
        totalTokens: inputTokens + outputTokens,
        eventCount: 1,
      ));
    }

    agentNexus[instanceId] = entries;
  }

  /// Expand or collapse an instance detail view.
  void toggleInstance(String instanceId) {
    if (expandedInstanceId.value == instanceId) {
      expandedInstanceId.value = null;
    } else {
      expandedInstanceId.value = instanceId;
      _fetchInstanceDetail(instanceId);
    }
  }

  /// Fetch detailed data for an expanded instance.
  Future<void> _fetchInstanceDetail(String instanceId) async {
    // Fetch agent nexus data.
    final agentData = await _apiService.getInstanceAgents(instanceId);
    if (agentData != null) {
      final raw = agentData['agents'] as List<dynamic>? ?? [];
      agentNexus[instanceId] =
          raw.map((e) => AgentNexusEntry.fromJson(e as Map<String, dynamic>)).toList();
    }

    // Fetch execution log.
    final logData = await _apiService.getInstanceLog(instanceId);
    executionLogs[instanceId] =
        logData.map((e) => ExecutionLogEntry.fromJson(e)).toList();
  }

  /// Expand a specific instance by ID (for deep linking).
  void expandInstance(String instanceId) {
    expandedInstanceId.value = instanceId;
    _fetchInstanceDetail(instanceId);
  }

  /// Number of active instances.
  int get activeCount => instances.where((i) => i.isActive).length;

  /// Number of idle instances.
  int get idleCount => instances.where((i) => !i.isActive).length;
}
