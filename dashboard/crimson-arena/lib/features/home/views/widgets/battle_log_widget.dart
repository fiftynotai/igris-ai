import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/battle_log_entry.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Battle Log widget.
///
/// Scrollable list of recent agent events. Each entry shows timestamp,
/// agent badge, event description, token count, and duration.
/// New events appear at the top.
class BattleLogWidget extends StatelessWidget {
  const BattleLogWidget({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final entries = vm.battleLog;

      return ArenaCard(
        title: 'BATTLE LOG',
        trailing: Text(
          '${entries.length} events',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        padding: const EdgeInsets.fromLTRB(
          FiftySpacing.md,
          FiftySpacing.md,
          FiftySpacing.md,
          FiftySpacing.xs,
        ),
        child: entries.isEmpty
            ? Padding(
                padding: const EdgeInsets.only(bottom: FiftySpacing.sm),
                child: Text(
                  'No agent activity recorded',
                  style: textTheme.bodySmall!.copyWith(
                    color: colorScheme.onSurfaceVariant,
                  ),
                ),
              )
            : SizedBox(
                height: ArenaSizes.battleLogHeight,
                child: ListView.builder(
                  physics: const ClampingScrollPhysics(),
                  itemCount: entries.length,
                  itemBuilder: (_, index) => _BattleLogRow(
                    entry: entries[index],
                  ),
                ),
              ),
      );
    });
  }
}

/// A single battle log entry row.
class _BattleLogRow extends StatelessWidget {
  final BattleLogEntry entry;

  const _BattleLogRow({required this.entry});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final time = FormatUtils.formatTime(entry.timestamp);
    final agentName = AgentConstants.agentNames[entry.agent] ??
        entry.agent.toUpperCase();
    // Agent-specific color -- game identity, not migrated.
    final agentColor = Color(
      AgentConstants.agentColors[entry.agent] ?? 0xFF888888,
    );

    final isStart = entry.isStartEvent;
    final isSkill = entry.event == 'skill_invoke';

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.sm),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.center,
        children: [
          // Timestamp
          Text(
            '[$time]',
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.3),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Agent badge
          FiftyBadge(
            label: isSkill ? 'SKILL' : agentName,
            customColor: agentColor,
            showGlow: false,
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Event description
          Expanded(
            child: _buildDescription(context, isStart, isSkill, colorScheme, ext),
          ),
        ],
      ),
    );
  }

  Widget _buildDescription(
    BuildContext context,
    bool isStart,
    bool isSkill,
    ColorScheme colorScheme,
    FiftyThemeExtension ext,
  ) {
    final textTheme = Theme.of(context).textTheme;

    if (isSkill) {
      final skillName = entry.rawType ?? 'unknown';
      return Text(
        '/$skillName invoked',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.medium,
          color: ext.accent,
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    }

    if (isStart) {
      return Text(
        'deployed to battle',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.medium,
          color: colorScheme.onSurface.withValues(alpha: 0.5),
        ),
        maxLines: 1,
        overflow: TextOverflow.ellipsis,
      );
    }

    // Stop event
    final directTokens = entry.inputTokens + entry.outputTokens;
    final cachedTokens = entry.cacheRead + entry.cacheCreate;
    final dur = entry.durationSeconds != null
        ? FormatUtils.formatDuration(entry.durationSeconds!)
        : '--';

    return Text.rich(
      TextSpan(
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.medium,
          color: colorScheme.onSurface.withValues(alpha: 0.5),
        ),
        children: [
          const TextSpan(text: 'completed \u2014 '),
          TextSpan(
            text: '${FormatUtils.formatNumber(directTokens)} tokens',
            style: TextStyle(color: colorScheme.onSurface),
          ),
          if (cachedTokens > 0)
            TextSpan(
              text: ' (+ ${FormatUtils.formatTokens(cachedTokens)} cached)',
              style: TextStyle(color: ext.success),
            ),
          TextSpan(text: ' ($dur)'),
        ],
      ),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    );
  }
}
