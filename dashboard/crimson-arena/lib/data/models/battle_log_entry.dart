/// A single event entry in the battle log (recent events feed).
///
/// Corresponds to rows from the `events` table with `event = 'stop'`.
class BattleLogEntry {
  final String timestamp;
  final String event;
  final String agent;
  final String? agentId;
  final String? rawType;
  final double? durationSeconds;
  final int inputTokens;
  final int outputTokens;
  final int cacheRead;
  final int cacheCreate;

  const BattleLogEntry({
    required this.timestamp,
    required this.event,
    required this.agent,
    this.agentId,
    this.rawType,
    this.durationSeconds,
    required this.inputTokens,
    required this.outputTokens,
    required this.cacheRead,
    required this.cacheCreate,
  });

  factory BattleLogEntry.fromJson(Map<String, dynamic> json) => BattleLogEntry(
        timestamp: json['ts'] as String? ?? '',
        event: json['event'] as String? ?? 'stop',
        agent: json['agent'] as String? ?? '',
        agentId: json['agent_id'] as String?,
        rawType: json['raw_type'] as String?,
        durationSeconds: (json['duration_s'] as num?)?.toDouble(),
        inputTokens: json['input_tokens'] as int? ?? 0,
        outputTokens: json['output_tokens'] as int? ?? 0,
        cacheRead: json['cache_read'] as int? ?? 0,
        cacheCreate: json['cache_create'] as int? ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'ts': timestamp,
        'event': event,
        'agent': agent,
        'agent_id': agentId,
        'raw_type': rawType,
        'duration_s': durationSeconds,
        'input_tokens': inputTokens,
        'output_tokens': outputTokens,
        'cache_read': cacheRead,
        'cache_create': cacheCreate,
      };
}

extension BattleLogEntryExtensions on BattleLogEntry {
  /// Total tokens for this event (all 4 buckets).
  int get totalTokens => inputTokens + outputTokens + cacheRead + cacheCreate;

  /// True if this is a stop (completion) event.
  bool get isStopEvent => event == 'stop';

  /// True if this is a start event.
  bool get isStartEvent => event == 'start';
}
