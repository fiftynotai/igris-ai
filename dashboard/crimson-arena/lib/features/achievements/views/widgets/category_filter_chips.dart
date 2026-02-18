import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/achievement_catalog.dart';
import '../../controllers/achievements_view_model.dart';

/// Horizontal row of category filter chips for the achievement grid.
///
/// Includes "All" plus one chip per achievement category.
/// The active chip is highlighted with burgundy accent styling.
class CategoryFilterChips extends StatelessWidget {
  const CategoryFilterChips({super.key});

  static const List<String> _allFilters = [
    'All',
    ...AchievementCatalog.categories,
  ];

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AchievementsViewModel>();

    return Obx(() {
      final active = vm.filterCategory.value;

      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.md),
        child: Row(
          children: _allFilters
              .map((category) => Padding(
                    padding: const EdgeInsets.only(right: FiftySpacing.xs),
                    child: _FilterChip(
                      label: category.toUpperCase(),
                      isActive: active == category,
                      icon: category == 'All'
                          ? Icons.apps
                          : AchievementCatalog.categoryIcons[category],
                      onTap: () => vm.filterBy(category),
                    ),
                  ))
              .toList(),
        ),
      );
    });
  }
}

/// Single filter chip button.
class _FilterChip extends StatelessWidget {
  final String label;
  final bool isActive;
  final IconData? icon;
  final VoidCallback onTap;

  const _FilterChip({
    required this.label,
    required this.isActive,
    this.icon,
    required this.onTap,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return InkWell(
      onTap: onTap,
      borderRadius: FiftyRadii.smRadius,
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 200),
        padding: const EdgeInsets.symmetric(
          horizontal: FiftySpacing.sm,
          vertical: FiftySpacing.xs,
        ),
        decoration: BoxDecoration(
          color: isActive
              ? colorScheme.primary.withValues(alpha: 0.15)
              : Colors.transparent,
          borderRadius: FiftyRadii.smRadius,
          border: Border.all(
            color: isActive
                ? colorScheme.primary.withValues(alpha: 0.4)
                : colorScheme.outline,
            width: 1,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (icon != null) ...[
              Icon(
                icon,
                size: 14,
                color: isActive ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
              ),
              const SizedBox(width: FiftySpacing.xs),
            ],
            Text(
              label,
              style: textTheme.labelSmall!.copyWith(
                fontWeight:
                    isActive ? FiftyTypography.bold : FiftyTypography.medium,
                color: isActive ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
                letterSpacing: FiftyTypography.letterSpacingLabel,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
