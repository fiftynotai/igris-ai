import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

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
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final sync = vm.syncStatus.value;

      if (sync == null) {
        return ArenaCard(
          title: 'SYNC PIPELINE',
          child: Text(
            '> No sync data',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      final isOnline = sync.isOnline;
      final statusColor =
          isOnline ? FiftyColors.hunterGreen : FiftyColors.slateGrey;
      final queueDepth = sync.queueDepth;
      final queueColor = queueDepth == 0
          ? FiftyColors.hunterGreen
          : (queueDepth > 10 ? FiftyColors.burgundy : FiftyColors.warning);

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
              color: FiftyColors.cream.withValues(alpha: 0.7),
            ),
            const SizedBox(width: FiftySpacing.xl),

            // Last pull
            _SyncStat(
              label: 'LAST PULL',
              value: FormatUtils.timeAgo(sync.lastPull),
              color: FiftyColors.cream.withValues(alpha: 0.7),
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
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.semiBold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.bodyMedium,
            fontWeight: FiftyTypography.bold,
            color: color,
          ),
        ),
      ],
    );
  }
}
