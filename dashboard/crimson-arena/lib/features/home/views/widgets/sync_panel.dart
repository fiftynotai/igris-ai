import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../data/models/sync_status_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Sync Panel.
///
/// Displays the sync pipeline status between local and VPS brain:
/// connection status, last push time, last pull time, queue depth.
class SyncPanel extends StatelessWidget {
  const SyncPanel({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final sync = vm.syncStatus.value;

      if (sync == null) {
        return ArenaCard(
          title: 'SYNC PIPELINE',
          child: Text(
            'No sync data available',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      final isOnline = sync.isOnline;
      final statusColor =
          isOnline ? ext.success : colorScheme.onSurfaceVariant;
      final queueDepth = sync.queueDepth;
      final queueColor = queueDepth == 0
          ? ext.success
          : (queueDepth > 10 ? colorScheme.primary : ext.warning);

      return ArenaCard(
        title: 'SYNC PIPELINE',
        child: Row(
          children: [
            // Status
            _SyncStat(
              label: 'STATUS',
              value: isOnline ? 'ONLINE' : 'OFFLINE',
              color: statusColor,
            ),
            const SizedBox(width: FiftySpacing.xl),

            // Last push
            _SyncStat(
              label: 'LAST PUSH',
              value: FormatUtils.timeAgo(sync.lastPush),
              color: colorScheme.onSurface.withValues(alpha: 0.7),
            ),
            const SizedBox(width: FiftySpacing.xl),

            // Last pull
            _SyncStat(
              label: 'LAST PULL',
              value: FormatUtils.timeAgo(sync.lastPull),
              color: colorScheme.onSurface.withValues(alpha: 0.7),
            ),
            const SizedBox(width: FiftySpacing.xl),

            // Queue
            _SyncStat(
              label: 'QUEUE',
              value: queueDepth.toString(),
              color: queueColor,
            ),
          ],
        ),
      );
    });
  }
}

/// A single sync stat display.
class _SyncStat extends StatelessWidget {
  final String label;
  final String value;
  final Color color;

  const _SyncStat({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: textTheme.labelLarge!.copyWith(
            color: color,
          ),
        ),
      ],
    );
  }
}
