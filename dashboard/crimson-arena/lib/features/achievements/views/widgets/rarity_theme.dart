import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../core/constants/arena_colors.dart';

/// Rarity-based visual theme for achievement cards and popups.
///
/// Maps each [AchievementRarity] to FDL v2 colors:
/// - Common: slateGrey (gray)
/// - Uncommon: hunterGreen
/// - Rare: powderBlush (blue/pink tint)
/// - Epic: burgundy
/// - Legendary: cream with gold glow
class RarityTheme {
  /// The primary glow / accent color for this rarity.
  final Color glowColor;

  /// The label text color (often same as glow).
  final Color labelColor;

  /// Background tint for badges and cards.
  final Color backgroundTint;

  const RarityTheme({
    required this.glowColor,
    required this.labelColor,
    required this.backgroundTint,
  });

  /// Resolve the theme for a given rarity.
  static RarityTheme of(AchievementRarity rarity) {
    switch (rarity) {
      case AchievementRarity.common:
        return RarityTheme(
          glowColor: FiftyColors.slateGrey,
          labelColor: FiftyColors.slateGrey,
          backgroundTint: FiftyColors.slateGrey.withValues(alpha: 0.15),
        );
      case AchievementRarity.uncommon:
        return RarityTheme(
          glowColor: FiftyColors.hunterGreen,
          labelColor: FiftyColors.hunterGreen,
          backgroundTint: FiftyColors.hunterGreen.withValues(alpha: 0.15),
        );
      case AchievementRarity.rare:
        return RarityTheme(
          glowColor: FiftyColors.powderBlush,
          labelColor: FiftyColors.powderBlush,
          backgroundTint: FiftyColors.powderBlush.withValues(alpha: 0.15),
        );
      case AchievementRarity.epic:
        return RarityTheme(
          glowColor: FiftyColors.burgundy,
          labelColor: FiftyColors.burgundy,
          backgroundTint: FiftyColors.burgundy.withValues(alpha: 0.15),
        );
      case AchievementRarity.legendary:
        return const RarityTheme(
          glowColor: ArenaColors.legendaryGold,
          labelColor: ArenaColors.legendaryGold,
          backgroundTint: ArenaColors.legendaryGoldTint,
        );
    }
  }
}
