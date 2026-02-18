/// Sync pipeline status between local and VPS brain.
class SyncStatusModel {
  final String status;
  final String? lastPush;
  final String? lastPull;
  final int queueDepth;

  const SyncStatusModel({
    required this.status,
    this.lastPush,
    this.lastPull,
    required this.queueDepth,
  });

  factory SyncStatusModel.fromJson(Map<String, dynamic> json) =>
      SyncStatusModel(
        status: json['status'] as String? ?? 'offline',
        lastPush: json['last_push'] as String?,
        lastPull: json['last_pull'] as String?,
        queueDepth: json['queue_depth'] as int? ?? 0,
      );

  Map<String, dynamic> toJson() => {
        'status': status,
        'last_push': lastPush,
        'last_pull': lastPull,
        'queue_depth': queueDepth,
      };
}

extension SyncStatusModelExtensions on SyncStatusModel {
  /// True if sync pipeline is connected.
  bool get isOnline => status == 'online';
}
