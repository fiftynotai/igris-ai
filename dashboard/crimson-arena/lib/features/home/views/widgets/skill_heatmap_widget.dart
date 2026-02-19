import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Skill Heatmap bar chart.
///
/// Displays a horizontal bar chart showing skill invocation counts,
/// sorted by frequency. Uses fl_chart BarChart. The top N skills
/// are shown.
class SkillHeatmapWidget extends StatelessWidget {
  /// Maximum number of skill bars to display.
  static const int maxBars = 15;

  const SkillHeatmapWidget({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final heatmap = vm.skillHeatmap;
      final total = vm.skillHeatmapTotal.value;

      if (heatmap.isEmpty) {
        return ArenaCard(
          title: 'SKILL HEATMAP',
          trailing: Text(
            '0 total',
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurfaceVariant,
            ),
          ),
          child: Text(
            'No skill data available',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      // Sort by count descending and take top N.
      final sorted = heatmap.entries.toList()
        ..sort((a, b) => b.value.compareTo(a.value));
      final topSkills = sorted.take(maxBars).toList();
      final maxCount = topSkills.first.value;

      return ArenaCard(
        title: 'SKILL HEATMAP',
        trailing: Text(
          '${FormatUtils.formatNumber(total)} total',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: topSkills.map((entry) {
            return _SkillBar(
              name: entry.key,
              count: entry.value,
              maxCount: maxCount,
            );
          }).toList(),
        ),
      );
    });
  }
}

/// A single skill bar row with label, bar, and count.
class _SkillBar extends StatelessWidget {
  final String name;
  final int count;
  final int maxCount;

  const _SkillBar({
    required this.name,
    required this.count,
    required this.maxCount,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final widthFraction = maxCount > 0
        ? (count / maxCount).clamp(0.02, 1.0)
        : 0.0;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Skill name
          SizedBox(
            width: ArenaSizes.skillNameWidth,
            child: Tooltip(
              message: '/$name',
              child: Text(
                '/$name',
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.medium,
                  color: colorScheme.onSurface.withValues(alpha: 0.6),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Bar
          Expanded(
            child: Container(
              height: ArenaSizes.skillBarHeight,
              decoration: BoxDecoration(
                color: colorScheme.onSurface.withValues(alpha: 0.05),
                borderRadius: FiftyRadii.smRadius,
              ),
              child: FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: widthFraction.toDouble(),
                child: Container(
                  decoration: BoxDecoration(
                    color: colorScheme.primary,
                    borderRadius: FiftyRadii.smRadius,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Count
          SizedBox(
            width: ArenaSizes.skillCountWidth,
            child: Text(
              count.toString(),
              textAlign: TextAlign.right,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
