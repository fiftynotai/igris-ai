/// Per-agent aggregated status within a specific instance.
///
/// Used in the instance expanded view to show which agents have
/// been active and their cumulative stats for that instance.
class AgentNexusEntry {
  final String agent;
  final String? status;
  final int totalDurationMs;
  final int totalTokens;
  final int eventCount;

  const AgentNexusEntry({
    required this.agent,
    this.status,
    required this.totalDurationMs,
    required this.totalTokens,
    required this.eventCount,
  });

  factory AgentNexusEntry.fromJson(Map<String, dynamic> json) =>
      AgentNexusEntry(
        agent: json['agent'] as String? ?? '',
        status: json['status'] as String?,
        totalDurationMs: json['total_duration_ms'] as int? ?? 0,
        totalTokens: json['total_tokens'] as int? ?? 0,
        eventCount: json['event_count'] as int? ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'agent': agent,
        'status': status,
        'total_duration_ms': totalDurationMs,
        'total_tokens': totalTokens,
        'event_count': eventCount,
      };
}

extension AgentNexusEntryExtensions on AgentNexusEntry {
  /// Duration in seconds.
  double get totalDurationSeconds => totalDurationMs / 1000;

  /// Human-readable duration string.
  String get formattedDuration {
    final seconds = totalDurationSeconds;
    if (seconds < 60) return '${seconds.toStringAsFixed(0)}s';
    final minutes = (seconds / 60).floor();
    final remainingSeconds = (seconds % 60).round();
    return '${minutes}m ${remainingSeconds}s';
  }
}
