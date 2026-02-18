/// Agent Teams parallel execution status.
///
/// Tracks whether a team is active, its teammates, and coordination log.
class TeamStatusModel {
  final bool active;
  final String teamName;
  final List<TeammateModel> teammates;
  final List<CoordinationLogEntry> coordinationLog;
  final Map<String, String> fileOwnership;

  const TeamStatusModel({
    required this.active,
    required this.teamName,
    required this.teammates,
    required this.coordinationLog,
    required this.fileOwnership,
  });

  factory TeamStatusModel.fromJson(Map<String, dynamic> json) =>
      TeamStatusModel(
        active: json['active'] as bool? ?? false,
        teamName: json['team_name'] as String? ?? '',
        teammates: (json['teammates'] as List<dynamic>?)
                ?.map((e) =>
                    TeammateModel.fromJson(e as Map<String, dynamic>))
                .toList() ??
            [],
        coordinationLog: (json['coordination_log'] as List<dynamic>?)
                ?.map((e) =>
                    CoordinationLogEntry.fromJson(e as Map<String, dynamic>))
                .toList() ??
            [],
        fileOwnership:
            (json['file_ownership'] as Map<String, dynamic>?)?.map(
                  (k, v) => MapEntry(k, v.toString()),
                ) ??
                {},
      );

  Map<String, dynamic> toJson() => {
        'active': active,
        'team_name': teamName,
        'teammates': teammates.map((t) => t.toJson()).toList(),
        'coordination_log': coordinationLog.map((c) => c.toJson()).toList(),
        'file_ownership': fileOwnership,
      };
}

/// A teammate in a parallel agent team execution.
class TeammateModel {
  final String name;
  final String brief;
  final String phase;
  final String elapsed;
  final int tokens;
  final int retries;

  const TeammateModel({
    required this.name,
    required this.brief,
    required this.phase,
    required this.elapsed,
    required this.tokens,
    required this.retries,
  });

  factory TeammateModel.fromJson(Map<String, dynamic> json) => TeammateModel(
        name: json['name'] as String? ?? 'unknown',
        brief: json['brief'] as String? ?? '--',
        phase: json['phase'] as String? ?? '--',
        elapsed: json['elapsed'] as String? ?? '--',
        tokens: json['tokens'] as int? ?? 0,
        retries: json['retries'] as int? ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'name': name,
        'brief': brief,
        'phase': phase,
        'elapsed': elapsed,
        'tokens': tokens,
        'retries': retries,
      };
}

/// A coordination event in the team log.
class CoordinationLogEntry {
  final String timestamp;
  final String message;

  const CoordinationLogEntry({
    required this.timestamp,
    required this.message,
  });

  factory CoordinationLogEntry.fromJson(Map<String, dynamic> json) =>
      CoordinationLogEntry(
        timestamp: json['ts'] as String? ?? '',
        message: json['message'] as String? ?? '',
      );

  Map<String, dynamic> toJson() => {
        'ts': timestamp,
        'message': message,
      };
}
