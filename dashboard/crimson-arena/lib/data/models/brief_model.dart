/// A brief tracked in the brain server.
///
/// Represents a bug, feature, tech debt, or other tracked work item
/// across any Igris-managed project.
class BriefModel {
  final String project;
  final String briefId;
  final String briefType;
  final String title;
  final String status;
  final String priority;
  final String effort;
  final String? phase;

  const BriefModel({
    required this.project,
    required this.briefId,
    required this.briefType,
    required this.title,
    required this.status,
    required this.priority,
    required this.effort,
    this.phase,
  });

  factory BriefModel.fromJson(Map<String, dynamic> json) => BriefModel(
        project: json['project'] as String? ?? '',
        briefId: json['brief_id'] as String? ?? '',
        briefType: json['brief_type'] as String? ?? '',
        title: json['title'] as String? ?? '',
        status: json['status'] as String? ?? 'Draft',
        priority: json['priority'] as String? ?? 'P2',
        effort: json['effort'] as String? ?? 'M',
        phase: json['phase'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'project': project,
        'brief_id': briefId,
        'brief_type': briefType,
        'title': title,
        'status': status,
        'priority': priority,
        'effort': effort,
        'phase': phase,
      };
}

extension BriefModelExtensions on BriefModel {
  /// True if this brief is currently being worked on.
  bool get isInProgress => status == 'In Progress';

  /// True if this brief is completed.
  bool get isDone => status == 'Done';

  /// True if this brief is blocked.
  bool get isBlocked => status == 'Blocked';
}
