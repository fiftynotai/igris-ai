import 'dart:convert';

import 'package:get/get.dart';
import 'package:http/http.dart' as http;

import '../core/constants/api_constants.dart';

/// REST API service for all Crimson Arena dashboard HTTP calls.
///
/// Wraps the `http` package. Since the Flutter Web app is served from
/// the same origin as the dashboard server, we use [Uri.base.origin]
/// as the base URL.
///
/// All methods return parsed JSON maps or `null` on failure.
class BrainApiService extends GetxService {
  final http.Client _client = http.Client();

  /// Base URL derived from the current browser origin.
  String get _baseUrl => Uri.base.origin;

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  Future<Map<String, dynamic>?> _getJson(String path,
      {Map<String, String>? queryParams}) async {
    try {
      final uri = Uri.parse('$_baseUrl$path').replace(
        queryParameters: queryParams,
      );
      final response = await _client.get(uri);
      if (response.statusCode != 200) return null;
      final decoded = jsonDecode(response.body);
      if (decoded is Map<String, dynamic>) return decoded;
      return null;
    } catch (_) {
      return null;
    }
  }

  Future<List<Map<String, dynamic>>> _getJsonList(String path,
      {Map<String, String>? queryParams}) async {
    try {
      final uri = Uri.parse('$_baseUrl$path').replace(
        queryParameters: queryParams,
      );
      final response = await _client.get(uri);
      if (response.statusCode != 200) return [];
      final decoded = jsonDecode(response.body);
      if (decoded is List) {
        return decoded.cast<Map<String, dynamic>>();
      }
      return [];
    } catch (_) {
      return [];
    }
  }

  // ---------------------------------------------------------------------------
  // State & Agents
  // ---------------------------------------------------------------------------

  /// Fetch full dashboard state filtered by time range.
  Future<Map<String, dynamic>?> getState({String range = 'today'}) =>
      _getJson(ApiConstants.state, queryParams: {'range': range});

  /// Fetch agent summary with levels and RPG stats.
  Future<Map<String, dynamic>?> getAgents({String range = 'today'}) =>
      _getJson(ApiConstants.agents, queryParams: {'range': range});

  // ---------------------------------------------------------------------------
  // Budget & Pricing
  // ---------------------------------------------------------------------------

  /// Fetch today's budget consumption vs ceiling.
  Future<Map<String, dynamic>?> getBudget() =>
      _getJson(ApiConstants.budget);

  /// Fetch Claude model pricing map.
  Future<Map<String, dynamic>?> getPricing() =>
      _getJson(ApiConstants.pricing);

  // ---------------------------------------------------------------------------
  // Events
  // ---------------------------------------------------------------------------

  /// Fetch recent events (battle log).
  Future<List<Map<String, dynamic>>> getEvents({
    int limit = 50,
    String range = 'today',
  }) =>
      _getJsonList(
        ApiConstants.events,
        queryParams: {'limit': limit.toString(), 'range': range},
      );

  // ---------------------------------------------------------------------------
  // Brain Proxy
  // ---------------------------------------------------------------------------

  /// Fetch brain health and stats.
  Future<Map<String, dynamic>?> getBrainHealth() =>
      _getJson(ApiConstants.brainHealth);

  /// Fetch active brain instances.
  Future<Map<String, dynamic>?> getBrainInstances() =>
      _getJson(ApiConstants.brainInstances);

  /// Fetch per-instance agent stats.
  Future<Map<String, dynamic>?> getInstanceAgents(String instanceId) =>
      _getJson(ApiConstants.instanceAgents(instanceId));

  /// Fetch per-instance execution log.
  Future<List<Map<String, dynamic>>> getInstanceLog(
    String instanceId, {
    int limit = 50,
  }) =>
      _getJsonList(
        ApiConstants.instanceLog(instanceId),
        queryParams: {'limit': limit.toString()},
      );

  /// Fetch cross-instance agent performance summary.
  Future<Map<String, dynamic>?> getAgentMetricsSummary() =>
      _getJson(ApiConstants.agentMetricsSummary);

  /// Fetch registered projects.
  Future<Map<String, dynamic>?> getBrainProjects() =>
      _getJson(ApiConstants.brainProjects);

  /// Fetch briefs, optionally filtered.
  Future<Map<String, dynamic>?> getBrainBriefs({
    String? status,
    String? project,
  }) {
    final params = <String, String>{};
    if (status != null) params['status'] = status;
    if (project != null) params['project'] = project;
    return _getJson(
      ApiConstants.brainBriefs,
      queryParams: params.isNotEmpty ? params : null,
    );
  }

  /// Fetch recent sessions.
  Future<Map<String, dynamic>?> getBrainSessions({int days = 7}) =>
      _getJson(
        ApiConstants.brainSessions,
        queryParams: {'days': days.toString()},
      );

  // ---------------------------------------------------------------------------
  // Dashboard-specific
  // ---------------------------------------------------------------------------

  /// Fetch sync pipeline status.
  Future<Map<String, dynamic>?> getSyncStatus() =>
      _getJson(ApiConstants.syncStatus);

  /// Fetch team mode status.
  Future<Map<String, dynamic>?> getTeamStatus() =>
      _getJson(ApiConstants.teamStatus);

  /// Fetch knowledge base state.
  Future<Map<String, dynamic>?> getBrainKnowledge() =>
      _getJson(ApiConstants.brainKnowledge);

  /// Fetch skill invocation heatmap.
  Future<Map<String, dynamic>?> getSkillHeatmap({String range = 'all'}) =>
      _getJson(ApiConstants.skillHeatmap, queryParams: {'range': range});

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------

  @override
  void onClose() {
    _client.close();
    super.onClose();
  }
}
