import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
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
                    child: FiftyChip(
                      label: category,
                      selected: active == category,
                      avatar: category == 'All'
                          ? const Icon(Icons.apps, size: 14)
                          : (AchievementCatalog.categoryIcons[category] != null
                              ? Icon(
                                  AchievementCatalog.categoryIcons[category],
                                  size: 14,
                                )
                              : null),
                      onTap: () => vm.filterBy(category),
                    ),
                  ))
              .toList(),
        ),
      );
    });
  }
}

