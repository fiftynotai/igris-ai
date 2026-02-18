import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';
import 'brain_briefs_panel.dart';
import 'brain_projects_panel.dart';
import 'brain_sessions_panel.dart';

/// Brain Command Center.
///
/// Shows three panels: Projects, Briefs, and Sessions from the brain
/// server. Mirrors the brain section from the vanilla JS dashboard.
///
/// Each panel is extracted into its own widget:
/// - [BrainProjectsPanel]
/// - [BrainBriefsPanel]
/// - [BrainSessionsPanel]
class BrainCommandCenter extends StatelessWidget {
  const BrainCommandCenter({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      if (!vm.brainAvailable.value) {
        return ArenaCard(
          title: 'BRAIN COMMAND CENTER',
          child: Text(
            'Brain offline -- command center unavailable',
            style: textTheme.bodySmall!.copyWith(
              color: colorScheme.onSurfaceVariant,
            ),
          ),
        );
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Section header
          Padding(
            padding: const EdgeInsets.only(
              left: FiftySpacing.xs,
              bottom: FiftySpacing.sm,
            ),
            child: Text(
              'BRAIN COMMAND CENTER',
              style: textTheme.labelMedium!.copyWith(
                color: colorScheme.onSurfaceVariant,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
          ),

          // Projects panel
          BrainProjectsPanel(projects: vm.brainProjects),
          const SizedBox(height: FiftySpacing.sm),

          // Briefs panel
          BrainBriefsPanel(
            briefs: vm.brainBriefs,
            statusCounts: vm.briefStatusCounts,
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Sessions panel
          BrainSessionsPanel(sessions: vm.brainSessions),
        ],
      );
    });
  }
}
