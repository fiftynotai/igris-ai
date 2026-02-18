import 'package:crimson_arena/core/constants/arena_breakpoints.dart';
import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../controllers/achievements_view_model.dart';
import 'rarity_theme.dart';

/// Responsive grid of achievement cards.
///
/// Filtered by the current category selection in [AchievementsViewModel].
/// Cards show: icon, name, description, points, rarity badge, progress bar,
/// and locked/unlocked visual state.
class AchievementGrid extends StatelessWidget {
  const AchievementGrid({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AchievementsViewModel>();
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Obx(() {
      final achievements = vm.filteredAchievements;

      if (achievements.isEmpty) {
        return Center(
          child: Text(
            'No achievements in this category',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      return LayoutBuilder(
        builder: (context, constraints) {
          // Responsive column count.
          final width = constraints.maxWidth;
          final crossAxisCount = ArenaBreakpoints.gridColumns(width);

          return GridView.builder(
            padding: const EdgeInsets.all(FiftySpacing.md),
            gridDelegate: SliverGridDelegateWithFixedCrossAxisCount(
              crossAxisCount: crossAxisCount,
              mainAxisSpacing: FiftySpacing.md,
              crossAxisSpacing: FiftySpacing.md,
              childAspectRatio: 1.4,
            ),
            itemCount: achievements.length,
            itemBuilder: (_, index) {
              final achievement = achievements[index];
              return _AchievementCard(achievement: achievement);
            },
          );
        },
      );
    });
  }
}

/// Individual achievement card within the grid.
class _AchievementCard extends StatelessWidget {
  final Achievement<void> achievement;

  const _AchievementCard({required this.achievement});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AchievementsViewModel>();
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Obx(() {
      final unlocked = vm.isUnlocked(achievement.id);
      final progress = vm.getProgress(achievement.id);
      final details = vm.getProgressDetails(achievement.id);
      final rarityTheme = RarityTheme.of(achievement.rarity);

      return AnimatedContainer(
        duration: const Duration(milliseconds: 300),
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainerHighest,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(
            color: unlocked
                ? rarityTheme.glowColor.withValues(alpha: 0.5)
                : colorScheme.outline,
            width: unlocked ? 1.5 : 1,
          ),
          boxShadow: unlocked
              ? [
                  BoxShadow(
                    color: rarityTheme.glowColor.withValues(alpha: 0.15),
                    blurRadius: 12,
                    spreadRadius: 1,
                  ),
                ]
              : null,
        ),
        child: Opacity(
          opacity: unlocked ? 1.0 : 0.70,
          child: Padding(
            padding: const EdgeInsets.all(FiftySpacing.md),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                // Top row: icon + rarity badge
                Row(
                  children: [
                    // Icon circle
                    Container(
                      width: 36,
                      height: 36,
                      decoration: BoxDecoration(
                        shape: BoxShape.circle,
                        color: unlocked
                            ? rarityTheme.glowColor.withValues(alpha: 0.15)
                            : colorScheme.outline,
                      ),
                      child: Icon(
                        unlocked
                            ? (achievement.icon ?? Icons.emoji_events)
                            : Icons.lock_outline,
                        color: unlocked
                            ? rarityTheme.glowColor
                            : colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
                        size: 18,
                      ),
                    ),
                    const Spacer(),
                    // Rarity badge
                    _RarityBadge(rarity: achievement.rarity),
                  ],
                ),

                const SizedBox(height: FiftySpacing.sm),

                // Achievement name
                Tooltip(
                  message: achievement.name,
                  child: Text(
                    achievement.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.bodyMedium!.copyWith(
                      fontWeight: FiftyTypography.bold,
                      color: unlocked ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
                    ),
                  ),
                ),

                const SizedBox(height: 2),

                // Description
                Expanded(
                  child: Text(
                    achievement.description ?? '',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: textTheme.labelSmall!.copyWith(
                      fontWeight: FiftyTypography.regular,
                      color: colorScheme.onSurfaceVariant.withValues(alpha: 0.8),
                      height: 1.3,
                    ),
                  ),
                ),

                // Progress bar (for count-based achievements).
                if (!unlocked && details.target > 1) ...[
                  const SizedBox(height: FiftySpacing.xs),
                  _ProgressIndicator(
                    progress: progress,
                    current: details.current,
                    target: details.target,
                    color: rarityTheme.glowColor,
                  ),
                ],

                // Bottom row: points + status
                const SizedBox(height: FiftySpacing.xs),
                Row(
                  children: [
                    Text(
                      '${achievement.points} PTS',
                      style: textTheme.labelSmall!.copyWith(
                        fontWeight: FiftyTypography.bold,
                        color: unlocked
                            ? rarityTheme.glowColor
                            : colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
                        letterSpacing: FiftyTypography.letterSpacingLabel,
                      ),
                    ),
                    const Spacer(),
                    if (unlocked)
                      Icon(
                        Icons.check_circle,
                        color: rarityTheme.glowColor,
                        size: 16,
                      )
                    else
                      Icon(
                        Icons.lock_outline,
                        color: colorScheme.onSurfaceVariant.withValues(alpha: 0.4),
                        size: 14,
                      ),
                  ],
                ),
              ],
            ),
          ),
        ),
      );
    });
  }
}

/// Compact rarity label badge.
class _RarityBadge extends StatelessWidget {
  final AchievementRarity rarity;

  const _RarityBadge({required this.rarity});

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;
    final theme = RarityTheme.of(rarity);

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.xs,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: theme.backgroundTint,
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: theme.glowColor.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Text(
        rarity.displayName.toUpperCase(),
        style: textTheme.labelSmall!.copyWith(
          fontSize: 11,
          fontWeight: FiftyTypography.bold,
          color: theme.labelColor,
          letterSpacing: FiftyTypography.letterSpacingLabel,
        ),
      ),
    );
  }
}

/// Thin progress bar with current/target label.
class _ProgressIndicator extends StatelessWidget {
  final double progress;
  final int current;
  final int target;
  final Color color;

  const _ProgressIndicator({
    required this.progress,
    required this.current,
    required this.target,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Progress bar track
        ClipRRect(
          borderRadius: FiftyRadii.smRadius,
          child: SizedBox(
            height: 4,
            child: LinearProgressIndicator(
              value: progress,
              backgroundColor: colorScheme.outline,
              color: color.withValues(alpha: 0.7),
            ),
          ),
        ),
        const SizedBox(height: 2),
        // Counter label
        Text(
          '$current / $target',
          style: textTheme.labelSmall!.copyWith(
            fontSize: 11,
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant.withValues(alpha: 0.6),
          ),
        ),
      ],
    );
  }
}
