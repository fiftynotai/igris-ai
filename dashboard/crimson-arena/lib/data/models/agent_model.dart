/// Agent data with token usage, levels, and RPG stats.
///
/// Represents a single agent's cumulative metrics as returned
/// by the `/api/state` or `/api/agents` endpoints.
class AgentModel {
  final String name;
  final int invocations;
  final int totalInputTokens;
  final int totalOutputTokens;
  final int totalCacheReadTokens;
  final int totalCacheCreateTokens;
  final double avgDurationSeconds;
  final double successRate;
  final String? lastUsed;
  final bool active;
  final AgentLevel level;
  final RpgStats rpgStats;

  const AgentModel({
    required this.name,
    required this.invocations,
    required this.totalInputTokens,
    required this.totalOutputTokens,
    required this.totalCacheReadTokens,
    required this.totalCacheCreateTokens,
    required this.avgDurationSeconds,
    required this.successRate,
    this.lastUsed,
    required this.active,
    required this.level,
    required this.rpgStats,
  });

  factory AgentModel.fromJson(String agentName, Map<String, dynamic> json) =>
      AgentModel(
        name: agentName,
        invocations: json['invocations'] as int? ?? 0,
        totalInputTokens: json['total_input_tokens'] as int? ?? 0,
        totalOutputTokens: json['total_output_tokens'] as int? ?? 0,
        totalCacheReadTokens: json['total_cache_read_tokens'] as int? ?? 0,
        totalCacheCreateTokens: json['total_cache_create_tokens'] as int? ?? 0,
        avgDurationSeconds:
            (json['avg_duration_seconds'] as num?)?.toDouble() ?? 0,
        successRate: (json['success_rate'] as num?)?.toDouble() ?? 1.0,
        lastUsed: json['last_used'] as String?,
        active: json['active'] as bool? ?? false,
        level: AgentLevel.fromJson(
            json['level'] as Map<String, dynamic>? ?? {}),
        rpgStats: RpgStats.fromJson(
            json['rpg_stats'] as Map<String, dynamic>? ?? {}),
      );

  Map<String, dynamic> toJson() => {
        'invocations': invocations,
        'total_input_tokens': totalInputTokens,
        'total_output_tokens': totalOutputTokens,
        'total_cache_read_tokens': totalCacheReadTokens,
        'total_cache_create_tokens': totalCacheCreateTokens,
        'avg_duration_seconds': avgDurationSeconds,
        'success_rate': successRate,
        'last_used': lastUsed,
        'active': active,
        'level': level.toJson(),
        'rpg_stats': rpgStats.toJson(),
      };
}

/// Level progression data for an agent.
class AgentLevel {
  final String name;
  final int tier;
  final String evolution;
  final int nextAt;
  final double progress;

  const AgentLevel({
    required this.name,
    required this.tier,
    required this.evolution,
    required this.nextAt,
    required this.progress,
  });

  factory AgentLevel.fromJson(Map<String, dynamic> json) => AgentLevel(
        name: json['name'] as String? ?? 'Trainee',
        tier: json['tier'] as int? ?? 0,
        evolution: json['evolution'] as String? ?? 'In-Training',
        nextAt: json['next_at'] as int? ?? 0,
        progress: (json['progress'] as num?)?.toDouble() ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'tier': tier,
        'evolution': evolution,
        'next_at': nextAt,
        'progress': progress,
      };
}

/// RPG-style stats derived from real agent performance.
///
/// STR = output token volume relative to max across agents
/// INT = cache efficiency (cache_read ratio)
/// SPD = speed (inverse of duration relative to slowest)
/// VIT = success rate as percentage
class RpgStats {
  final int str;
  final int int_;
  final int spd;
  final int vit;

  const RpgStats({
    required this.str,
    required this.int_,
    required this.spd,
    required this.vit,
  });

  factory RpgStats.fromJson(Map<String, dynamic> json) => RpgStats(
        str: json['STR'] as int? ?? 0,
        int_: json['INT'] as int? ?? 0,
        spd: json['SPD'] as int? ?? 0,
        vit: json['VIT'] as int? ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'STR': str,
        'INT': int_,
        'SPD': spd,
        'VIT': vit,
      };
}

extension AgentModelExtensions on AgentModel {
  /// Total tokens consumed by this agent (all 4 buckets).
  int get totalTokens =>
      totalInputTokens +
      totalOutputTokens +
      totalCacheReadTokens +
      totalCacheCreateTokens;
}
