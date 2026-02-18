/// A session tracked in the brain server.
class SessionModel {
  final String project;
  final String? briefId;
  final String? mode;
  final String? phase;
  final String? summary;
  final String? createdAt;

  const SessionModel({
    required this.project,
    this.briefId,
    this.mode,
    this.phase,
    this.summary,
    this.createdAt,
  });

  factory SessionModel.fromJson(Map<String, dynamic> json) => SessionModel(
        project: json['project'] as String? ?? '',
        briefId: json['brief_id'] as String?,
        mode: json['mode'] as String?,
        phase: json['phase'] as String?,
        summary: json['summary'] as String?,
        createdAt: json['created_at'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'project': project,
        'brief_id': briefId,
        'mode': mode,
        'phase': phase,
        'summary': summary,
        'created_at': createdAt,
      };
}
