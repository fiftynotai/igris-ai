import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../shared/widgets/arena_scaffold.dart';
import '../controllers/achievements_view_model.dart';
import 'widgets/achievement_grid.dart';
import 'widgets/achievement_summary_header.dart';
import 'widgets/achievement_unlock_popup.dart';
import 'widgets/category_filter_chips.dart';

/// Achievements page -- gamification view with unlock tracking.
///
/// Layout:
/// ```
/// ArenaScaffold(title: 'ACHIEVEMENTS', activeTabIndex: 3)
///   Column
///     AchievementSummaryHeader  -- points, unlocked count, rarity breakdown
///     CategoryFilterChips       -- All, Hunt, Agent, Brief, Session, Quality, Team
///     Expanded(AchievementGrid) -- filtered, sorted grid of achievement cards
/// ```
///
/// Listens for unlock events and shows [AchievementUnlockPopup] overlay.
class AchievementsPage extends StatefulWidget {
  const AchievementsPage({super.key});

  @override
  State<AchievementsPage> createState() => _AchievementsPageState();
}

class _AchievementsPageState extends State<AchievementsPage> {
  late final AchievementsViewModel _vm;
  Worker? _unlockWorker;

  @override
  void initState() {
    super.initState();
    _vm = Get.find<AchievementsViewModel>();

    // Watch for new unlocks and show popups.
    _unlockWorker = ever(_vm.unlockQueue, (_) {
      _showNextUnlock();
    });
  }

  @override
  void dispose() {
    _unlockWorker?.dispose();
    super.dispose();
  }

  void _showNextUnlock() {
    final achievement = _vm.dequeueUnlock();
    if (achievement == null) return;
    if (!mounted) return;

    showAchievementUnlockPopup(
      context,
      achievement,
      onDismiss: () {
        // Show next queued unlock if any.
        _showNextUnlock();
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    return ArenaScaffold(
      title: 'ACHIEVEMENTS',
      activeTabIndex: 3,
      body: Obx(() {
        if (_vm.isLoading.value) {
          return const Center(
            child: FiftyLoadingIndicator(
              style: FiftyLoadingStyle.sequence,
              size: FiftyLoadingSize.large,
              sequences: [
                '> LOADING ACHIEVEMENTS...',
                '> SCANNING UNLOCKS...',
                '> TALLYING POINTS...',
                '> READY.',
              ],
            ),
          );
        }

        return Column(
          children: [
            const SizedBox(height: FiftySpacing.md),

            // Summary header
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: FiftySpacing.md),
              child: AchievementSummaryHeader(),
            ),

            const SizedBox(height: FiftySpacing.md),

            // Achievements section header
            const Padding(
              padding: EdgeInsets.symmetric(horizontal: FiftySpacing.md),
              child: FiftySectionHeader(
                title: 'Achievements',
                size: FiftySectionHeaderSize.small,
                showDivider: false,
              ),
            ),

            // Category filter chips
            const CategoryFilterChips(),

            const SizedBox(height: FiftySpacing.sm),

            // Achievement grid (fills remaining space)
            const Expanded(
              child: AchievementGrid(),
            ),
          ],
        );
      }),
    );
  }
}
