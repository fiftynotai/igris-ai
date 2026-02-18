/// Token budget consumption for the current day.
///
/// Tracks consumed tokens against a daily ceiling with
/// warning and critical threshold ratios.
class BudgetModel {
  final int consumed;
  final int ceiling;
  final double ratio;
  final double warningThreshold;
  final double criticalThreshold;

  const BudgetModel({
    required this.consumed,
    required this.ceiling,
    required this.ratio,
    required this.warningThreshold,
    required this.criticalThreshold,
  });

  factory BudgetModel.fromJson(Map<String, dynamic> json) => BudgetModel(
        consumed: json['consumed'] as int? ?? 0,
        ceiling: json['ceiling'] as int? ?? 1000000,
        ratio: (json['ratio'] as num?)?.toDouble() ?? 0.0,
        warningThreshold:
            (json['warning_threshold'] as num?)?.toDouble() ?? 0.75,
        criticalThreshold:
            (json['critical_threshold'] as num?)?.toDouble() ?? 0.90,
      );

  Map<String, dynamic> toJson() => {
        'consumed': consumed,
        'ceiling': ceiling,
        'ratio': ratio,
        'warning_threshold': warningThreshold,
        'critical_threshold': criticalThreshold,
      };
}

extension BudgetModelExtensions on BudgetModel {
  /// True when consumed exceeds the warning threshold.
  bool get isWarning => ratio >= warningThreshold;

  /// True when consumed exceeds the critical threshold.
  bool get isCritical => ratio >= criticalThreshold;

  /// Remaining tokens before hitting the ceiling.
  int get remaining => (ceiling - consumed).clamp(0, ceiling);

  /// Percentage consumed, clamped to 0-100.
  double get percentage => (ratio * 100).clamp(0, 100);
}
