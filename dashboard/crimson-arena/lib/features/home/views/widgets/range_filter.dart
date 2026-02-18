import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../controllers/home_view_model.dart';

/// Time range filter control.
///
/// Displays three segmented buttons: Today, Week, All Time.
/// Changes the dashboard data range when tapped.
class RangeFilter extends StatelessWidget {
  const RangeFilter({super.key});

  static const _ranges = [
    ('today', 'TODAY'),
    ('week', 'WEEK'),
    ('all', 'ALL'),
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final current = vm.currentRange.value;

      return Row(
        mainAxisSize: MainAxisSize.min,
        children: _ranges.map((entry) {
          final (value, label) = entry;
          final isActive = current == value;

          return Padding(
            padding: const EdgeInsets.only(right: FiftySpacing.xs),
            child: InkWell(
              onTap: () => vm.setRange(value),
              borderRadius: FiftyRadii.smRadius,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: FiftySpacing.sm,
                  vertical: FiftySpacing.xs,
                ),
                decoration: BoxDecoration(
                  color: isActive
                      ? colorScheme.primary.withValues(alpha: 0.15)
                      : Colors.transparent,
                  borderRadius: FiftyRadii.smRadius,
                  border: isActive
                      ? Border.all(
                          color: colorScheme.primary.withValues(alpha: 0.3),
                          width: 1,
                        )
                      : Border.all(
                          color: colorScheme.outline,
                          width: 1,
                        ),
                ),
                child: Text(
                  label,
                  style: textTheme.labelSmall!.copyWith(
                    fontWeight: isActive
                        ? FiftyTypography.bold
                        : FiftyTypography.medium,
                    color: isActive
                        ? colorScheme.onSurface
                        : colorScheme.onSurfaceVariant,
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
                ),
              ),
            ),
          );
        }).toList(),
      );
    });
  }
}
