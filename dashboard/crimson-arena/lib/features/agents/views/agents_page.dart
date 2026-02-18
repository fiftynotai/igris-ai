import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../core/constants/arena_breakpoints.dart';
import '../../../shared/widgets/arena_scaffold.dart';
import '../controllers/agents_view_model.dart';
import 'widgets/agent_comparison_view.dart';
import 'widgets/agent_detail_panel.dart';
import 'widgets/agent_grid.dart';
import 'widgets/agent_metrics_panel.dart';

/// Agents page -- interactive agent roster with skill trees and metrics.
///
/// Layout:
/// - Top section: responsive grid of 7 agent cards (always visible)
/// - When an agent is selected:
///   - Wide: skill tree panel (2/3) + metrics panel (1/3) side by side
///   - Narrow: skill tree panel above metrics panel
/// - When comparison mode active: comparison view below metrics
class AgentsPage extends StatelessWidget {
  const AgentsPage({super.key});

  @override
  Widget build(BuildContext context) {
    return ArenaScaffold(
      title: 'AGENTS',
      activeTabIndex: 2,
      body: GetX<AgentsViewModel>(
        builder: (controller) {
          if (controller.isLoading.value) {
            return const Center(
              child: FiftyLoadingIndicator(
                style: FiftyLoadingStyle.sequence,
                size: FiftyLoadingSize.large,
                sequences: [
                  '> LOADING AGENT ROSTER...',
                  '> BUILDING SKILL TREES...',
                  '> CALCULATING METRICS...',
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
                    // Header summary strip
                    _HeaderStrip(controller: controller),
                    const SizedBox(height: FiftySpacing.md),

                    // Agent grid (always visible)
                    const FiftySectionHeader(
                      title: 'Agent Registry',
                      size: FiftySectionHeaderSize.small,
                      showDivider: false,
                    ),
                    const AgentGrid(),
                    const SizedBox(height: FiftySpacing.md),

                    // Detail panels (when agent selected)
                    Obx(() {
                      final hasSelection =
                          controller.selectedAgent.value != null;
                      final isComparing =
                          controller.comparisonMode.value;

                      if (!hasSelection) {
                        return const SizedBox.shrink();
                      }

                      return AnimatedSwitcher(
                        duration: const Duration(milliseconds: 300),
                        transitionBuilder: (child, animation) {
                          return SlideTransition(
                            position: Tween<Offset>(
                              begin: const Offset(0, 0.1),
                              end: Offset.zero,
                            ).animate(CurvedAnimation(
                              parent: animation,
                              curve: Curves.easeOut,
                            )),
                            child: child,
                          );
                        },
                        child: Column(
                          key: ValueKey(
                            '${controller.selectedAgent.value}'
                            '_$isComparing',
                          ),
                          children: [
                            // Skill tree + metrics
                            if (isWide)
                              SizedBox(
                                height: 520,
                                child: Row(
                                  crossAxisAlignment:
                                      CrossAxisAlignment.start,
                                  children: [
                                    const Expanded(
                                      flex: 2,
                                      child: AgentDetailPanel(),
                                    ),
                                    const SizedBox(
                                      width: FiftySpacing.sm,
                                    ),
                                    const Expanded(
                                      flex: 1,
                                      child: AgentMetricsPanel(),
                                    ),
                                  ],
                                ),
                              )
                            else ...[
                              const SizedBox(
                                height: 420,
                                child: AgentDetailPanel(),
                              ),
                              const SizedBox(height: FiftySpacing.sm),
                              const AgentMetricsPanel(),
                            ],

                            // Comparison view
                            if (isComparing) ...[
                              const SizedBox(height: FiftySpacing.md),
                              const AgentComparisonView(),
                            ],
                          ],
                        ),
                      );
                    }),

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

/// Header strip showing summary stats and skill progress.
class _HeaderStrip extends StatelessWidget {
  final AgentsViewModel controller;

  const _HeaderStrip({required this.controller});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(color: colorScheme.outline, width: 1),
      ),
      child: Obx(() {
        final agentCount = controller.agents.length;
        final totalInvocations = controller.totalInvocations;
        final unlockedSkills = controller.totalUnlockedSkills;
        final totalSkills = controller.totalPossibleSkills;

        return Wrap(
          spacing: FiftySpacing.xxl,
          runSpacing: FiftySpacing.sm,
          children: [
            _StatChip(
              label: 'AGENTS',
              value: '$agentCount',
            ),
            _StatChip(
              label: 'TOTAL RUNS',
              value: _formatCompact(totalInvocations),
            ),
            _StatChip(
              label: 'SKILLS UNLOCKED',
              value: '$unlockedSkills / $totalSkills',
            ),
            _StatChip(
              label: 'RANGE',
              value: controller.currentRange.value.toUpperCase(),
            ),
          ],
        );
      }),
    );
  }

  String _formatCompact(int value) {
    if (value >= 1000000) {
      return '${(value / 1000000).toStringAsFixed(1)}M';
    }
    if (value >= 1000) {
      return '${(value / 1000).toStringAsFixed(1)}K';
    }
    return '$value';
  }
}

/// Small stat label + value chip.
class _StatChip extends StatelessWidget {
  final String label;
  final String value;

  const _StatChip({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          '$label: ',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.4),
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          value,
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.bold,
            color: colorScheme.onSurface.withValues(alpha: 0.8),
          ),
        ),
      ],
    );
  }
}
