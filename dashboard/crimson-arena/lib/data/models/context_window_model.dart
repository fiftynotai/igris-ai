/// Context window state for the current Claude session.
///
/// Tracks how much of the model's context window has been used,
/// the maximum capacity, and the active model identifier.
class ContextWindowModel {
  final int contextUsed;
  final int contextMax;
  final int contextRemaining;
  final String modelId;

  const ContextWindowModel({
    required this.contextUsed,
    required this.contextMax,
    required this.contextRemaining,
    required this.modelId,
  });

  factory ContextWindowModel.fromJson(Map<String, dynamic> json) =>
      ContextWindowModel(
        contextUsed: json['context_used'] as int? ?? 0,
        contextMax: json['context_max'] as int? ?? 200000,
        contextRemaining: json['context_remaining'] as int? ?? 200000,
        modelId: json['model_id'] as String? ?? '',
      );

  Map<String, dynamic> toJson() => {
        'context_used': contextUsed,
        'context_max': contextMax,
        'context_remaining': contextRemaining,
        'model_id': modelId,
      };
}

extension ContextWindowModelExtensions on ContextWindowModel {
  /// Usage ratio (0.0 to 1.0).
  double get usageRatio =>
      contextMax > 0 ? contextUsed / contextMax : 0.0;

  /// Percentage used, clamped 0-100.
  double get usagePercent => (usageRatio * 100).clamp(0, 100);

  /// Short model name extracted from model_id.
  String get modelShortName {
    if (modelId.contains('opus')) return 'Opus';
    if (modelId.contains('sonnet')) return 'Sonnet';
    if (modelId.contains('haiku')) return 'Haiku';
    return modelId;
  }
}
