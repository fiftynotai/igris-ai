import 'package:flutter/material.dart';

import 'arena_colors.dart';

/// Categories for Igris AI skills.
enum SkillCategory {
  combat,
  utility,
  support,
  management,
  research,
  creative,
  system,
}

/// Rarity tiers for skill cards, resolved from cumulative invocation count.
enum SkillRarity {
  common,
  uncommon,
  rare,
  epic,
  legendary;

  /// Human-readable display name for badges.
  String get displayName {
    switch (this) {
      case SkillRarity.common:
        return 'Common';
      case SkillRarity.uncommon:
        return 'Uncommon';
      case SkillRarity.rare:
        return 'Rare';
      case SkillRarity.epic:
        return 'Epic';
      case SkillRarity.legendary:
        return 'Legendary';
    }
  }
}

/// Static metadata for a single Igris AI skill.
@immutable
class SkillMeta {
  /// The skill command name (e.g. 'hunt', 'scan').
  final String name;

  /// Short description of the skill's purpose.
  final String description;

  /// The category this skill belongs to.
  final SkillCategory category;

  /// Agents invoked by this skill (empty if orchestrator-only).
  final List<String> agents;

  /// Icon representing this skill in the UI.
  final IconData icon;

  const SkillMeta({
    required this.name,
    required this.description,
    required this.category,
    this.agents = const [],
    required this.icon,
  });
}

/// Registry of all 22 Igris AI skills and related lookup tables.
class SkillConstants {
  SkillConstants._();

  // ---------------------------------------------------------------------------
  // Skill registry
  // ---------------------------------------------------------------------------

  /// All 22 skills indexed by command name.
  static const Map<String, SkillMeta> registry = {
    // Combat
    'hunt': SkillMeta(
      name: 'hunt',
      description: 'Implement brief (full workflow)',
      category: SkillCategory.combat,
      agents: ['architect', 'forger', 'sentinel', 'warden', 'mender'],
      icon: Icons.local_fire_department,
    ),
    'team': SkillMeta(
      name: 'team',
      description: 'Parallel execution (Agent Teams)',
      category: SkillCategory.combat,
      icon: Icons.groups,
    ),

    // Utility
    'scan': SkillMeta(
      name: 'scan',
      description: 'System status report',
      category: SkillCategory.utility,
      icon: Icons.radar,
    ),
    'sync': SkillMeta(
      name: 'sync',
      description: 'VPS brain deployment',
      category: SkillCategory.utility,
      icon: Icons.sync,
    ),
    'awaken': SkillMeta(
      name: 'awaken',
      description: 'Start/resume session',
      category: SkillCategory.utility,
      icon: Icons.power_settings_new,
    ),
    'rest': SkillMeta(
      name: 'rest',
      description: 'Pause/end session',
      category: SkillCategory.utility,
      icon: Icons.nightlight_round,
    ),

    // Support
    'register': SkillMeta(
      name: 'register',
      description: 'Create new brief',
      category: SkillCategory.support,
      icon: Icons.add_box,
    ),
    'archive': SkillMeta(
      name: 'archive',
      description: 'Archive completed brief',
      category: SkillCategory.support,
      icon: Icons.archive,
    ),
    'document': SkillMeta(
      name: 'document',
      description: 'Documentation workflow',
      category: SkillCategory.support,
      icon: Icons.description,
    ),

    // Management
    'digivolve': SkillMeta(
      name: 'digivolve',
      description: 'Agent management',
      category: SkillCategory.management,
      icon: Icons.auto_awesome,
    ),
    'projects': SkillMeta(
      name: 'projects',
      description: 'List brain-registered projects',
      category: SkillCategory.management,
      icon: Icons.folder_special,
    ),
    'portfolio': SkillMeta(
      name: 'portfolio',
      description: 'Cross-project dashboard',
      category: SkillCategory.management,
      icon: Icons.dashboard,
    ),
    'dashboard': SkillMeta(
      name: 'dashboard',
      description: 'Cross-project brief tracker',
      category: SkillCategory.management,
      icon: Icons.view_quilt,
    ),

    // Research
    'ideate': SkillMeta(
      name: 'ideate',
      description: 'Feature brainstorming',
      category: SkillCategory.research,
      icon: Icons.lightbulb,
    ),
    'audit': SkillMeta(
      name: 'audit',
      description: 'Codebase quality audit',
      category: SkillCategory.research,
      agents: ['warden'],
      icon: Icons.policy,
    ),
    'migrate-analyze': SkillMeta(
      name: 'migrate-analyze',
      description: 'Migration analysis',
      category: SkillCategory.research,
      icon: Icons.moving,
    ),
    'standardize': SkillMeta(
      name: 'standardize',
      description: 'Generate coding guidelines',
      category: SkillCategory.research,
      icon: Icons.rule,
    ),

    // Creative
    'higgsfield': SkillMeta(
      name: 'higgsfield',
      description: 'Media generation',
      category: SkillCategory.creative,
      icon: Icons.movie_creation,
    ),
    'ui-design': SkillMeta(
      name: 'ui-design',
      description: 'UI design guidelines',
      category: SkillCategory.creative,
      icon: Icons.palette,
    ),
    'fifty-kit': SkillMeta(
      name: 'fifty-kit',
      description: 'FDL/Fifty kit reference',
      category: SkillCategory.creative,
      icon: Icons.widgets,
    ),

    // System
    'release': SkillMeta(
      name: 'release',
      description: 'Release preparation',
      category: SkillCategory.system,
      icon: Icons.rocket_launch,
    ),
    'keybindings-help': SkillMeta(
      name: 'keybindings-help',
      description: 'Keyboard shortcut config',
      category: SkillCategory.system,
      icon: Icons.keyboard,
    ),
  };

  // ---------------------------------------------------------------------------
  // Category metadata
  // ---------------------------------------------------------------------------

  /// Filter labels: "All" plus one per category.
  static const List<String> categories = [
    'All',
    'Combat',
    'Utility',
    'Support',
    'Management',
    'Research',
    'Creative',
    'System',
  ];

  /// Maps each [SkillCategory] to its accent color from [ArenaColors].
  static const Map<SkillCategory, Color> categoryColorMap = {
    SkillCategory.combat: ArenaColors.categoryCombat,
    SkillCategory.utility: ArenaColors.categoryUtility,
    SkillCategory.support: ArenaColors.categorySupport,
    SkillCategory.management: ArenaColors.categoryManagement,
    SkillCategory.research: ArenaColors.categoryResearch,
    SkillCategory.creative: ArenaColors.categoryCreative,
    SkillCategory.system: ArenaColors.categorySystem,
  };

  /// Maps each [SkillCategory] to a representative icon.
  static const Map<SkillCategory, IconData> categoryIcons = {
    SkillCategory.combat: Icons.local_fire_department,
    SkillCategory.utility: Icons.build,
    SkillCategory.support: Icons.support_agent,
    SkillCategory.management: Icons.account_tree,
    SkillCategory.research: Icons.science,
    SkillCategory.creative: Icons.brush,
    SkillCategory.system: Icons.settings,
  };

  // ---------------------------------------------------------------------------
  // Rarity resolution
  // ---------------------------------------------------------------------------

  /// Resolve the [SkillRarity] tier for a given invocation count.
  ///
  /// Thresholds:
  /// - Common: 0-9
  /// - Uncommon: 10-24
  /// - Rare: 25-49
  /// - Epic: 50-99
  /// - Legendary: 100+
  static SkillRarity resolveRarity(int invocations) {
    if (invocations >= 100) return SkillRarity.legendary;
    if (invocations >= 50) return SkillRarity.epic;
    if (invocations >= 25) return SkillRarity.rare;
    if (invocations >= 10) return SkillRarity.uncommon;
    return SkillRarity.common;
  }

  /// Convert a category filter string (e.g. "Combat") to [SkillCategory].
  ///
  /// Returns null for "All" or unrecognized strings.
  static SkillCategory? categoryFromString(String label) {
    switch (label) {
      case 'Combat':
        return SkillCategory.combat;
      case 'Utility':
        return SkillCategory.utility;
      case 'Support':
        return SkillCategory.support;
      case 'Management':
        return SkillCategory.management;
      case 'Research':
        return SkillCategory.research;
      case 'Creative':
        return SkillCategory.creative;
      case 'System':
        return SkillCategory.system;
      default:
        return null;
    }
  }
}
