/// A Claude Code instance registered with the brain server.
///
/// Represents a running or recently active Claude Code session
/// on a specific project/machine.
class InstanceModel {
  final String id;
  final String projectSlug;
  final String projectPath;
  final String machineHostname;
  final String? currentBrief;
  final String? currentPhase;
  final String? currentTask;
  final String status;
  final String? createdAt;
  final String? lastHeartbeat;

  const InstanceModel({
    required this.id,
    required this.projectSlug,
    required this.projectPath,
    required this.machineHostname,
    this.currentBrief,
    this.currentPhase,
    this.currentTask,
    required this.status,
    this.createdAt,
    this.lastHeartbeat,
  });

  factory InstanceModel.fromJson(Map<String, dynamic> json) => InstanceModel(
        id: json['id'] as String? ?? json['instance_id'] as String? ?? '',
        projectSlug: json['project_slug'] as String? ?? '',
        projectPath: json['project_path'] as String? ?? '',
        machineHostname: json['machine_hostname'] as String? ?? '',
        currentBrief: json['current_brief'] as String?,
        currentPhase: json['current_phase'] as String?,
        currentTask: json['current_task'] as String?,
        status: json['status'] as String? ?? 'unknown',
        createdAt: json['created_at'] as String?,
        lastHeartbeat: json['last_heartbeat_at'] as String?,
      );

  Map<String, dynamic> toJson() => {
        'id': id,
        'project_slug': projectSlug,
        'project_path': projectPath,
        'machine_hostname': machineHostname,
        'current_brief': currentBrief,
        'current_phase': currentPhase,
        'current_task': currentTask,
        'status': status,
        'created_at': createdAt,
        'last_heartbeat_at': lastHeartbeat,
      };
}

extension InstanceModelExtensions on InstanceModel {
  /// True if the instance is actively working.
  bool get isActive => status == 'active';

  /// True if the instance has a brief assigned.
  bool get hasBrief => currentBrief != null && currentBrief!.isNotEmpty;

  /// Short display label for the instance.
  String get displayLabel =>
      currentBrief ?? projectSlug.toUpperCase();
}
