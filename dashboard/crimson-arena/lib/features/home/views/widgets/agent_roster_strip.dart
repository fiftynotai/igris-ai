import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../data/models/agent_model.dart';
import '../../controllers/home_view_model.dart';

/// Horizontal scrollable agent roster strip.
///
/// Displays a compact card for each agent showing monogram, name,
/// level, invocation count, and RPG stat bars. Active agents are
/// highlighted with a border glow.
class AgentRosterStrip extends StatelessWidget {
  const AgentRosterStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      // Access .length to register the RxMap subscription with GetX.
      final _ = vm.agents.length;
      final agentsMap = vm.agents;

      return SizedBox(
        height: ArenaSizes.rosterStripHeight,
        child: ListView.separated(
          scrollDirection: Axis.horizontal,
          physics: const ClampingScrollPhysics(),
          padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.xs),
          itemCount: AgentConstants.agentOrder.length,
          separatorBuilder: (_, __) =>
              const SizedBox(width: FiftySpacing.sm),
          itemBuilder: (context, index) {
            final name = AgentConstants.agentOrder[index];
            final agent = agentsMap[name];
            return _AgentCard(agentName: name, agent: agent);
          },
        ),
      );
    });
  }
}

/// Single agent card in the roster strip.
class _AgentCard extends StatelessWidget {
  final String agentName;
  final AgentModel? agent;

  const _AgentCard({
    required this.agentName,
    this.agent,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    // Agent-specific color -- game identity, not migrated.
    final color = Color(
      AgentConstants.agentColors[agentName] ?? 0xFF888888,
    );
    final monogram = AgentConstants.agentMonograms[agentName] ??
        agentName.substring(0, 2).toUpperCase();
    final displayName = AgentConstants.agentNames[agentName] ??
        agentName.toUpperCase();
    final isActive = agent?.active ?? false;
    final invocations = agent?.invocations ?? 0;
    final levelTier = agent?.level.tier ?? 0;
    final progress = agent?.level.progress ?? 0;

    return Container(
      width: ArenaSizes.rosterCardWidth,
      padding: const EdgeInsets.all(FiftySpacing.sm),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(
          color: isActive
              ? color.withValues(alpha: 0.6)
              : colorScheme.outline,
          width: isActive ? 1.5 : 1,
        ),
        boxShadow: isActive
            ? [
                BoxShadow(
                  color: color.withValues(alpha: 0.2),
                  blurRadius: 8,
                  spreadRadius: 1,
                ),
              ]
            : null,
      ),
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          // Status dot + monogram
          Stack(
            alignment: Alignment.topRight,
            children: [
              // Monogram circle
              Container(
                width: ArenaSizes.monogramMedium,
                height: ArenaSizes.monogramMedium,
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
                    monogram,
                    style: textTheme.labelMedium!.copyWith(
                      fontWeight: FiftyTypography.extraBold,
                      color: color,
                    ),
                  ),
                ),
              ),
              // Status dot with tooltip for accessibility
              Tooltip(
                message: isActive
                    ? 'Active'
                    : (invocations > 0 ? 'Ready' : 'Unused'),
                child: Container(
                  width: ArenaSizes.statusDotLarge,
                  height: ArenaSizes.statusDotLarge,
                  decoration: BoxDecoration(
                    shape: BoxShape.circle,
                    color: isActive
                        ? ext.success
                        : (invocations > 0
                            ? colorScheme.onSurfaceVariant
                            : colorScheme.onSurface.withValues(alpha: 0.2)),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Agent name
          Tooltip(
            message: displayName,
            child: Text(
              displayName,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: colorScheme.onSurface,
                letterSpacing: FiftyTypography.letterSpacingLabel,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),

          // Level
          Text(
            'Lv.$levelTier',
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.5),
            ),
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Level progress bar
          SizedBox(
            height: ArenaSizes.gaugeProgressHeight,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: progress.clamp(0, 1).toDouble(),
                backgroundColor: colorScheme.onSurface.withValues(alpha: 0.05),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
          const Spacer(),

          // RPG stats mini bars
          if (agent != null) _RpgStatsBars(stats: agent!.rpgStats, color: color),

          // Invocations
          Text(
            '$invocations ${agentName == "orchestrator" ? "turns" : "runs"}',
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.4),
            ),
          ),
        ],
      ),
    );
  }
}

/// Mini RPG stat bars (STR/INT/SPD/VIT) for an agent card.
class _RpgStatsBars extends StatelessWidget {
  final RpgStats stats;
  final Color color;

  const _RpgStatsBars({required this.stats, required this.color});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        mainAxisAlignment: MainAxisAlignment.spaceEvenly,
        children: [
          _MiniBar(value: stats.str, color: color),
          _MiniBar(value: stats.int_, color: color),
          _MiniBar(value: stats.spd, color: color),
          _MiniBar(value: stats.vit, color: color),
        ],
      ),
    );
  }
}

/// A tiny vertical bar representing one RPG stat (0-100 scale).
class _MiniBar extends StatelessWidget {
  final int value;
  final Color color;

  const _MiniBar({required this.value, required this.color});

  @override
  Widget build(BuildContext context) {
    final height = (value / 100 * ArenaSizes.rpgStatBarMiniHeight).clamp(2.0, ArenaSizes.rpgStatBarMiniHeight);

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: ArenaSizes.rpgStatBarMiniWidth,
          height: ArenaSizes.rpgStatBarMiniHeight,
          alignment: Alignment.bottomCenter,
          child: Container(
            width: ArenaSizes.rpgStatBarMiniWidth,
            height: height,
            decoration: BoxDecoration(
              color: color.withValues(alpha: 0.6),
              borderRadius: FiftyRadii.smRadius,
            ),
          ),
        ),
      ],
    );
  }
}
