import 'package:crimson_arena/core/theme/arena_text_styles.dart';
import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

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
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final vm = Get.find<InstancesViewModel>();

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        border: Border(
          bottom: BorderSide(
            color: colorScheme.outline,
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
              context,
              label: 'INSTANCES',
              value: '$count',
              color: colorScheme.primary,
            ),
            const SizedBox(width: FiftySpacing.lg),
            _buildVital(
              context,
              label: 'ACTIVE',
              value: '$active',
              color: ext.success,
            ),
            const SizedBox(width: FiftySpacing.lg),
            _buildVital(
              context,
              label: 'IDLE',
              value: '$idle',
              color: colorScheme.onSurfaceVariant,
            ),
            const Spacer(),
            // Connection quality indicator
            _buildSyncIndicator(context),
          ],
        );
      }),
    );
  }

  Widget _buildVital(
    BuildContext context, {
    required String label,
    required String value,
    required Color color,
  }) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

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
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        Text(
          value,
          style: ArenaTextStyles.mono(
            context,
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: color,
          ),
        ),
      ],
    );
  }

  Widget _buildSyncIndicator(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

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
              color: hasData ? ext.success : colorScheme.onSurfaceVariant,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          Text(
            hasData ? 'SYNCED' : 'NO DATA',
            style: textTheme.labelSmall!.copyWith(
              color:
                  hasData ? ext.success : colorScheme.onSurfaceVariant,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ],
      );
    });
  }
}
