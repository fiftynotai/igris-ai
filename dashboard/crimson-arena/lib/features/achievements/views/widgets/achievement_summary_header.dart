import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/achievements_view_model.dart';
import 'rarity_theme.dart';

/// Summary header card for the Achievements page.
///
/// Displays:
/// - Total earned points
/// - X / N unlocked count
/// - Per-rarity breakdown badges
class AchievementSummaryHeader extends StatelessWidget {
  const AchievementSummaryHeader({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AchievementsViewModel>();

    return Obx(() {
      final earned = vm.earnedPoints.value;
      final unlocked = vm.unlockedCount.value;
      final total = vm.totalCount;
      final maxPts = vm.maxPoints;
      final rarityMap = vm.unlockedRarityBreakdown;

      return ArenaCard(
        title: 'ACHIEVEMENT PROGRESS',
        trailing: _PointsBadge(earned: earned, max: maxPts),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Main stats row
            Row(
              children: [
                _StatBlock(
                  label: 'UNLOCKED',
                  value: '$unlocked / $total',
                ),
                const SizedBox(width: FiftySpacing.xxl),
                _StatBlock(
                  label: 'POINTS',
                  value: FormatUtils.formatNumber(earned),
                ),
                const SizedBox(width: FiftySpacing.xxl),
                _StatBlock(
                  label: 'COMPLETION',
                  value: total > 0
                      ? '${(unlocked / total * 100).toStringAsFixed(1)}%'
                      : '0%',
                ),
              ],
            ),

            const SizedBox(height: FiftySpacing.md),

            // Rarity breakdown row
            Wrap(
              spacing: FiftySpacing.sm,
              runSpacing: FiftySpacing.xs,
              children: AchievementRarity.values.map((rarity) {
                final count = rarityMap[rarity] ?? 0;
                return _RarityCountBadge(rarity: rarity, count: count);
              }).toList(),
            ),
          ],
        ),
      );
    });
  }
}

/// Earned / max points badge for the header trailing slot.
class _PointsBadge extends StatelessWidget {
  final int earned;
  final int max;

  const _PointsBadge({required this.earned, required this.max});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: FiftySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: colorScheme.primary.withValues(alpha: 0.15),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: colorScheme.primary.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Text(
        '${FormatUtils.formatNumber(earned)} / ${FormatUtils.formatNumber(max)} PTS',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.bold,
          color: colorScheme.primary,
          letterSpacing: FiftyTypography.letterSpacingLabel,
        ),
      ),
    );
  }
}

/// Label + value stat block used in the header row.
class _StatBlock extends StatelessWidget {
  final String label;
  final String value;

  const _StatBlock({required this.label, required this.value});

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
          style: textTheme.titleMedium!.copyWith(
            fontWeight: FiftyTypography.extraBold,
            color: colorScheme.onSurface,
          ),
        ),
      ],
    );
  }
}

/// Small badge showing count of unlocked achievements for a rarity tier.
class _RarityCountBadge extends StatelessWidget {
  final AchievementRarity rarity;
  final int count;

  const _RarityCountBadge({required this.rarity, required this.count});

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final theme = RarityTheme.of(rarity);

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: FiftySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: theme.backgroundTint,
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: theme.glowColor.withValues(alpha: 0.2),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: theme.glowColor,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          Text(
            '${rarity.displayName.toUpperCase()}: $count',
            style: textTheme.labelSmall!.copyWith(
              fontSize: 11,
              fontWeight: FiftyTypography.bold,
              color: theme.labelColor,
              letterSpacing: FiftyTypography.letterSpacingLabel,
            ),
          ),
        ],
      ),
    );
  }
}
