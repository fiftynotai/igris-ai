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

  // ---------------------------------------------------------------------------
  // Skill category accents
  // ---------------------------------------------------------------------------

  /// Combat category: crimson/red -- offensive, action-oriented skills.
  static const Color categoryCombat = Color(0xFFFF1744);

  /// Utility category: cyan/teal -- tools and maintenance skills.
  static const Color categoryUtility = Color(0xFF00BCD4);

  /// Support category: green -- helping and organizing skills.
  static const Color categorySupport = Color(0xFF4CAF50);

  /// Management category: purple -- leadership and oversight skills.
  static const Color categoryManagement = Color(0xFF7C4DFF);

  /// Research category: gold/amber -- knowledge and discovery skills.
  static const Color categoryResearch = Color(0xFFFFAB00);

  /// Creative category: magenta/pink -- art and design skills.
  static const Color categoryCreative = Color(0xFFE040FB);

  /// System category: silver/gray -- infrastructure skills.
  static const Color categorySystem = Color(0xFF78909C);
}
