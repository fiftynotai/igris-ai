import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Brief Velocity Widget.
///
/// Shows brief completion status as a compact summary strip with
/// status distribution bars. Shows how many briefs are in each stage
/// of the pipeline.
class BriefVelocityWidget extends StatelessWidget {
  const BriefVelocityWidget({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final briefs = vm.brainBriefs;
      final statusCounts = vm.briefStatusCounts;
      final total = briefs.length;

      if (total == 0) {
        return ArenaCard(
          title: 'BRIEF VELOCITY',
          child: Text(
            '> No briefs tracked',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      // Calculate completion rate
      final done = statusCounts['Done'] ?? 0;
      final completionRate =
          total > 0 ? (done / total * 100).toStringAsFixed(0) : '0';

      return ArenaCard(
        title: 'BRIEF VELOCITY',
        trailing: Text(
          '$done/$total done ($completionRate%)',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.slateGrey,
          ),
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Stacked status bar
            _StatusBar(statusCounts: statusCounts, total: total),
            const SizedBox(height: FiftySpacing.sm),

            // Status legend
            Wrap(
              spacing: FiftySpacing.md,
              runSpacing: FiftySpacing.xs,
              children: _statusOrder
                  .where((s) => statusCounts.containsKey(s))
                  .map((status) {
                return _StatusLegend(
                  status: status,
                  count: statusCounts[status]!,
                  color: _statusColor(status),
                );
              }).toList(),
            ),
          ],
        ),
      );
    });
  }

  static const _statusOrder = [
    'Done',
    'In Progress',
    'Ready',
    'Draft',
    'Blocked',
  ];

  static Color _statusColor(String status) {
    switch (status) {
      case 'Done':
        return FiftyColors.hunterGreen;
      case 'In Progress':
        return FiftyColors.warning;
      case 'Ready':
        return FiftyColors.slateGrey;
      case 'Draft':
        return FiftyColors.cream.withValues(alpha: 0.3);
      case 'Blocked':
        return FiftyColors.burgundy;
      default:
        return FiftyColors.slateGrey;
    }
  }
}

/// A stacked horizontal bar showing brief status distribution.
class _StatusBar extends StatelessWidget {
  final Map<String, int> statusCounts;
  final int total;

  const _StatusBar({required this.statusCounts, required this.total});

  @override
  Widget build(BuildContext context) {
    if (total == 0) return const SizedBox.shrink();

    final segments = <_BarSegment>[];
    for (final status in [
      'Done',
      'In Progress',
      'Ready',
      'Draft',
      'Blocked',
    ]) {
      final count = statusCounts[status] ?? 0;
      if (count > 0) {
        segments.add(_BarSegment(
          fraction: count / total,
          color: BriefVelocityWidget._statusColor(status),
        ));
      }
    }

    return ClipRRect(
      borderRadius: FiftyRadii.smRadius,
      child: SizedBox(
        height: 10,
        child: Row(
          children: segments.asMap().entries.map((entry) {
            final seg = entry.value;
            final isLast = entry.key == segments.length - 1;
            return Flexible(
              flex: (seg.fraction * 100).round().clamp(1, 100),
              child: Container(
                margin: EdgeInsets.only(right: isLast ? 0 : 1),
                color: seg.color,
              ),
            );
          }).toList(),
        ),
      ),
    );
  }
}

class _BarSegment {
  final double fraction;
  final Color color;

  const _BarSegment({required this.fraction, required this.color});
}

/// A compact legend item: color dot + status + count.
class _StatusLegend extends StatelessWidget {
  final String status;
  final int count;
  final Color color;

  const _StatusLegend({
    required this.status,
    required this.count,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 6,
          height: 6,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color,
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        Text(
          '$status ($count)',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.cream.withValues(alpha: 0.5),
          ),
        ),
      ],
    );
  }
}
