import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../data/models/context_window_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Context Window (Digivice) card.
///
/// Displays current context window usage as a segmented progress bar
/// with percentage, token count, and model identifier.
/// Color transitions: normal < 60%, transition 60-80%, warning 80-90%,
/// overflow > 90%.
class ContextWindowCard extends StatelessWidget {
  const ContextWindowCard({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final ctx = vm.contextWindow.value;

      if (ctx == null) {
        return ArenaCard(
          title: 'DATA LOAD',
          child: Text(
            '> Awaiting context data...',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      final percentage = ctx.usagePercent;
      final barColor = _barColor(percentage);
      final label = percentage >= 90 ? 'DATA OVERFLOW' : 'DATA LOAD';

      return ArenaCard(
        title: label,
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
            // Segmented bar
            _SegmentedBar(
              percentage: percentage,
              color: barColor,
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Token count
            Text(
              '${FormatUtils.formatNumber(ctx.contextUsed)} / '
              '${FormatUtils.formatNumber(ctx.contextMax)} ctx',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.7),
              ),
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Model and orchestrator tags
            _DigiviceTags(vm: vm, model: ctx.modelShortName),
          ],
        ),
      );
    });
  }

  Color _barColor(double percentage) {
    if (percentage >= 90) return FiftyColors.burgundy;
    if (percentage >= 80) return FiftyColors.warning;
    if (percentage >= 60) return FiftyColors.slateGrey;
    return FiftyColors.hunterGreen;
  }
}

/// A segmented progress bar matching the HP bar pattern.
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

/// Tags showing orchestrator cache/input/output token breakdown.
class _DigiviceTags extends StatelessWidget {
  final HomeViewModel vm;
  final String model;

  const _DigiviceTags({required this.vm, required this.model});

  @override
  Widget build(BuildContext context) {
    final orch = vm.agents['orchestrator'];

    return Wrap(
      spacing: FiftySpacing.sm,
      runSpacing: FiftySpacing.xs,
      children: [
        _Tag(text: model),
        if (orch != null) ...[
          _Tag(
            text: 'cache:${FormatUtils.formatTokens(orch.totalCacheReadTokens)}',
          ),
          _Tag(
            text: 'in:${FormatUtils.formatTokens(orch.totalInputTokens)}',
          ),
          _Tag(
            text: 'out:${FormatUtils.formatTokens(orch.totalOutputTokens)}',
          ),
        ],
      ],
    );
  }
}

/// A small info tag.
class _Tag extends StatelessWidget {
  final String text;

  const _Tag({required this.text});

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.xs,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: FiftyColors.cream.withValues(alpha: 0.05),
        borderRadius: FiftyRadii.smRadius,
      ),
      child: Text(
        '[$text]',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.medium,
          color: FiftyColors.cream.withValues(alpha: 0.4),
        ),
      ),
    );
  }
}
