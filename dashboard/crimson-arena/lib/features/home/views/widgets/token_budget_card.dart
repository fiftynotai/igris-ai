import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../data/models/budget_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
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
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final budget = vm.budget.value;
      if (budget == null) {
        return ArenaCard(
          title: 'SESSION HP',
          child: Text(
            '> AWAITING BUDGET DATA...',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      final ratio = budget.ratio;
      final percentage = budget.percentage;
      final barColor = _barColor(ratio);

      return ArenaCard(
        title: ratio >= budget.criticalThreshold ? 'HP CRITICAL' : 'SESSION HP',
        trailing: Text(
          '${percentage.toStringAsFixed(1)}%',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.titleSmall,
            fontWeight: FiftyTypography.extraBold,
            color: barColor,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Segmented HP bar
            _SegmentedBar(
              percentage: percentage,
              color: barColor,
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Token count
            Text(
              '${FormatUtils.formatNumber(budget.consumed)} / '
              '${FormatUtils.formatNumber(budget.ceiling)} tokens',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.7),
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

  Color _barColor(double ratio) {
    if (ratio >= 0.95) return FiftyColors.burgundy;
    if (ratio >= 0.80) return FiftyColors.warning;
    return FiftyColors.hunterGreen;
  }
}

/// A segmented progress bar (20 segments) mimicking the vanilla JS HP bar.
class _SegmentedBar extends StatelessWidget {
  final double percentage;
  final Color color;

  const _SegmentedBar({
    required this.percentage,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    const segmentCount = 20;
    final filledCount = (percentage / 100 * segmentCount).round();

    return Row(
      children: List.generate(segmentCount, (i) {
        final filled = i < filledCount;
        return Expanded(
          child: Container(
            height: 8,
            margin: EdgeInsets.only(
              right: i < segmentCount - 1 ? 2 : 0,
            ),
            decoration: BoxDecoration(
              color: filled
                  ? color
                  : FiftyColors.cream.withValues(alpha: 0.05),
              borderRadius: FiftyRadii.smRadius,
            ),
          ),
        );
      }),
    );
  }
}

/// Token breakdown bars showing input/output/cache read/cache create.
class _TokenBreakdownBars extends StatelessWidget {
  final HomeViewModel vm;

  const _TokenBreakdownBars({required this.vm});

  @override
  Widget build(BuildContext context) {
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
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.semiBold,
                color: FiftyColors.slateGrey,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
            Text(
              FormatUtils.formatTokens(directTotal),
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.cream.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
        const SizedBox(height: FiftySpacing.xs),
        _TokenBar(
          label: 'Input',
          count: input,
          total: directTotal,
          color: FiftyColors.powderBlush,
        ),
        const SizedBox(height: FiftySpacing.xs),
        _TokenBar(
          label: 'Output',
          count: output,
          total: directTotal,
          color: FiftyColors.burgundy,
        ),
        const SizedBox(height: FiftySpacing.sm),

        // Cache tokens header
        if (cacheTotal > 0) ...[
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Text(
                'CACHED TOKENS',
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.semiBold,
                  color: FiftyColors.slateGrey,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              Text(
                FormatUtils.formatTokens(cacheTotal),
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.bold,
                  color: FiftyColors.cream.withValues(alpha: 0.7),
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),
          _TokenBar(
            label: 'Cache Rd',
            count: cacheRead,
            total: cacheTotal,
            color: FiftyColors.hunterGreen,
          ),
          const SizedBox(height: FiftySpacing.xs),
          _TokenBar(
            label: 'Cache Wr',
            count: cacheCreate,
            total: cacheTotal,
            color: FiftyColors.slateGrey,
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
    final pct = FormatUtils.percentage(count, total);

    return Row(
      children: [
        SizedBox(
          width: 64,
          child: Text(
            label,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.5),
            ),
          ),
        ),
        Expanded(
          child: Container(
            height: 6,
            decoration: BoxDecoration(
              color: FiftyColors.cream.withValues(alpha: 0.05),
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
          width: 48,
          child: Text(
            FormatUtils.formatTokens(count),
            textAlign: TextAlign.right,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.5),
            ),
          ),
        ),
        SizedBox(
          width: 32,
          child: Text(
            '${pct.round()}%',
            textAlign: TextAlign.right,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.3),
            ),
          ),
        ),
      ],
    );
  }
}
