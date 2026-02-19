import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/arena_colors.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Context Breakdown card.
///
/// Displays a stacked horizontal bar showing how the context window
/// budget is distributed across categories: system prompt, tools,
/// rules, messages, free space, etc.
/// Each segment is color-coded with a legend below.
class ContextBreakdownCard extends StatelessWidget {
  const ContextBreakdownCard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final breakdown = vm.contextWindow.value?.breakdown;
      if (breakdown == null) {
        return ArenaCard(
          title: 'CONTEXT BREAKDOWN',
          child: Text(
            'Awaiting context data...',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      final segments = breakdown.segments;
      final contextMax = vm.contextWindow.value?.contextMax ?? 1;

      return ArenaCard(
        title: 'CONTEXT BREAKDOWN',
        trailing: Text(
          '~${FormatUtils.formatTokens(breakdown.totalOverhead)} overhead',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.5),
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Stacked bar
            ClipRRect(
              borderRadius: BorderRadius.circular(
                ArenaSizes.breakdownBarHeight / 2,
              ),
              child: SizedBox(
                height: ArenaSizes.breakdownBarHeight,
                child: Row(
                  children: segments
                      .map(
                        (s) => Flexible(
                          flex: s.tokens,
                          child: Container(
                            color: ArenaColors.breakdownColorMap[s.key] ??
                                ArenaColors.breakdownFreeSpace,
                          ),
                        ),
                      )
                      .toList(),
                ),
              ),
            ),
            const SizedBox(height: FiftySpacing.sm),

            // Legend
            Wrap(
              spacing: FiftySpacing.md,
              runSpacing: FiftySpacing.xs,
              children: segments
                  .map(
                    (s) => _LegendItem(
                      color: ArenaColors.breakdownColorMap[s.key] ??
                          ArenaColors.breakdownFreeSpace,
                      label: s.label,
                      tokens: s.tokens,
                      contextMax: contextMax,
                    ),
                  )
                  .toList(),
            ),
          ],
        ),
      );
    });
  }
}

/// A single legend item: color dot + label + token count + percentage.
class _LegendItem extends StatelessWidget {
  final Color color;
  final String label;
  final int tokens;
  final int contextMax;

  const _LegendItem({
    required this.color,
    required this.label,
    required this.tokens,
    required this.contextMax,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final pct = contextMax > 0 ? (tokens / contextMax * 100) : 0.0;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: ArenaSizes.breakdownLegendDotSize,
          height: ArenaSizes.breakdownLegendDotSize,
          decoration: BoxDecoration(
            color: color,
            shape: BoxShape.circle,
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        Text(
          '$label  ${FormatUtils.formatTokens(tokens)}  ${pct.toStringAsFixed(1)}%',
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurface.withValues(alpha: 0.6),
          ),
        ),
      ],
    );
  }
}
