import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/agent_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/agents_view_model.dart';

/// Side-by-side comparison view for two agents.
///
/// Shows name, level, success rate, avg tokens, avg duration, grade,
/// and a bar chart comparison for each metric.
///
/// Activated when the user taps "Compare" on the metrics panel, then
/// selects a second agent from a dropdown or by tapping the grid.
class AgentComparisonView extends StatelessWidget {
  const AgentComparisonView({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<AgentsViewModel>();
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Obx(() {
      final primaryName = vm.selectedAgent.value;
      final secondaryName = vm.comparedAgent.value;

      if (primaryName == null) return const SizedBox.shrink();

      final primaryAgent = vm.agents[primaryName];

      return Container(
        decoration: BoxDecoration(
          color: colorScheme.surfaceContainerHighest,
          borderRadius: FiftyRadii.lgRadius,
          border: Border.all(color: colorScheme.outline, width: 1),
        ),
        padding: const EdgeInsets.all(FiftySpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            // Header
            Row(
              children: [
                Text(
                  'AGENT COMPARISON',
                  style: textTheme.labelMedium!.copyWith(
                    color: colorScheme.onSurfaceVariant,
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
                ),
                const Spacer(),
                MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: InkWell(
                  onTap: () {
                    vm.clearCompare();
                    vm.toggleComparisonMode();
                  },
                  borderRadius: FiftyRadii.smRadius,
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FiftySpacing.sm,
                      vertical: FiftySpacing.xs,
                    ),
                    decoration: BoxDecoration(
                      borderRadius: FiftyRadii.smRadius,
                      border: Border.all(
                        color: colorScheme.outline,
                        width: 1,
                      ),
                    ),
                    child: Text(
                      'CLOSE',
                      style: textTheme.labelSmall!.copyWith(
                        fontWeight: FiftyTypography.bold,
                        color: colorScheme.onSurface.withValues(alpha: 0.5),
                        letterSpacing: FiftyTypography.letterSpacingLabel,
                      ),
                    ),
                  ),
                ),
                ),
              ],
            ),
            const SizedBox(height: FiftySpacing.md),

            // Agent selector for comparison target
            if (secondaryName == null)
              _AgentSelector(
                excludeAgent: primaryName,
                onSelect: (name) => vm.startCompare(name),
              )
            else ...[
              // Comparison content
              _ComparisonContent(
                primaryName: primaryName,
                primaryAgent: primaryAgent,
                secondaryName: secondaryName,
                secondaryAgent: vm.agents[secondaryName],
              ),
              const SizedBox(height: FiftySpacing.sm),
              Center(
                child: MouseRegion(
                  cursor: SystemMouseCursors.click,
                  child: InkWell(
                    onTap: () => vm.clearCompare(),
                    borderRadius: FiftyRadii.smRadius,
                    child: Padding(
                      padding: const EdgeInsets.symmetric(
                        horizontal: FiftySpacing.sm,
                        vertical: FiftySpacing.xs,
                      ),
                      child: Text(
                        'Change comparison agent',
                        style: textTheme.labelSmall!.copyWith(
                          fontWeight: FiftyTypography.medium,
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ],
          ],
        ),
      );
    });
  }
}

/// Dropdown-style selector to pick an agent for comparison.
class _AgentSelector extends StatelessWidget {
  final String excludeAgent;
  final ValueChanged<String> onSelect;

  const _AgentSelector({
    required this.excludeAgent,
    required this.onSelect,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final agents = AgentConstants.agentOrder
        .where((name) => name != 'orchestrator' && name != excludeAgent)
        .toList();

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'Select an agent to compare:',
          style: textTheme.bodySmall!.copyWith(
            color: colorScheme.onSurface.withValues(alpha: 0.5),
          ),
        ),
        const SizedBox(height: FiftySpacing.sm),
        Wrap(
          spacing: FiftySpacing.sm,
          runSpacing: FiftySpacing.sm,
          children: agents.map((name) {
            // Agent-specific color -- game identity, not migrated.
            final color =
                Color(AgentConstants.agentColors[name] ?? 0xFF888888);
            final displayName =
                AgentConstants.agentNames[name] ?? name.toUpperCase();

            return InkWell(
              onTap: () => onSelect(name),
              borderRadius: FiftyRadii.mdRadius,
              child: Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: FiftySpacing.md,
                  vertical: FiftySpacing.sm,
                ),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.08),
                  borderRadius: FiftyRadii.mdRadius,
                  border: Border.all(
                    color: color.withValues(alpha: 0.2),
                    width: 1,
                  ),
                ),
                child: Text(
                  displayName,
                  style: textTheme.labelSmall!.copyWith(
                    fontWeight: FiftyTypography.bold,
                    color: color,
                    letterSpacing: FiftyTypography.letterSpacingLabel,
                  ),
                ),
              ),
            );
          }).toList(),
        ),
      ],
    );
  }
}

/// The actual side-by-side comparison content.
class _ComparisonContent extends StatelessWidget {
  final String primaryName;
  final AgentModel? primaryAgent;
  final String secondaryName;
  final AgentModel? secondaryAgent;

  const _ComparisonContent({
    required this.primaryName,
    this.primaryAgent,
    required this.secondaryName,
    this.secondaryAgent,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    // Agent-specific colors -- game identity, not migrated.
    final colorA =
        Color(AgentConstants.agentColors[primaryName] ?? 0xFF888888);
    final colorB =
        Color(AgentConstants.agentColors[secondaryName] ?? 0xFF888888);
    final nameA =
        AgentConstants.agentNames[primaryName] ?? primaryName.toUpperCase();
    final nameB = AgentConstants.agentNames[secondaryName] ??
        secondaryName.toUpperCase();

    final invA = primaryAgent?.invocations ?? 0;
    final invB = secondaryAgent?.invocations ?? 0;
    final successA = (primaryAgent?.successRate ?? 0) * 100;
    final successB = (secondaryAgent?.successRate ?? 0) * 100;
    final tokensA =
        invA > 0 ? (primaryAgent?.totalTokens ?? 0) ~/ invA : 0;
    final tokensB =
        invB > 0 ? (secondaryAgent?.totalTokens ?? 0) ~/ invB : 0;
    final durA = primaryAgent?.avgDurationSeconds ?? 0;
    final durB = secondaryAgent?.avgDurationSeconds ?? 0;
    final levelA = primaryAgent?.level.tier ?? 0;
    final levelB = secondaryAgent?.level.tier ?? 0;
    final gradeA = _grade(successA);
    final gradeB = _grade(successB);

    return Column(
      children: [
        // Agent headers
        Row(
          children: [
            Expanded(
              child: _AgentHeader(name: nameA, color: colorA, grade: gradeA),
            ),
            const SizedBox(width: FiftySpacing.md),
            Text(
              'VS',
              style: textTheme.labelMedium!.copyWith(
                fontWeight: FiftyTypography.extraBold,
                color: colorScheme.onSurface.withValues(alpha: 0.3),
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
            const SizedBox(width: FiftySpacing.md),
            Expanded(
              child: _AgentHeader(name: nameB, color: colorB, grade: gradeB),
            ),
          ],
        ),
        const SizedBox(height: FiftySpacing.md),

        // Comparison bars
        _ComparisonBar(
          label: 'Level',
          valueA: levelA.toDouble(),
          valueB: levelB.toDouble(),
          displayA: 'Lv.$levelA',
          displayB: 'Lv.$levelB',
          colorA: colorA,
          colorB: colorB,
          maxValue: 7,
        ),
        const SizedBox(height: FiftySpacing.sm),

        _ComparisonBar(
          label: 'Success Rate',
          valueA: successA,
          valueB: successB,
          displayA: '${successA.toStringAsFixed(0)}%',
          displayB: '${successB.toStringAsFixed(0)}%',
          colorA: colorA,
          colorB: colorB,
          maxValue: 100,
        ),
        const SizedBox(height: FiftySpacing.sm),

        _ComparisonBar(
          label: 'Avg Tokens',
          valueA: tokensA.toDouble(),
          valueB: tokensB.toDouble(),
          displayA: FormatUtils.formatTokens(tokensA),
          displayB: FormatUtils.formatTokens(tokensB),
          colorA: colorA,
          colorB: colorB,
          invertBetter: true,
        ),
        const SizedBox(height: FiftySpacing.sm),

        _ComparisonBar(
          label: 'Avg Duration',
          valueA: durA,
          valueB: durB,
          displayA: FormatUtils.formatDuration(durA),
          displayB: FormatUtils.formatDuration(durB),
          colorA: colorA,
          colorB: colorB,
          invertBetter: true,
        ),
        const SizedBox(height: FiftySpacing.sm),

        _ComparisonBar(
          label: 'Invocations',
          valueA: invA.toDouble(),
          valueB: invB.toDouble(),
          displayA: FormatUtils.formatNumber(invA),
          displayB: FormatUtils.formatNumber(invB),
          colorA: colorA,
          colorB: colorB,
        ),
      ],
    );
  }

  String _grade(double successPct) {
    if (successPct > 95) return 'S';
    if (successPct > 90) return 'A';
    if (successPct > 80) return 'B';
    if (successPct > 60) return 'C';
    return 'F';
  }
}

/// Agent header with name and grade badge.
class _AgentHeader extends StatelessWidget {
  final String name;
  final Color color;
  final String grade;

  const _AgentHeader({
    required this.name,
    required this.color,
    required this.grade,
  });

  @override
  Widget build(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Row(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Container(
          width: 28,
          height: 28,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: color.withValues(alpha: 0.15),
            border: Border.all(
              color: color.withValues(alpha: 0.4),
              width: 1,
            ),
          ),
          child: Center(
            child: Text(
              grade,
              style: textTheme.labelMedium!.copyWith(
                fontWeight: FiftyTypography.extraBold,
                color: color,
              ),
            ),
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),
        Flexible(
          child: Text(
            name,
            style: textTheme.labelLarge!.copyWith(
              color: color,
              letterSpacing: FiftyTypography.letterSpacingLabel,
            ),
          ),
        ),
      ],
    );
  }
}

/// Dual bar comparison for a single metric.
class _ComparisonBar extends StatelessWidget {
  final String label;
  final double valueA;
  final double valueB;
  final String displayA;
  final String displayB;
  final Color colorA;
  final Color colorB;
  final double? maxValue;
  final bool invertBetter;

  const _ComparisonBar({
    required this.label,
    required this.valueA,
    required this.valueB,
    required this.displayA,
    required this.displayB,
    required this.colorA,
    required this.colorB,
    this.maxValue,
    this.invertBetter = false,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final max = maxValue ?? [valueA, valueB, 1.0].reduce((a, b) => a > b ? a : b);
    final normalA = max > 0 ? (valueA / max).clamp(0, 1).toDouble() : 0.0;
    final normalB = max > 0 ? (valueB / max).clamp(0, 1).toDouble() : 0.0;

    // Determine which is "better"
    bool aWins;
    if (invertBetter) {
      aWins = valueA <= valueB; // Lower is better
    } else {
      aWins = valueA >= valueB; // Higher is better
    }

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        // Label
        Text(
          label.toUpperCase(),
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurface.withValues(alpha: 0.3),
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),
        // Values and bars
        Row(
          children: [
            // Agent A
            SizedBox(
              width: 48,
              child: Text(
                displayA,
                textAlign: TextAlign.right,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: aWins
                      ? colorA
                      : colorA.withValues(alpha: 0.5),
                ),
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
            // Bar A (right-aligned, growing left)
            Expanded(
              child: SizedBox(
                height: 8,
                child: ClipRRect(
                  borderRadius: FiftyRadii.smRadius,
                  child: Stack(
                    children: [
                      // Background
                      Container(
                        color: colorScheme.onSurface.withValues(alpha: 0.03),
                      ),
                      // Bar A from right
                      Align(
                        alignment: Alignment.centerRight,
                        child: FractionallySizedBox(
                          widthFactor: normalA,
                          child: Container(
                            decoration: BoxDecoration(
                              color: colorA.withValues(
                                alpha: aWins ? 0.6 : 0.3,
                              ),
                              borderRadius: FiftyRadii.smRadius,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            // Divider
            Container(
              width: 2,
              height: 12,
              color: colorScheme.onSurface.withValues(alpha: 0.1),
            ),
            // Bar B (left-aligned, growing right)
            Expanded(
              child: SizedBox(
                height: 8,
                child: ClipRRect(
                  borderRadius: FiftyRadii.smRadius,
                  child: Stack(
                    children: [
                      Container(
                        color: colorScheme.onSurface.withValues(alpha: 0.03),
                      ),
                      Align(
                        alignment: Alignment.centerLeft,
                        child: FractionallySizedBox(
                          widthFactor: normalB,
                          child: Container(
                            decoration: BoxDecoration(
                              color: colorB.withValues(
                                alpha: !aWins ? 0.6 : 0.3,
                              ),
                              borderRadius: FiftyRadii.smRadius,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
            // Agent B
            SizedBox(
              width: 48,
              child: Text(
                displayB,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: !aWins
                      ? colorB
                      : colorB.withValues(alpha: 0.5),
                ),
              ),
            ),
          ],
        ),
      ],
    );
  }
}
