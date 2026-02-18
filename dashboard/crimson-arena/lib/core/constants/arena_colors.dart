import 'dart:ui';

/// Game-specific colors that are NOT part of the FDL v2 token palette.
///
/// The FDL theme ([FiftyColors]) provides the core brand palette:
/// burgundy, hunterGreen, slateGrey, cream, powderBlush, etc.
///
/// This class holds only the supplementary colors unique to Crimson
/// Arena's gaming layer -- primarily the legendary gold rarity tint
/// used by the achievement system.
///
/// If a color exists in [FiftyColors], use it from there instead.
class ArenaColors {
  ArenaColors._();

  // ---------------------------------------------------------------------------
  // Achievement rarity: Legendary
  // ---------------------------------------------------------------------------

  /// Primary legendary gold accent (glow + label).
  static const Color legendaryGold = Color(0xFFD4A843);

  /// Translucent legendary gold for badge / card backgrounds.
  ///
  /// Equivalent to `legendaryGold.withValues(alpha: 0.15)` but stored as
  /// a compile-time constant for consistency with [RarityTheme].
  static const Color legendaryGoldTint = Color(0x26D4A843);
}
