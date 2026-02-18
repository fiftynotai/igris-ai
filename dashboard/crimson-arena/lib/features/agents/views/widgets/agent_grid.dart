import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../core/constants/arena_breakpoints.dart';
import '../../../../data/models/agent_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/agents_view_model.dart';

/// Responsive grid displaying all 7 agent cards.
///
/// Layout adapts to viewport width:
/// - Wide (>1200px): 4 columns
/// - Medium (>800px): 3 columns
/// - Narrow (>500px): 2 columns
/// - Very narrow: 1 column
///
/// Each card shows monogram, name, level, progress, RPG stats, and
/// invocation count. Tapping selects the agent for the detail panel.
class AgentGrid extends StatelessWidget {
  const AgentGrid({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AgentsViewModel>();

    return LayoutBuilder(
      builder: (context, constraints) {
        final columns = _columnCount(constraints.maxWidth);
        final spacing = FiftySpacing.sm;
        final cardWidth =
            (constraints.maxWidth - spacing * (columns - 1)) / columns;

        return Obx(() {
          final agentsMap = vm.agents;
          final selected = vm.selectedAgent.value;

          // Use only the 7 subagents (skip orchestrator for grid).
          final agentKeys = AgentConstants.agentOrder
              .where((name) => name != 'orchestrator')
              .toList();

          return Wrap(
            spacing: spacing,
            runSpacing: spacing,
            children: agentKeys.map((name) {
              final agent = agentsMap[name];
              return SizedBox(
                width: cardWidth,
                child: _AgentGridCard(
                  agentName: name,
                  agent: agent,
                  isSelected: selected == name,
                  onTap: () => vm.selectAgent(name),
                ),
              );
            }).toList(),
          );
        });
      },
    );
  }

  int _columnCount(double width) {
    return ArenaBreakpoints.gridColumns(width);
  }
}

/// A single agent card in the grid.
class _AgentGridCard extends StatefulWidget {
  final String agentName;
  final AgentModel? agent;
  final bool isSelected;
  final VoidCallback onTap;

  const _AgentGridCard({
    required this.agentName,
    this.agent,
    required this.isSelected,
    required this.onTap,
  });

  @override
  State<_AgentGridCard> createState() => _AgentGridCardState();
}

class _AgentGridCardState extends State<_AgentGridCard> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    // Agent-specific color -- game identity, not migrated.
    final color = Color(
      AgentConstants.agentColors[widget.agentName] ?? 0xFF888888,
    );
    final monogram = AgentConstants.agentMonograms[widget.agentName] ??
        widget.agentName.substring(0, 2).toUpperCase();
    final displayName = AgentConstants.agentNames[widget.agentName] ??
        widget.agentName.toUpperCase();
    final tier = AgentConstants.agentTiers[widget.agentName] ?? 1;
    final invocations = widget.agent?.invocations ?? 0;
    final levelName = widget.agent?.level.name ?? 'Trainee';
    final levelTier = widget.agent?.level.tier ?? 0;
    final progress = widget.agent?.level.progress ?? 0;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
          padding: const EdgeInsets.all(FiftySpacing.md),
          decoration: BoxDecoration(
            color: widget.isSelected
                ? colorScheme.primary.withValues(alpha: 0.08)
                : colorScheme.surfaceContainerHighest,
            borderRadius: FiftyRadii.lgRadius,
            border: Border.all(
              color: widget.isSelected
                  ? colorScheme.primary.withValues(alpha: 0.6)
                  : _hovered
                      ? color.withValues(alpha: 0.3)
                      : colorScheme.outline,
              width: widget.isSelected ? 1.5 : 1,
            ),
            boxShadow: widget.isSelected
                ? [
                    BoxShadow(
                      color: colorScheme.primary.withValues(alpha: 0.15),
                      blurRadius: 12,
                      spreadRadius: 2,
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Top row: monogram + tier badge
              Row(
                children: [
                  // Monogram circle
                  Container(
                    width: 40,
                    height: 40,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: color.withValues(alpha: 0.15),
                      border: Border.all(
                        color: color.withValues(alpha: 0.4),
                        width: 1.5,
                      ),
                    ),
                    child: Center(
                      child: Text(
                        monogram,
                        style: textTheme.bodyMedium!.copyWith(
                          fontWeight: FiftyTypography.extraBold,
                          color: color,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: FiftySpacing.sm),
                  Expanded(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Tooltip(
                          message: displayName,
                          child: Text(
                            displayName,
                            style: textTheme.labelLarge!.copyWith(
                              fontWeight: FiftyTypography.extraBold,
                              color: colorScheme.onSurface,
                              letterSpacing:
                                  FiftyTypography.letterSpacingLabelMedium,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                        Text(
                          '$levelName  T$tier',
                          style: textTheme.labelSmall!.copyWith(
                            fontWeight: FiftyTypography.medium,
                            color: color.withValues(alpha: 0.7),
                            letterSpacing: FiftyTypography.letterSpacingLabel,
                          ),
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                        ),
                      ],
                    ),
                  ),
                  // Level badge
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FiftySpacing.sm,
                      vertical: FiftySpacing.xs,
                    ),
                    decoration: BoxDecoration(
                      color: color.withValues(alpha: 0.1),
                      borderRadius: FiftyRadii.smRadius,
                      border: Border.all(
                        color: color.withValues(alpha: 0.2),
                        width: 1,
                      ),
                    ),
                    child: Text(
                      'Lv.$levelTier',
                      style: textTheme.labelSmall!.copyWith(
                        fontWeight: FiftyTypography.bold,
                        color: color,
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: FiftySpacing.md),

              // Level progress bar
              Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    mainAxisAlignment: MainAxisAlignment.spaceBetween,
                    children: [
                      Text(
                        'PROGRESS',
                        style: textTheme.labelSmall!.copyWith(
                          color: colorScheme.onSurface.withValues(alpha: 0.3),
                          letterSpacing:
                              FiftyTypography.letterSpacingLabelMedium,
                        ),
                      ),
                      Text(
                        '${(progress * 100).toStringAsFixed(0)}%',
                        style: textTheme.labelSmall!.copyWith(
                          fontWeight: FiftyTypography.bold,
                          color: color.withValues(alpha: 0.7),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: FiftySpacing.xs),
                  SizedBox(
                    height: 4,
                    child: ClipRRect(
                      borderRadius: FiftyRadii.smRadius,
                      child: LinearProgressIndicator(
                        value: progress.clamp(0, 1).toDouble(),
                        backgroundColor:
                            colorScheme.onSurface.withValues(alpha: 0.05),
                        valueColor: AlwaysStoppedAnimation<Color>(color),
                      ),
                    ),
                  ),
                ],
              ),
              const SizedBox(height: FiftySpacing.md),

              // RPG stats
              if (widget.agent != null)
                _RpgStatsRow(stats: widget.agent!.rpgStats, color: color),

              const SizedBox(height: FiftySpacing.sm),

              // Invocations count
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    'INVOCATIONS',
                    style: textTheme.labelSmall!.copyWith(
                      fontWeight: FiftyTypography.medium,
                      color: colorScheme.onSurface.withValues(alpha: 0.3),
                      letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                    ),
                  ),
                  Text(
                    FormatUtils.formatNumber(invocations),
                    style: textTheme.bodyMedium!.copyWith(
                      fontWeight: FiftyTypography.bold,
                      color: colorScheme.onSurface.withValues(alpha: 0.8),
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// Horizontal RPG stat bars (STR/INT/SPD/VIT) with labels.
class _RpgStatsRow extends StatelessWidget {
  final RpgStats stats;
  final Color color;

  const _RpgStatsRow({required this.stats, required this.color});

  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        _StatBar(label: 'STR', value: stats.str, color: color),
        const SizedBox(height: 3),
        _StatBar(label: 'INT', value: stats.int_, color: color),
        const SizedBox(height: 3),
        _StatBar(label: 'SPD', value: stats.spd, color: color),
        const SizedBox(height: 3),
        _StatBar(label: 'VIT', value: stats.vit, color: color),
      ],
    );
  }
}

/// A single horizontal stat bar.
class _StatBar extends StatelessWidget {
  final String label;
  final int value;
  final Color color;

  const _StatBar({
    required this.label,
    required this.value,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Row(
      children: [
        SizedBox(
          width: 28,
          child: Text(
            label,
            style: textTheme.labelSmall!.copyWith(
              color: colorScheme.onSurface.withValues(alpha: 0.3),
            ),
          ),
        ),
        Expanded(
          child: SizedBox(
            height: 4,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: (value / 100).clamp(0, 1).toDouble(),
                backgroundColor: colorScheme.onSurface.withValues(alpha: 0.05),
                valueColor:
                    AlwaysStoppedAnimation<Color>(color.withValues(alpha: 0.6)),
              ),
            ),
          ),
        ),
        const SizedBox(width: FiftySpacing.xs),
        SizedBox(
          width: 24,
          child: Text(
            '$value',
            textAlign: TextAlign.right,
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.bold,
              color: colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
        ),
      ],
    );
  }
}
