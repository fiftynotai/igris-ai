import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

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
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final heatmap = vm.skillHeatmap;
      final total = vm.skillHeatmapTotal.value;

      if (heatmap.isEmpty) {
        return ArenaCard(
          title: 'SKILL HEATMAP',
          trailing: Text(
            '0 total',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.slateGrey,
            ),
          ),
          child: Text(
            '> No skill data yet',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
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
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.slateGrey,
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
    final widthFraction = maxCount > 0
        ? (count / maxCount).clamp(0.02, 1.0)
        : 0.0;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Skill name
          SizedBox(
            width: 100,
            child: Text(
              '/$name',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.6),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Bar
          Expanded(
            child: Container(
              height: 10,
              decoration: BoxDecoration(
                color: FiftyColors.cream.withValues(alpha: 0.05),
                borderRadius: FiftyRadii.smRadius,
              ),
              child: FractionallySizedBox(
                alignment: Alignment.centerLeft,
                widthFactor: widthFraction.toDouble(),
                child: Container(
                  decoration: BoxDecoration(
                    color: FiftyColors.burgundy,
                    borderRadius: FiftyRadii.smRadius,
                  ),
                ),
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Count
          SizedBox(
            width: 36,
            child: Text(
              count.toString(),
              textAlign: TextAlign.right,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.cream.withValues(alpha: 0.7),
              ),
            ),
          ),
        ],
      ),
    );
  }
}
