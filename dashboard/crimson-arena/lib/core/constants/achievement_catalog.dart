import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:flutter/material.dart';

/// Complete catalog of 30 Igris AI achievements across 6 categories.
///
/// Uses the [fifty_achievement_engine] package for condition-based unlocks,
/// progress tracking, and rarity tiers.
///
/// Categories: Hunt, Agent, Brief, Session, Quality, Team
class AchievementCatalog {
  AchievementCatalog._();

  /// All achievement category names.
  static const List<String> categories = [
    'Hunt',
    'Agent',
    'Brief',
    'Session',
    'Quality',
    'Team',
  ];

  /// Icon mapping per category.
  static const Map<String, IconData> categoryIcons = {
    'Hunt': Icons.track_changes,
    'Agent': Icons.smart_toy_outlined,
    'Brief': Icons.description_outlined,
    'Session': Icons.schedule,
    'Quality': Icons.verified_outlined,
    'Team': Icons.groups_outlined,
  };

  /// Every achievement in the system (30 total).
  static List<Achievement<void>> get all => [
        ...hunt,
        ...agent,
        ...brief,
        ...session,
        ...quality,
        ...team,
      ];

  // ---------------------------------------------------------------------------
  // HUNT ACHIEVEMENTS (6)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get hunt => [
        const Achievement<void>(
          id: 'first_blood',
          name: 'First Blood',
          description: 'Complete your first hunt.',
          condition: EventCondition('hunt_complete'),
          rarity: AchievementRarity.common,
          points: 10,
          category: 'Hunt',
          icon: Icons.whatshot,
        ),
        const Achievement<void>(
          id: 'veteran_hunter',
          name: 'Veteran Hunter',
          description: 'Complete 10 hunts.',
          condition: CountCondition('hunt_complete', target: 10),
          rarity: AchievementRarity.uncommon,
          points: 25,
          category: 'Hunt',
          icon: Icons.military_tech,
        ),
        const Achievement<void>(
          id: 'centurion',
          name: 'Centurion',
          description: 'Complete 100 hunts.',
          condition: CountCondition('hunt_complete', target: 100),
          rarity: AchievementRarity.rare,
          points: 100,
          category: 'Hunt',
          icon: Icons.shield,
        ),
        const Achievement<void>(
          id: 'perfect_run',
          name: 'Perfect Run',
          description: 'Complete a hunt with zero retries.',
          condition: EventCondition('hunt_zero_retries'),
          rarity: AchievementRarity.uncommon,
          points: 50,
          category: 'Hunt',
          icon: Icons.auto_awesome,
        ),
        const Achievement<void>(
          id: 'speed_demon',
          name: 'Speed Demon',
          description: 'Complete a hunt in under 30 minutes.',
          condition: EventCondition('hunt_under_30m'),
          rarity: AchievementRarity.rare,
          points: 75,
          category: 'Hunt',
          icon: Icons.bolt,
        ),
        const Achievement<void>(
          id: 'marathon',
          name: 'Marathon',
          description: 'Complete 3+ briefs in a single session.',
          condition: ThresholdCondition(
            'briefs_in_session',
            target: 3,
          ),
          rarity: AchievementRarity.epic,
          points: 150,
          category: 'Hunt',
          icon: Icons.emoji_events,
        ),
      ];

  // ---------------------------------------------------------------------------
  // AGENT ACHIEVEMENTS (5)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get agent => [
        const Achievement<void>(
          id: 'architects_apprentice',
          name: "Architect's Apprentice",
          description: 'Use the architect agent 10 times.',
          condition: CountCondition('agent_architect_used', target: 10),
          rarity: AchievementRarity.common,
          points: 10,
          category: 'Agent',
          icon: Icons.architecture,
        ),
        const Achievement<void>(
          id: 'forge_master',
          name: 'Forge Master',
          description: 'Forger completes 50 builds.',
          condition: CountCondition('agent_forger_complete', target: 50),
          rarity: AchievementRarity.uncommon,
          points: 25,
          category: 'Agent',
          icon: Icons.construction,
        ),
        const Achievement<void>(
          id: 'sentinel_shield',
          name: 'Sentinel Shield',
          description: 'Sentinel passes 20 test suites.',
          condition: CountCondition('agent_sentinel_pass', target: 20),
          rarity: AchievementRarity.uncommon,
          points: 25,
          category: 'Agent',
          icon: Icons.security,
        ),
        const Achievement<void>(
          id: 'wardens_approval',
          name: "Warden's Approval",
          description: 'Warden approves on first try 10 times.',
          condition: CountCondition('warden_first_approve', target: 10),
          rarity: AchievementRarity.rare,
          points: 75,
          category: 'Agent',
          icon: Icons.approval,
        ),
        const Achievement<void>(
          id: 'full_roster',
          name: 'Full Roster',
          description: 'Use all 7 agents in a single session.',
          condition: ThresholdCondition(
            'unique_agents_session',
            target: 7,
          ),
          rarity: AchievementRarity.epic,
          points: 100,
          category: 'Agent',
          icon: Icons.diversity_3,
        ),
      ];

  // ---------------------------------------------------------------------------
  // BRIEF ACHIEVEMENTS (4)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get brief => [
        const Achievement<void>(
          id: 'first_brief',
          name: 'First Brief',
          description: 'Register your first brief.',
          condition: EventCondition('brief_registered'),
          rarity: AchievementRarity.common,
          points: 5,
          category: 'Brief',
          icon: Icons.note_add,
        ),
        const Achievement<void>(
          id: 'brief_commander',
          name: 'Brief Commander',
          description: 'Complete 50 briefs.',
          condition: CountCondition('brief_completed', target: 50),
          rarity: AchievementRarity.rare,
          points: 100,
          category: 'Brief',
          icon: Icons.library_books,
        ),
        const Achievement<void>(
          id: 'zero_blockers',
          name: 'Zero Blockers',
          description: 'Clear all P0 briefs from the queue.',
          condition: EventCondition('all_p0_cleared'),
          rarity: AchievementRarity.epic,
          points: 150,
          category: 'Brief',
          icon: Icons.block,
        ),
        const Achievement<void>(
          id: 'type_master',
          name: 'Type Master',
          description: 'Complete one brief of each type.',
          condition: ThresholdCondition(
            'unique_brief_types',
            target: 9,
          ),
          rarity: AchievementRarity.legendary,
          points: 500,
          category: 'Brief',
          icon: Icons.workspace_premium,
        ),
      ];

  // ---------------------------------------------------------------------------
  // SESSION ACHIEVEMENTS (4)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get session => [
        const Achievement<void>(
          id: 'early_bird',
          name: 'Early Bird',
          description: 'Start a session before 7 AM.',
          condition: EventCondition('session_before_7am'),
          rarity: AchievementRarity.common,
          points: 10,
          category: 'Session',
          icon: Icons.wb_sunny,
        ),
        const Achievement<void>(
          id: 'night_owl',
          name: 'Night Owl',
          description: 'Be active past midnight.',
          condition: EventCondition('session_past_midnight'),
          rarity: AchievementRarity.common,
          points: 10,
          category: 'Session',
          icon: Icons.nightlight_round,
        ),
        const Achievement<void>(
          id: 'streak',
          name: 'Streak',
          description: '5 consecutive days of activity.',
          condition: ThresholdCondition(
            'consecutive_days',
            target: 5,
          ),
          rarity: AchievementRarity.rare,
          points: 75,
          category: 'Session',
          icon: Icons.local_fire_department,
        ),
        const Achievement<void>(
          id: 'cross_project',
          name: 'Cross-Project',
          description: 'Work on 3+ projects in one week.',
          condition: ThresholdCondition(
            'projects_this_week',
            target: 3,
          ),
          rarity: AchievementRarity.epic,
          points: 100,
          category: 'Session',
          icon: Icons.account_tree,
        ),
      ];

  // ---------------------------------------------------------------------------
  // QUALITY ACHIEVEMENTS (5)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get quality => [
        const Achievement<void>(
          id: 'clean_code',
          name: 'Clean Code',
          description: 'Warden approves with zero issues 5 times.',
          condition: CountCondition('warden_zero_issues', target: 5),
          rarity: AchievementRarity.uncommon,
          points: 30,
          category: 'Quality',
          icon: Icons.check_circle_outline,
        ),
        const Achievement<void>(
          id: 'test_champion',
          name: 'Test Champion',
          description: '100% pass rate over 10 hunts.',
          condition: CountCondition('hunt_all_tests_pass', target: 10),
          rarity: AchievementRarity.rare,
          points: 100,
          category: 'Quality',
          icon: Icons.verified,
        ),
        const Achievement<void>(
          id: 'architects_vision',
          name: "Architect's Vision",
          description: 'Plan accepted without revision 5 times.',
          condition: CountCondition('plan_first_accept', target: 5),
          rarity: AchievementRarity.rare,
          points: 75,
          category: 'Quality',
          icon: Icons.visibility,
        ),
        const Achievement<void>(
          id: 'perfectionist',
          name: 'Perfectionist',
          description:
              'Complete 3 hunts with APPROVE + PASS on first try.',
          condition: CountCondition('hunt_perfect', target: 3),
          rarity: AchievementRarity.epic,
          points: 150,
          category: 'Quality',
          icon: Icons.diamond,
        ),
        const Achievement<void>(
          id: 'code_sage',
          name: 'Code Sage',
          description: '1,000 total agent invocations.',
          condition: ThresholdCondition(
            'total_agent_invocations',
            target: 1000,
          ),
          rarity: AchievementRarity.legendary,
          points: 500,
          category: 'Quality',
          icon: Icons.self_improvement,
        ),
      ];

  // ---------------------------------------------------------------------------
  // TEAM ACHIEVEMENTS (4)
  // ---------------------------------------------------------------------------

  static List<Achievement<void>> get team => [
        const Achievement<void>(
          id: 'team_player',
          name: 'Team Player',
          description: 'Complete your first team hunt.',
          condition: EventCondition('team_hunt_complete'),
          rarity: AchievementRarity.uncommon,
          points: 25,
          category: 'Team',
          icon: Icons.group_work,
        ),
        const Achievement<void>(
          id: 'full_squad',
          name: 'Full Squad',
          description: '4-teammate parallel hunt.',
          condition: ThresholdCondition(
            'max_parallel_teammates',
            target: 4,
          ),
          rarity: AchievementRarity.epic,
          points: 100,
          category: 'Team',
          icon: Icons.groups,
        ),
        const Achievement<void>(
          id: 'synchronized',
          name: 'Synchronized',
          description:
              'All teammates complete within 5 minutes of each other.',
          condition: EventCondition('team_synchronized'),
          rarity: AchievementRarity.legendary,
          points: 500,
          category: 'Team',
          icon: Icons.sync,
        ),
        const Achievement<void>(
          id: 'squad_leader',
          name: 'Squad Leader',
          description: 'Lead 10 team hunts.',
          condition: CountCondition('team_hunt_complete', target: 10),
          rarity: AchievementRarity.rare,
          points: 75,
          category: 'Team',
          icon: Icons.supervisor_account,
        ),
      ];

  /// Total count of achievements.
  static int get count => all.length;

  /// Total points possible across all achievements.
  static int get maxPoints => all.fold(0, (sum, a) => sum + a.points);

  /// Count of achievements per rarity tier.
  static Map<AchievementRarity, int> get rarityBreakdown {
    final map = <AchievementRarity, int>{};
    for (final a in all) {
      map[a.rarity] = (map[a.rarity] ?? 0) + 1;
    }
    return map;
  }
}
