import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/battle_log_entry.dart';
import '../../../../shared/utils/format_utils.dart';
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
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final entries = vm.battleLog;

      return ArenaCard(
        title: 'BATTLE LOG',
        trailing: Text(
          '${entries.length} events',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.slateGrey,
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
                  '> Awaiting agent activity...',
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.bodySmall,
                    color: FiftyColors.slateGrey,
                  ),
                ),
              )
            : SizedBox(
                height: 280,
                child: ListView.builder(
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
    final time = FormatUtils.formatTime(entry.timestamp);
    final agentName = AgentConstants.agentNames[entry.agent] ??
        entry.agent.toUpperCase();
    final agentColor = Color(
      AgentConstants.agentColors[entry.agent] ?? 0xFF888888,
    );

    final isStart = entry.isStartEvent;
    final isSkill = entry.event == 'skill_invoke';

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Timestamp
          Text(
            '[$time]',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.3),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Agent badge
          Container(
            padding: const EdgeInsets.symmetric(
              horizontal: FiftySpacing.xs,
              vertical: 1,
            ),
            decoration: BoxDecoration(
              color: agentColor.withValues(alpha: 0.15),
              borderRadius: FiftyRadii.smRadius,
            ),
            child: Text(
              isSkill ? 'SKILL' : agentName,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: agentColor,
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),

          // Event description
          Expanded(
            child: _buildDescription(isStart, isSkill),
          ),
        ],
      ),
    );
  }

  Widget _buildDescription(bool isStart, bool isSkill) {
    if (isSkill) {
      final skillName = entry.rawType ?? 'unknown';
      return Text(
        '/$skillName invoked',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.medium,
          color: FiftyColors.powderBlush,
        ),
      );
    }

    if (isStart) {
      return Text(
        'deployed to battle',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.medium,
          color: FiftyColors.cream.withValues(alpha: 0.5),
        ),
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
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.medium,
          color: FiftyColors.cream.withValues(alpha: 0.5),
        ),
        children: [
          const TextSpan(text: 'completed \u2014 '),
          TextSpan(
            text: '${FormatUtils.formatNumber(directTokens)} tokens',
            style: const TextStyle(color: FiftyColors.cream),
          ),
          if (cachedTokens > 0)
            TextSpan(
              text: ' (+ ${FormatUtils.formatTokens(cachedTokens)} cached)',
              style: const TextStyle(color: FiftyColors.hunterGreen),
            ),
          TextSpan(text: ' ($dur)'),
        ],
      ),
      maxLines: 2,
      overflow: TextOverflow.ellipsis,
    );
  }
}
