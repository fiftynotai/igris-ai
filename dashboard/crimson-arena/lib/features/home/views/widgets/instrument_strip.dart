import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../data/models/budget_model.dart';
import '../../../../data/models/context_window_model.dart';
import '../../../../data/models/sync_status_model.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/home_view_model.dart';

/// Compact instrument strip at the top of the HOME page.
///
/// Displays three compact gauges side-by-side:
/// - HP (token budget usage)
/// - CTX (context window usage)
/// - SYNC (sync pipeline status)
///
/// Each gauge shows a label, percentage, and mini progress bar.
class InstrumentStrip extends StatelessWidget {
  const InstrumentStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final vm = Get.find<HomeViewModel>();

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(
          color: colorScheme.outline,
          width: 1,
        ),
      ),
      child: Obx(() {
        return Row(
          children: [
            // HP gauge
            Expanded(
              child: _buildBudgetGauge(context, vm),
            ),
            _divider(context),
            // CTX gauge
            Expanded(
              child: _buildContextGauge(context, vm),
            ),
            _divider(context),
            // SYNC gauge
            Expanded(
              child: _buildSyncGauge(context, vm),
            ),
            _divider(context),
            // Overall stats
            Expanded(
              child: _buildOverallStats(vm),
            ),
          ],
        );
      }),
    );
  }

  Widget _divider(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      width: 1,
      height: ArenaSizes.instrumentDividerHeight,
      margin: const EdgeInsets.symmetric(horizontal: FiftySpacing.sm),
      color: colorScheme.outline,
    );
  }

  Widget _buildBudgetGauge(BuildContext context, HomeViewModel vm) {
    final colorScheme = Theme.of(context).colorScheme;
    final budget = vm.budget.value;
    if (budget == null) {
      return _Gauge(label: 'HP', value: '--', color: colorScheme.onSurfaceVariant);
    }
    final pct = budget.percentage;
    final color = _hpColor(context, budget.ratio);
    return _Gauge(
      label: 'HP',
      value: '${pct.toStringAsFixed(0)}%',
      color: color,
      progress: pct / 100,
    );
  }

  Widget _buildContextGauge(BuildContext context, HomeViewModel vm) {
    final colorScheme = Theme.of(context).colorScheme;
    final ctx = vm.contextWindow.value;
    if (ctx == null) {
      return _Gauge(label: 'CTX', value: '--', color: colorScheme.onSurfaceVariant);
    }
    final pct = ctx.usagePercent;
    final color = _ctxColor(context, ctx.usageRatio);
    return _Gauge(
      label: 'CTX',
      value: '${pct.toStringAsFixed(0)}%',
      color: color,
      progress: pct / 100,
    );
  }

  Widget _buildSyncGauge(BuildContext context, HomeViewModel vm) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final sync = vm.syncStatus.value;
    if (sync == null) {
      return _Gauge(label: 'SYNC', value: '--', color: colorScheme.onSurfaceVariant);
    }
    final isOnline = sync.isOnline;
    return _Gauge(
      label: 'SYNC',
      value: isOnline ? 'ONLINE' : 'OFFLINE',
      color: isOnline ? ext.success : colorScheme.primary,
    );
  }

  Widget _buildOverallStats(HomeViewModel vm) {
    final invocations = vm.totalInvocations.value;
    final cost = vm.totalCost.value;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        _MiniStat(
          label: 'RUNS',
          value: FormatUtils.formatNumber(invocations),
        ),
        _MiniStat(
          label: 'COST',
          value: FormatUtils.formatCost(cost),
        ),
      ],
    );
  }

  Color _hpColor(BuildContext context, double ratio) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    if (ratio >= 0.90) return colorScheme.primary;
    if (ratio >= 0.75) return ext.warning;
    return ext.success;
  }

  Color _ctxColor(BuildContext context, double ratio) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    if (ratio >= 0.90) return colorScheme.primary;
    if (ratio >= 0.80) return ext.warning;
    return colorScheme.onSurfaceVariant;
  }
}

/// A compact gauge showing label, value, and optional progress bar.
class _Gauge extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final double? progress;

  const _Gauge({
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
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Text(
              label,
              style: textTheme.labelSmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
            const SizedBox(width: FiftySpacing.sm),
            Text(
              value,
              style: textTheme.labelMedium!.copyWith(
                color: color,
              ),
            ),
          ],
        ),
        if (progress != null) ...[
          const SizedBox(height: FiftySpacing.xs),
          SizedBox(
            width: ArenaSizes.instrumentGaugeWidth,
            height: ArenaSizes.gaugeProgressHeight,
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

/// A tiny stat with label and value for the overall stats section.
class _MiniStat extends StatelessWidget {
  final String label;
  final String value;

  const _MiniStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          value,
          style: textTheme.labelMedium!.copyWith(
            color: colorScheme.onSurface,
          ),
        ),
      ],
    );
  }
}
