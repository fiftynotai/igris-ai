import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/arena_sizes.dart';
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
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final briefs = vm.brainBriefs;
      final statusCounts = vm.briefStatusCounts;
      final total = briefs.length;

      if (total == 0) {
        return ArenaCard(
          title: 'BRIEF VELOCITY',
          child: Text(
            'No briefs tracked',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
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
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant,
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
                  color: _statusColor(status, colorScheme, ext),
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

  static Color _statusColor(
    String status,
    ColorScheme colorScheme,
    FiftyThemeExtension ext,
  ) {
    switch (status) {
      case 'Done':
        return ext.success;
      case 'In Progress':
        return ext.warning;
      case 'Ready':
        return colorScheme.onSurfaceVariant;
      case 'Draft':
        return colorScheme.onSurface.withValues(alpha: 0.3);
      case 'Blocked':
        return colorScheme.primary;
      default:
        return colorScheme.onSurfaceVariant;
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

    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;

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
          color: BriefVelocityWidget._statusColor(status, colorScheme, ext),
        ));
      }
    }

    return ClipRRect(
      borderRadius: FiftyRadii.smRadius,
      child: SizedBox(
        height: ArenaSizes.statusBarHeight,
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
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: ArenaSizes.statusDotDefault,
          height: ArenaSizes.statusDotDefault,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color,
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        Text(
          '$status ($count)',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.5),
          ),
        ),
      ],
    );
  }
}
