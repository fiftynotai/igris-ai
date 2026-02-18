import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../controllers/instances_view_model.dart';

/// Compact vitals strip displayed at the top of the INSTANCES page.
///
/// Shows three inline metrics: HP (budget), CTX (context window),
/// and SYNC (sync pipeline status) as compact labeled bars.
/// Data is sourced from the WebSocket brain state.
class CompactVitalsStrip extends StatelessWidget {
  const CompactVitalsStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<InstancesViewModel>();

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: FiftyColors.surfaceDark,
        border: Border(
          bottom: BorderSide(
            color: FiftyColors.borderDark,
            width: 1,
          ),
        ),
      ),
      child: Obx(() {
        final count = vm.instances.length;
        final active = vm.activeCount;
        final idle = vm.idleCount;

        return Row(
          children: [
            _buildVital(
              label: 'INSTANCES',
              value: '$count',
              color: FiftyColors.burgundy,
            ),
            const SizedBox(width: FiftySpacing.lg),
            _buildVital(
              label: 'ACTIVE',
              value: '$active',
              color: FiftyColors.hunterGreen,
            ),
            const SizedBox(width: FiftySpacing.lg),
            _buildVital(
              label: 'IDLE',
              value: '$idle',
              color: FiftyColors.slateGrey,
            ),
            const Spacer(),
            // Connection quality indicator
            _buildSyncIndicator(),
          ],
        );
      }),
    );
  }

  Widget _buildVital({
    required String label,
    required String value,
    required Color color,
  }) {
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
          label,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.semiBold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        Text(
          value,
          style: GoogleFonts.sourceCodePro(
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: color,
          ),
        ),
      ],
    );
  }

  Widget _buildSyncIndicator() {
    return Obx(() {
      final wsService = Get.find<InstancesViewModel>();
      final hasData = wsService.instances.isNotEmpty;

      return Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: hasData ? FiftyColors.hunterGreen : FiftyColors.slateGrey,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          Text(
            hasData ? 'SYNCED' : 'NO DATA',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.semiBold,
              color:
                  hasData ? FiftyColors.hunterGreen : FiftyColors.slateGrey,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ],
      );
    });
  }
}
