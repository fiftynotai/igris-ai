import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fl_chart/fl_chart.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/agent_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/agents_view_model.dart';

/// Performance metrics panel for the selected agent.
///
/// Displays:
/// - Efficiency grade badge (S/A/B/C/F)
/// - Success rate percentage
/// - Average tokens per invocation
/// - Average duration per invocation
/// - Total runs and total tokens
/// - Sparkline of recent token consumption
class AgentMetricsPanel extends StatelessWidget {
  const AgentMetricsPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AgentsViewModel>();
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return Obx(() {
      final agentName = vm.selectedAgent.value;
      if (agentName == null) return const SizedBox.shrink();

      final agent = vm.agents[agentName];
      if (agent == null) {
        return _EmptyState(agentName: agentName);
      }

      // Agent-specific color -- game identity, not migrated.
      final color = Color(
        AgentConstants.agentColors[agentName] ?? 0xFF888888,
      );

      return Container(
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainerHighest,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: color.withValues(alpha: 0.2),
            width: 1,
          ),
        ),
        child: SingleChildScrollView(
          padding: const EdgeInsets.all(FiftySpacing.md),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Section header
              Text(
                'METRICS',
                style: textTheme.labelMedium!.copyWith(
                  color: colorScheme.onSurfaceVariant,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              const SizedBox(height: FiftySpacing.md),

              // Efficiency grade
              _GradeBadge(agent: agent, color: color),
              const SizedBox(height: FiftySpacing.lg),

              // Key metrics
              _MetricTile(
                label: 'SUCCESS RATE',
                value:
                    '${(agent.successRate * 100).clamp(0, 100).toStringAsFixed(1)}%',
                color: _successColor(agent.successRate * 100, colorScheme, ext),
                progress: agent.successRate.clamp(0, 1).toDouble(),
              ),
              const SizedBox(height: FiftySpacing.md),

              _MetricTile(
                label: 'AVG TOKENS / RUN',
                value: agent.invocations > 0
                    ? FormatUtils.formatTokens(
                        agent.totalTokens ~/ agent.invocations,
                      )
                    : '--',
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
              const SizedBox(height: FiftySpacing.md),

              _MetricTile(
                label: 'AVG DURATION',
                value: FormatUtils.formatDuration(agent.avgDurationSeconds),
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
              const SizedBox(height: FiftySpacing.lg),

              // Totals
              Container(
                padding: const EdgeInsets.all(FiftySpacing.sm),
                decoration: BoxDecoration(
                  color: colorScheme.surface,
                  borderRadius: FiftyRadii.mdRadius,
                ),
                child: Column(
                  children: [
                    _CompactRow(
                      label: 'Total Runs',
                      value: FormatUtils.formatNumber(agent.invocations),
                    ),
                    const SizedBox(height: FiftySpacing.xs),
                    _CompactRow(
                      label: 'Total Tokens',
                      value: FormatUtils.formatTokens(agent.totalTokens),
                    ),
                    const SizedBox(height: FiftySpacing.xs),
                    _CompactRow(
                      label: 'Input Tokens',
                      value: FormatUtils.formatTokens(agent.totalInputTokens),
                    ),
                    const SizedBox(height: FiftySpacing.xs),
                    _CompactRow(
                      label: 'Output Tokens',
                      value: FormatUtils.formatTokens(agent.totalOutputTokens),
                    ),
                    const SizedBox(height: FiftySpacing.xs),
                    _CompactRow(
                      label: 'Cache Read',
                      value:
                          FormatUtils.formatTokens(agent.totalCacheReadTokens),
                    ),
                    const SizedBox(height: FiftySpacing.xs),
                    _CompactRow(
                      label: 'Cache Create',
                      value: FormatUtils.formatTokens(
                        agent.totalCacheCreateTokens,
                      ),
                    ),
                  ],
                ),
              ),
              const SizedBox(height: FiftySpacing.lg),

              // Token distribution sparkline
              Text(
                'TOKEN DISTRIBUTION',
                style: textTheme.labelSmall!.copyWith(
                  color: colorScheme.onSurface.withValues(alpha: 0.3),
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              const SizedBox(height: FiftySpacing.sm),
              SizedBox(
                height: 60,
                child: _TokenDistributionChart(agent: agent, color: color),
              ),

              const SizedBox(height: FiftySpacing.md),

              // Last used
              if (agent.lastUsed != null) ...[
                Text(
                  'LAST USED',
                  style: textTheme.labelSmall!.copyWith(
                    color: colorScheme.onSurface.withValues(alpha: 0.3),
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
                ),
                const SizedBox(height: FiftySpacing.xs),
                Text(
                  FormatUtils.timeAgo(agent.lastUsed),
                  style: textTheme.bodySmall!.copyWith(
                    fontWeight: FiftyTypography.medium,
                    color: colorScheme.onSurface.withValues(alpha: 0.6),
                  ),
                ),
              ],

              // Compare button
              const SizedBox(height: FiftySpacing.lg),
              _CompareButton(color: color),
            ],
          ),
        ),
      );
    });
  }

  static Color _successColor(double pct, ColorScheme colorScheme, FiftyThemeExtension ext) {
    if (pct > 90) return ext.success;
    if (pct > 70) return ext.warning;
    return colorScheme.primary;
  }
}

/// Empty state when agent has no data.
class _EmptyState extends StatelessWidget {
  final String agentName;

  const _EmptyState({required this.agentName});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(color: colorScheme.outline, width: 1),
      ),
      padding: const EdgeInsets.all(FiftySpacing.lg),
      child: Center(
        child: Text(
          'No metrics available for ${agentName.toUpperCase()}',
          style: textTheme.bodySmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
      ),
    );
  }
}

/// Large grade badge (S/A/B/C/F) with color coding.
class _GradeBadge extends StatelessWidget {
  final AgentModel agent;
  final Color color;

  const _GradeBadge({required this.agent, required this.color});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final successPct = (agent.successRate * 100).clamp(0.0, 100.0);
    final avgTokens = agent.invocations > 0
        ? agent.totalTokens ~/ agent.invocations
        : 0;
    final grade = _computeGrade(successPct, avgTokens);
    final gradeColor = _gradeColor(grade, colorScheme, ext);

    return Center(
      child: Container(
        width: 64,
        height: 64,
        decoration: BoxDecoration(
          color: gradeColor.withValues(alpha: 0.12),
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: gradeColor.withValues(alpha: 0.4),
            width: 2,
          ),
          boxShadow: [
            BoxShadow(
              color: gradeColor.withValues(alpha: 0.1),
              blurRadius: 12,
              spreadRadius: 2,
            ),
          ],
        ),
        child: Center(
          child: Text(
            grade,
            style: textTheme.displayMedium!.copyWith(
              color: gradeColor,
            ),
          ),
        ),
      ),
    );
  }

  String _computeGrade(double successPct, int avgTokens) {
    // S: >95% success and low token usage
    if (successPct > 95 && avgTokens < 100000) return 'S';
    if (successPct > 95) return 'A';
    if (successPct > 90) return 'A';
    if (successPct > 80) return 'B';
    if (successPct > 60) return 'C';
    return 'F';
  }

  Color _gradeColor(String grade, ColorScheme colorScheme, FiftyThemeExtension ext) {
    switch (grade) {
      case 'S':
        return const Color(0xFFFFD700); // Gold
      case 'A':
        return ext.success;
      case 'B':
        return colorScheme.onSurfaceVariant;
      case 'C':
        return ext.warning;
      case 'F':
        return colorScheme.primary;
      default:
        return colorScheme.onSurfaceVariant;
    }
  }
}

/// Single metric tile with label, value, and optional progress bar.
class _MetricTile extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final double? progress;

  const _MetricTile({
    required this.label,
    required this.value,
    required this.color,
    this.progress,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurface.withValues(alpha: 0.3),
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),
        Text(
          value,
          style: textTheme.titleLarge!.copyWith(
            fontWeight: FiftyTypography.extraBold,
            color: color,
          ),
        ),
        if (progress != null) ...[
          const SizedBox(height: FiftySpacing.xs),
          SizedBox(
            height: 4,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: progress!.clamp(0, 1),
                backgroundColor: colorScheme.onSurface.withValues(alpha: 0.05),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// Compact label-value row.
class _CompactRow extends StatelessWidget {
  final String label;
  final String value;

  const _CompactRow({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.4),
          ),
        ),
        Text(
          value,
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.bold,
            color: colorScheme.onSurface.withValues(alpha: 0.7),
          ),
        ),
      ],
    );
  }
}

/// Token distribution as a stacked horizontal bar chart.
class _TokenDistributionChart extends StatelessWidget {
  final AgentModel agent;
  final Color color;

  const _TokenDistributionChart({
    required this.agent,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final total = agent.totalTokens;
    if (total == 0) {
      return Center(
        child: Text(
          'No token data available',
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
          ),
        ),
      );
    }

    final inputPct = agent.totalInputTokens / total;
    final outputPct = agent.totalOutputTokens / total;
    final cacheReadPct = agent.totalCacheReadTokens / total;
    final cacheCreatePct = agent.totalCacheCreateTokens / total;

    return BarChart(
      BarChartData(
        alignment: BarChartAlignment.center,
        maxY: 1,
        barTouchData: BarTouchData(enabled: false),
        titlesData: const FlTitlesData(show: false),
        borderData: FlBorderData(show: false),
        gridData: const FlGridData(show: false),
        barGroups: [
          BarChartGroupData(
            x: 0,
            barRods: [
              BarChartRodData(
                toY: 1,
                width: 20,
                borderRadius: FiftyRadii.smRadius,
                rodStackItems: [
                  BarChartRodStackItem(
                    0,
                    inputPct,
                    color.withValues(alpha: 0.9),
                  ),
                  BarChartRodStackItem(
                    inputPct,
                    inputPct + outputPct,
                    color.withValues(alpha: 0.6),
                  ),
                  BarChartRodStackItem(
                    inputPct + outputPct,
                    inputPct + outputPct + cacheReadPct,
                    color.withValues(alpha: 0.35),
                  ),
                  BarChartRodStackItem(
                    inputPct + outputPct + cacheReadPct,
                    inputPct + outputPct + cacheReadPct + cacheCreatePct,
                    color.withValues(alpha: 0.15),
                  ),
                ],
                color: Colors.transparent,
              ),
            ],
          ),
        ],
      ),
      duration: const Duration(milliseconds: 300),
    );
  }
}

/// Button to initiate agent comparison.
class _CompareButton extends StatelessWidget {
  final Color color;

  const _CompareButton({required this.color});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AgentsViewModel>();
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return SizedBox(
      width: double.infinity,
      child: Obx(() {
        final isComparing = vm.comparisonMode.value;
        return InkWell(
          onTap: vm.toggleComparisonMode,
          borderRadius: FiftyRadii.mdRadius,
          child: Container(
            padding: const EdgeInsets.symmetric(
              vertical: FiftySpacing.sm,
            ),
            decoration: BoxDecoration(
              color: isComparing
                  ? color.withValues(alpha: 0.15)
                  : Colors.transparent,
              borderRadius: FiftyRadii.mdRadius,
              border: Border.all(
                color: isComparing
                    ? color.withValues(alpha: 0.4)
                    : colorScheme.outline,
                width: 1,
              ),
            ),
            child: Center(
              child: Text(
                isComparing ? 'EXIT COMPARE' : 'COMPARE',
                style: textTheme.labelMedium!.copyWith(
                  color: isComparing
                      ? color
                      : colorScheme.onSurface.withValues(alpha: 0.5),
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
            ),
          ),
        );
      }),
    );
  }
}
