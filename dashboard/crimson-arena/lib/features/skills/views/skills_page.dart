import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../core/constants/arena_sizes.dart';
import '../../../core/constants/skill_constants.dart';
import '../../../shared/widgets/arena_scaffold.dart';
import '../controllers/skills_view_model.dart';
import 'widgets/skill_card_widget.dart';

/// Skills page -- RPG game card gallery for all 22 Igris AI skills.
///
/// Layout:
/// ```
/// ArenaScaffold(title: 'SKILLS', activeTabIndex: 4)
///   Column
///     SummaryHeader    -- total skills, total invocations
///     SectionHeader    -- "Skills"
///     CategoryChips    -- All, Combat, Utility, Support, etc.
///     SortChips        -- Usage, Alpha, Rarity
///     Expanded(Grid)   -- responsive grid of SkillCardWidget
/// ```
class SkillsPage extends StatelessWidget {
  const SkillsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<SkillsViewModel>();

    return ArenaScaffold(
      title: 'SKILLS',
      activeTabIndex: 4,
      body: Obx(() {
        if (vm.isLoading.value) {
          return const Center(
            child: FiftyLoadingIndicator(
              style: FiftyLoadingStyle.sequence,
              size: FiftyLoadingSize.large,
              sequences: [
                '> LOADING SKILL REGISTRY...',
                '> SCANNING INVOCATIONS...',
                '> RESOLVING RARITY TIERS...',
                '> READY.',
              ],
            ),
          );
        }

        return Column(
          children: [
            const SizedBox(height: FiftySpacing.md),

            // Summary header
            _SkillsSummaryHeader(vm: vm),

            const SizedBox(height: FiftySpacing.md),

            // Section header
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: FiftySpacing.md),
              child: FiftySectionHeader(
                title: 'Skills',
                size: FiftySectionHeaderSize.small,
                showDivider: false,
              ),
            ),

            // Category filter chips
            _CategoryFilterChips(vm: vm),

            const SizedBox(height: FiftySpacing.xs),

            // Sort chips
            _SortChips(vm: vm),

            const SizedBox(height: FiftySpacing.sm),

            // Skill card grid (fills remaining space)
            Expanded(
              child: _SkillCardGrid(vm: vm),
            ),
          ],
        );
      }),
    );
  }
}

/// Compact summary header showing total skill count and invocations.
class _SkillsSummaryHeader extends StatelessWidget {
  final SkillsViewModel vm;

  const _SkillsSummaryHeader({required this.vm});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.md),
      child: Container(
        padding: const EdgeInsets.all(FiftySpacing.md),
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainerHighest,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: colorScheme.outline,
            width: 1,
          ),
        ),
        child: Row(
          children: [
            // Total skills
            _SummaryItem(
              label: 'SKILLS',
              value: '${SkillConstants.registry.length}',
              textTheme: textTheme,
              colorScheme: colorScheme,
            ),
            const SizedBox(width: FiftySpacing.xxl),
            // Total invocations
            Obx(() => _SummaryItem(
                  label: 'TOTAL INVOCATIONS',
                  value: '${vm.skillHeatmapTotal.value}',
                  textTheme: textTheme,
                  colorScheme: colorScheme,
                )),
            const SizedBox(width: FiftySpacing.xxl),
            // Filtered count
            Obx(() => _SummaryItem(
                  label: 'SHOWING',
                  value: '${vm.filteredSkills.length}',
                  textTheme: textTheme,
                  colorScheme: colorScheme,
                )),
          ],
        ),
      ),
    );
  }
}

/// Small label + value column for the summary header.
class _SummaryItem extends StatelessWidget {
  final String label;
  final String value;
  final TextTheme textTheme;
  final ColorScheme colorScheme;

  const _SummaryItem({
    required this.label,
    required this.value,
    required this.textTheme,
    required this.colorScheme,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.3),
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: textTheme.titleMedium!.copyWith(
            fontWeight: FiftyTypography.extraBold,
            color: colorScheme.onSurface,
          ),
        ),
      ],
    );
  }
}

/// Horizontal row of category filter chips.
class _CategoryFilterChips extends StatelessWidget {
  final SkillsViewModel vm;

  const _CategoryFilterChips({required this.vm});

  @override
  Widget build(BuildContext context) {
    return Obx(() {
      final active = vm.filterCategory.value;

      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.md),
        child: Row(
          children: SkillConstants.categories
              .map((category) => Padding(
                    padding: const EdgeInsets.only(right: FiftySpacing.xs),
                    child: FiftyChip(
                      label: category,
                      selected: active == category,
                      avatar: category == 'All'
                          ? const Icon(Icons.apps, size: 14)
                          : (SkillConstants.categoryIcons[
                                      SkillConstants.categoryFromString(
                                          category)] !=
                                  null
                              ? Icon(
                                  SkillConstants.categoryIcons[
                                      SkillConstants.categoryFromString(
                                          category)],
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

/// Sort mode chips row.
class _SortChips extends StatelessWidget {
  final SkillsViewModel vm;

  const _SortChips({required this.vm});

  static const _modes = [
    ('usage', 'By Usage', Icons.trending_up),
    ('alpha', 'A-Z', Icons.sort_by_alpha),
    ('rarity', 'By Rarity', Icons.auto_awesome),
  ];

  @override
  Widget build(BuildContext context) {
    return Obx(() {
      final active = vm.sortMode.value;

      return SingleChildScrollView(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.md),
        child: Row(
          children: _modes
              .map((mode) => Padding(
                    padding: const EdgeInsets.only(right: FiftySpacing.xs),
                    child: FiftyChip(
                      label: mode.$2,
                      selected: active == mode.$1,
                      avatar: Icon(mode.$3, size: 14),
                      onTap: () => vm.sortBy(mode.$1),
                    ),
                  ))
              .toList(),
        ),
      );
    });
  }
}

/// Skill-specific grid column logic — denser than the shared breakpoints
/// because skill cards are compact.
///
/// - >1400 px : 6 columns
/// - >1100 px : 5 columns
/// - >800 px  : 4 columns
/// - >500 px  : 3 columns
/// - >300 px  : 2 columns
/// - otherwise: 1 column
int _skillGridColumns(double width) {
  if (width > 1400) return 6;
  if (width > 1100) return 5;
  if (width > 800) return 4;
  if (width > 500) return 3;
  if (width > 300) return 2;
  return 1;
}

/// Responsive grid of [SkillCardWidget] cards.
class _SkillCardGrid extends StatelessWidget {
  final SkillsViewModel vm;

  const _SkillCardGrid({required this.vm});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Obx(() {
      final skills = vm.filteredSkills;

      if (skills.isEmpty) {
        return Center(
          child: Text(
            'No skills in this category',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      // Find max invocations for usage bar normalization.
      final maxInvocations = skills.fold<int>(
        0,
        (max, card) => card.invocations > max ? card.invocations : max,
      );

      return LayoutBuilder(
        builder: (context, constraints) {
          final crossAxisCount =
              _skillGridColumns(constraints.maxWidth);

          return GridView.builder(
            padding: const EdgeInsets.all(FiftySpacing.md),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              mainAxisSpacing: FiftySpacing.md,
              crossAxisSpacing: FiftySpacing.md,
              childAspectRatio: ArenaSizes.skillCardAspectRatio,
            ),
            itemCount: skills.length,
            itemBuilder: (_, index) {
              final skill = skills[index];
              return SkillCardWidget(
                model: skill,
                maxInvocations: maxInvocations,
              );
            },
          );
        },
      );
    });
  }
}
