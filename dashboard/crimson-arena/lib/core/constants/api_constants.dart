/// API endpoint constants for the Crimson Arena dashboard server.
///
/// All paths are relative to the server origin. The Flutter Web app
/// is served from the same origin so these resolve correctly.
class ApiConstants {
  ApiConstants._();

  // ---------------------------------------------------------------------------
  // Base paths
  // ---------------------------------------------------------------------------

  static const String apiBase = '/api';
  static const String wsPath = '/ws';

  // ---------------------------------------------------------------------------
  // REST endpoints
  // ---------------------------------------------------------------------------

  static const String state = '$apiBase/state';
  static const String agents = '$apiBase/agents';
  static const String budget = '$apiBase/budget';
  static const String events = '$apiBase/events';
  static const String pricing = '$apiBase/pricing';

  // Brain proxy endpoints
  static const String brainHealth = '$apiBase/brain/health';
  static const String brainInstances = '$apiBase/brain/instances';
  static const String brainProjects = '$apiBase/brain/projects';
  static const String brainBriefs = '$apiBase/brain/briefs';
  static const String brainSessions = '$apiBase/brain/sessions';
  static const String brainKnowledge = '$apiBase/brain/knowledge';
  static const String agentMetricsSummary =
      '$apiBase/brain/agent-metrics/summary';

  // Dashboard-specific endpoints
  static const String syncStatus = '$apiBase/sync-status';
  static const String teamStatus = '$apiBase/team-status';
  static const String skillHeatmap = '$apiBase/skills';

  // ---------------------------------------------------------------------------
  // Dynamic endpoints
  // ---------------------------------------------------------------------------

  /// Per-instance aggregated agent stats.
  static String instanceAgents(String id) =>
      '$apiBase/brain/instances/$id/agents';

  /// Per-instance execution event log.
  static String instanceLog(String id) => '$apiBase/brain/instances/$id/log';

  /// Per-instance detail.
  static String instanceDetail(String id) => '$apiBase/brain/instances/$id';

  // ---------------------------------------------------------------------------
  // Polling intervals (milliseconds)
  // ---------------------------------------------------------------------------

  /// Main state polling interval.
  static const int stateInterval = 10000; // 10s

  /// Brain instance list polling interval.
  static const int instanceInterval = 30000; // 30s

  /// Brain health polling interval.
  static const int healthInterval = 60000; // 60s

  /// WebSocket reconnect delay.
  static const int wsReconnectDelay = 5000; // 5s

  /// WebSocket ping interval.
  static const int wsPingInterval = 30000; // 30s
}
