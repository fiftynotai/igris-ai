import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../data/models/budget_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../../../shared/widgets/segmented_bar.dart';
import '../../controllers/home_view_model.dart';

/// Token Budget HP card.
///
/// Displays consumed / ceiling tokens with a segmented progress bar,
/// percentage, and input/output/cache breakdown bars.
/// Color transitions: green < 80%, yellow 80-95%, red > 95%.
class TokenBudgetCard extends StatelessWidget {
  const TokenBudgetCard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final budget = vm.budget.value;
      if (budget == null) {
        return ArenaCard(
          title: 'SESSION HP',
          child: Text(
            'No budget data available',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      final ratio = budget.ratio;
      final percentage = budget.percentage;
      final barColor = _barColor(context, ratio);

      return ArenaCard(
        title: ratio >= budget.criticalThreshold ? 'HP CRITICAL' : 'SESSION HP',
        trailing: Text(
          '${percentage.toStringAsFixed(1)}%',
          style: textTheme.titleSmall!.copyWith(
            fontWeight: FiftyTypography.extraBold,
            color: barColor,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Segmented HP bar
            SegmentedBar(
              percentage: percentage,
              color: barColor,
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Token count
            Text(
              '${FormatUtils.formatNumber(budget.consumed)} / '
              '${FormatUtils.formatNumber(budget.ceiling)} tokens',
              style: textTheme.bodySmall!.copyWith(
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: FiftySpacing.md),

            // Token breakdown bars
            _TokenBreakdownBars(vm: vm),
          ],
        ),
      );
    });
  }

  Color _barColor(BuildContext context, double ratio) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    if (ratio >= 0.95) return colorScheme.primary;
    if (ratio >= 0.80) return ext.warning;
    return ext.success;
  }
}

/// Token breakdown bars showing input/output/cache read/cache create.
class _TokenBreakdownBars extends StatelessWidget {
  final HomeViewModel vm;

  const _TokenBreakdownBars({required this.vm});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final input = vm.totalInputTokens.value;
    final output = vm.totalOutputTokens.value;
    final cacheRead = vm.totalCacheReadTokens.value;
    final cacheCreate = vm.totalCacheCreateTokens.value;

    final directTotal = input + output;
    final cacheTotal = cacheRead + cacheCreate;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Direct tokens header
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              'DIRECT TOKENS',
              style: textTheme.labelSmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
            Text(
              FormatUtils.formatTokens(directTotal),
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
        const SizedBox(height: FiftySpacing.xs),
        _TokenBar(
          label: 'Input',
          count: input,
          total: directTotal,
          color: ext.accent,
        ),
        const SizedBox(height: FiftySpacing.xs),
        _TokenBar(
          label: 'Output',
          count: output,
          total: directTotal,
          color: colorScheme.primary,
        ),
        const SizedBox(height: FiftySpacing.sm),

        // Cache tokens header
        if (cacheTotal > 0) ...[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'CACHED TOKENS',
                style: textTheme.labelSmall!.copyWith(
                  color: colorScheme.onSurfaceVariant,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              Text(
                FormatUtils.formatTokens(cacheTotal),
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: colorScheme.onSurface.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),
          _TokenBar(
            label: 'Cache Rd',
            count: cacheRead,
            total: cacheTotal,
            color: ext.success,
          ),
          const SizedBox(height: FiftySpacing.xs),
          _TokenBar(
            label: 'Cache Wr',
            count: cacheCreate,
            total: cacheTotal,
            color: colorScheme.onSurfaceVariant,
          ),
        ],
      ],
    );
  }
}

/// A single labeled token breakdown bar.
class _TokenBar extends StatelessWidget {
  final String label;
  final int count;
  final int total;
  final Color color;

  const _TokenBar({
    required this.label,
    required this.count,
    required this.total,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final pct = FormatUtils.percentage(count, total);

    return Row(
      children: [
        SizedBox(
          width: ArenaSizes.tokenBarLabelWidth,
          child: Text(
            label,
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
        ),
        Expanded(
          child: Container(
            height: ArenaSizes.tokenBarHeight,
            decoration: BoxDecoration(
              color: colorScheme.onSurface.withValues(alpha: 0.05),
              borderRadius: FiftyRadii.smRadius,
            ),
            child: FractionallySizedBox(
              alignment: Alignment.centerLeft,
              widthFactor: (pct / 100).clamp(0, 1),
              child: Container(
                decoration: BoxDecoration(
                  color: color,
                  borderRadius: FiftyRadii.smRadius,
                ),
              ),
            ),
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),
        SizedBox(
          width: ArenaSizes.tokenBarValueWidth,
          child: Text(
            FormatUtils.formatTokens(count),
            textAlign: TextAlign.right,
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
        ),
        SizedBox(
          width: ArenaSizes.tokenBarPercentWidth,
          child: Text(
            '${pct.round()}%',
            textAlign: TextAlign.right,
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.3),
            ),
          ),
        ),
      ],
    );
  }
}
