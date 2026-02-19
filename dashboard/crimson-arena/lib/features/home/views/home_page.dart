import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../core/constants/arena_breakpoints.dart';
import '../../../shared/widgets/arena_scaffold.dart';
import '../controllers/home_view_model.dart';
import 'widgets/agent_performance_summary.dart';
import 'widgets/agent_roster_strip.dart';
import 'widgets/battle_log_widget.dart';
import 'widgets/brain_command_center.dart';
import 'widgets/brain_status_strip.dart';
import 'widgets/brief_velocity_widget.dart';
import 'widgets/context_breakdown_card.dart';
import 'widgets/context_window_card.dart';
import 'widgets/cost_estimate_card.dart';
import 'widgets/instrument_strip.dart';
import 'widgets/knowledge_panel.dart';
import 'widgets/range_filter.dart';
import 'widgets/skill_heatmap_widget.dart';
import 'widgets/token_budget_card.dart';

/// Home page -- the primary dashboard view.
///
/// Composes all dashboard widgets in a scrollable layout:
/// - Instrument strip (compact HP/CTX/SYNC gauges)
/// - Brain status strip (compact brain health + sync pipeline stats)
/// - Agent roster (horizontal scrollable strip)
/// - Two-column layout with:
///   - Left: Budget HP, Context Window, Cost Estimate, Agent Performance
///   - Right: Battle Log, Skill Heatmap, Brief Velocity
/// - Brain command center + knowledge panel
class HomePage extends StatelessWidget {
  const HomePage({super.key});

  @override
  Widget build(BuildContext context) {
    return ArenaScaffold(
      title: 'HOME',
      activeTabIndex: 0,
      body: GetX<HomeViewModel>(
        builder: (controller) {
          if (controller.isLoading.value) {
            return const Center(
              child: FiftyLoadingIndicator(
                style: FiftyLoadingStyle.sequence,
                size: FiftyLoadingSize.large,
                sequences: [
                  '> CONNECTING TO BRAIN...',
                  '> SYNCING STATE...',
                  '> LOADING AGENTS...',
                  '> COMPILING DASHBOARD...',
                  '> READY.',
                ],
              ),
            );
          }

          return LayoutBuilder(
            builder: (context, constraints) {
              final isWide = constraints.maxWidth > ArenaBreakpoints.wide;
              final isNarrow = constraints.maxWidth < ArenaBreakpoints.narrow;
              final pagePad =
                  isNarrow ? FiftySpacing.sm : FiftySpacing.md;

              return SingleChildScrollView(
                padding: EdgeInsets.all(pagePad),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    // Range filter
                    const Row(
                      mainAxisAlignment: MainAxisAlignment.end,
                      children: [
                        RangeFilter(),
                      ],
                    ),
                    const SizedBox(height: FiftySpacing.sm),

                    // Instrument strip
                    const FiftySectionHeader(
                      title: 'Vitals',
                      size: FiftySectionHeaderSize.small,
                      showDivider: false,
                    ),
                    const InstrumentStrip(),
                    const SizedBox(height: FiftySpacing.sm),

                    // Brain + Sync status strip
                    const BrainStatusStrip(),
                    const SizedBox(height: FiftySpacing.md),

                    // Agent roster strip
                    const AgentRosterStrip(),
                    const SizedBox(height: FiftySpacing.md),

                    // Main content area
                    if (isWide)
                      _WideLayout()
                    else
                      _NarrowLayout(),

                    const SizedBox(height: FiftySpacing.md),

                    // Brain Command Center
                    const BrainCommandCenter(),
                    const SizedBox(height: FiftySpacing.md),

                    // Knowledge Base
                    const KnowledgePanel(),

                    // Bottom padding
                    const SizedBox(height: FiftySpacing.xxl),
                  ],
                ),
              );
            },
          );
        },
      ),
    );
  }
}

/// Wide layout (>900px): two columns.
class _WideLayout extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Left column: Budget, Context, Cost, Performance
        Expanded(
          flex: 5,
          child: Column(
            children: const [
              TokenBudgetCard(),
              SizedBox(height: FiftySpacing.sm),
              ContextWindowCard(),
              SizedBox(height: FiftySpacing.sm),
              ContextBreakdownCard(),
              SizedBox(height: FiftySpacing.sm),
              CostEstimateCard(),
              SizedBox(height: FiftySpacing.sm),
              AgentPerformanceSummary(),
            ],
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),

        // Right column: Battle Log, Skill Heatmap, Brief Velocity
        Expanded(
          flex: 5,
          child: Column(
            children: const [
              BattleLogWidget(),
              SizedBox(height: FiftySpacing.sm),
              SkillHeatmapWidget(),
              SizedBox(height: FiftySpacing.sm),
              BriefVelocityWidget(),
            ],
          ),
        ),
      ],
    );
  }
}

/// Narrow layout (<900px): single column.
class _NarrowLayout extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(
      children: const [
        TokenBudgetCard(),
        SizedBox(height: FiftySpacing.sm),
        ContextWindowCard(),
        SizedBox(height: FiftySpacing.sm),
        ContextBreakdownCard(),
        SizedBox(height: FiftySpacing.sm),
        BattleLogWidget(),
        SizedBox(height: FiftySpacing.sm),
        CostEstimateCard(),
        SizedBox(height: FiftySpacing.sm),
        SkillHeatmapWidget(),
        SizedBox(height: FiftySpacing.sm),
        AgentPerformanceSummary(),
        SizedBox(height: FiftySpacing.sm),
        BriefVelocityWidget(),
      ],
    );
  }
}
