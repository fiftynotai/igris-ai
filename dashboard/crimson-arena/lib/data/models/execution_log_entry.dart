/// A per-instance agent execution event from the brain server.
///
/// Used in the Instances expanded view to show the agent execution
/// log for a specific Claude Code instance.
class ExecutionLogEntry {
  final String agent;
  final String eventType;
  final String? phase;
  final String? briefId;
  final int? durationMs;
  final int inputTokens;
  final int outputTokens;
  final String? result;
  final String? errorMessage;
  final String? createdAt;

  const ExecutionLogEntry({
    required this.agent,
    required this.eventType,
    this.phase,
    this.briefId,
    this.durationMs,
    required this.inputTokens,
    required this.outputTokens,
    this.result,
    this.errorMessage,
    this.createdAt,
  });

  factory ExecutionLogEntry.fromJson(Map<String, dynamic> json) =>
      ExecutionLogEntry(
        agent: json['agent'] as String? ?? '',
        eventType: json['event_type'] as String? ?? '',
        phase: json['phase'] as String?,
        briefId: json['brief_id'] as String?,
        durationMs: json['duration_ms'] as int?,
        inputTokens: json['input_tokens'] as int? ?? 0,
        outputTokens: json['output_tokens'] as int? ?? 0,
        result: json['result'] as String?,
        errorMessage: json['error_message'] as String?,
        createdAt: json['created_at'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'agent': agent,
        'event_type': eventType,
        'phase': phase,
        'brief_id': briefId,
        'duration_ms': durationMs,
        'input_tokens': inputTokens,
        'output_tokens': outputTokens,
        'result': result,
        'error_message': errorMessage,
        'created_at': createdAt,
      };
}

extension ExecutionLogEntryExtensions on ExecutionLogEntry {
  /// Duration formatted as a human-readable string.
  String get formattedDuration {
    if (durationMs == null) return '--';
    final seconds = durationMs! / 1000;
    if (seconds < 60) return '${seconds.toStringAsFixed(0)}s';
    final minutes = (seconds / 60).floor();
    final remainingSeconds = (seconds % 60).round();
    return '${minutes}m ${remainingSeconds}s';
  }

  /// True if the execution completed successfully.
  bool get isSuccess => result == 'success' || result == 'APPROVE';
}
