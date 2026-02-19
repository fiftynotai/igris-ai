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

  // ---------------------------------------------------------------------------
  // Context breakdown category colors
  // ---------------------------------------------------------------------------

  /// System prompt segment.
  static const Color breakdownSystemPrompt = Color(0xFFFF6D00);

  /// System tools segment.
  static const Color breakdownSystemTools = Color(0xFF42A5F5);

  /// MCP tools segment.
  static const Color breakdownMcpTools = Color(0xFF5C6BC0);

  /// Custom agents segment.
  static const Color breakdownAgents = Color(0xFF26A69A);

  /// Rules segment.
  static const Color breakdownRules = Color(0xFFAB47BC);

  /// CLAUDE.md segment.
  static const Color breakdownClaudeMd = Color(0xFFFFCA28);

  /// Memory segment (session, guidelines, persona).
  static const Color breakdownMemory = Color(0xFFEC407A);

  /// Skills segment.
  static const Color breakdownSkills = Color(0xFF9CCC65);

  /// Conversation messages segment.
  static const Color breakdownMessages = Color(0xFF00E5FF);

  /// Auto-compact buffer segment.
  static const Color breakdownAutocompact = Color(0xFF78909C);

  /// Free / remaining space segment.
  static const Color breakdownFreeSpace = Color(0xFF37474F);

  /// Lookup map from segment key to color.
  static const Map<String, Color> breakdownColorMap = {
    'system_prompt': breakdownSystemPrompt,
    'system_tools': breakdownSystemTools,
    'mcp_tools': breakdownMcpTools,
    'custom_agents': breakdownAgents,
    'rules': breakdownRules,
    'claude_md': breakdownClaudeMd,
    'memory': breakdownMemory,
    'skills': breakdownSkills,
    'messages': breakdownMessages,
    'autocompact_buffer': breakdownAutocompact,
    'free_space': breakdownFreeSpace,
  };
}
