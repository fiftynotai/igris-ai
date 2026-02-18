import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/team_status_model.dart';

/// Displays team mode status for a team-lead instance.
///
/// Shows:
/// - Team header with name, brief count, and active status
/// - Teammate cards grid with mini-pipelines
/// - Coordination log with timestamped events
/// - File ownership table
class TeamModeWidget extends StatelessWidget {
  final TeamStatusModel teamStatus;

  const TeamModeWidget({
    super.key,
    required this.teamStatus,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(FiftySpacing.md),
      decoration: BoxDecoration(
        color: FiftyColors.darkBurgundy.withValues(alpha: 0.5),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: FiftyColors.slateGrey.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Team header
          _buildTeamHeader(),
          const SizedBox(height: FiftySpacing.md),

          // Teammate cards
          if (teamStatus.teammates.isNotEmpty) ...[
            _buildTeammateGrid(),
            const SizedBox(height: FiftySpacing.md),
          ],

          // Coordination log
          _buildCoordinationLog(),

          // File ownership
          if (teamStatus.fileOwnership.isNotEmpty) ...[
            const SizedBox(height: FiftySpacing.md),
            _buildFileOwnership(),
          ],
        ],
      ),
    );
  }

  Widget _buildTeamHeader() {
    return Row(
      children: [
        // Team icon
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: teamStatus.active
                ? FiftyColors.hunterGreen
                : FiftyColors.slateGrey,
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),

        Text(
          'TEAM: "${teamStatus.teamName}"',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),

        Text(
          '${teamStatus.teammates.length} briefs',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.cream.withValues(alpha: 0.6),
          ),
        ),

        const Spacer(),

        // Status badge
        Container(
          padding: const EdgeInsets.symmetric(
            horizontal: FiftySpacing.xs,
            vertical: 2,
          ),
          decoration: BoxDecoration(
            color: teamStatus.active
                ? FiftyColors.hunterGreen.withValues(alpha: 0.15)
                : FiftyColors.slateGrey.withValues(alpha: 0.15),
            borderRadius: FiftyRadii.smRadius,
            border: Border.all(
              color: teamStatus.active
                  ? FiftyColors.hunterGreen.withValues(alpha: 0.3)
                  : FiftyColors.slateGrey.withValues(alpha: 0.3),
              width: 1,
            ),
          ),
          child: Text(
            teamStatus.active ? 'ACTIVE' : 'IDLE',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.bold,
              color: teamStatus.active
                  ? FiftyColors.hunterGreen
                  : FiftyColors.slateGrey,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildTeammateGrid() {
    return Wrap(
      spacing: FiftySpacing.sm,
      runSpacing: FiftySpacing.sm,
      children: teamStatus.teammates.map(_buildTeammateCard).toList(),
    );
  }

  Widget _buildTeammateCard(TeammateModel teammate) {
    final rawPhase = teammate.phase.toUpperCase();
    final phaseKey = AgentConstants.phaseMap[rawPhase];
    final currentIndex = phaseKey != null
        ? AgentConstants.huntPhases.indexOf(phaseKey)
        : -1;

    return Container(
      width: 280,
      padding: const EdgeInsets.all(FiftySpacing.sm),
      decoration: BoxDecoration(
        color: FiftyColors.surfaceDark,
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: FiftyColors.borderDark,
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Teammate header
          Row(
            children: [
              Expanded(
                child: Text(
                  teammate.name,
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.bodySmall,
                    fontWeight: FiftyTypography.bold,
                    color: FiftyColors.cream,
                  ),
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Text(
                teammate.brief,
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.bodySmall,
                  fontWeight: FiftyTypography.medium,
                  color: FiftyColors.powderBlush,
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Phase + elapsed
          Row(
            children: [
              Text(
                teammate.phase.toUpperCase(),
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.bold,
                  color: FiftyColors.burgundy,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              const Spacer(),
              Text(
                teammate.elapsed,
                style: GoogleFonts.sourceCodePro(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: FiftyColors.slateGrey,
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Mini pipeline
          _buildMiniPipeline(currentIndex),

          const SizedBox(height: FiftySpacing.xs),

          // Token count
          Row(
            children: [
              Text(
                'Tokens: ${_formatTokens(teammate.tokens)}',
                style: GoogleFonts.sourceCodePro(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: FiftyColors.slateGrey,
                ),
              ),
              if (teammate.retries > 0) ...[
                const Spacer(),
                Text(
                  'Retries: ${teammate.retries}',
                  style: GoogleFonts.sourceCodePro(
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.medium,
                    color: FiftyColors.warning,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildMiniPipeline(int currentIndex) {
    return Row(
      children: [
        for (int i = 0; i < AgentConstants.huntPhases.length; i++) ...[
          if (i > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Text(
                '\u2192',
                style: GoogleFonts.sourceCodePro(
                  fontSize: 8,
                  color: currentIndex >= 0 && i <= currentIndex
                      ? FiftyColors.hunterGreen.withValues(alpha: 0.6)
                      : FiftyColors.borderDark,
                ),
              ),
            ),
          _buildMiniPhaseNode(i, currentIndex),
        ],
      ],
    );
  }

  Widget _buildMiniPhaseNode(int index, int currentIndex) {
    final phase = AgentConstants.huntPhases[index];
    final isDone = currentIndex >= 0 && index < currentIndex;
    final isCurrent = index == currentIndex;

    Color color;
    if (isDone) {
      color = FiftyColors.hunterGreen;
    } else if (isCurrent) {
      color = FiftyColors.burgundy;
    } else {
      color = FiftyColors.slateGrey.withValues(alpha: 0.3);
    }

    return Text(
      phase.toUpperCase().substring(0, 1),
      style: GoogleFonts.sourceCodePro(
        fontSize: 8,
        fontWeight: isCurrent ? FiftyTypography.bold : FiftyTypography.medium,
        color: color,
      ),
    );
  }

  Widget _buildCoordinationLog() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'COORDINATION LOG',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),

        if (teamStatus.coordinationLog.isEmpty)
          Text(
            'No coordination data available',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.slateGrey.withValues(alpha: 0.5),
            ),
          )
        else
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 120),
            child: ListView.builder(
              shrinkWrap: true,
              itemCount: teamStatus.coordinationLog.length,
              itemBuilder: (context, index) {
                final entry = teamStatus.coordinationLog[index];
                return Padding(
                  padding: const EdgeInsets.symmetric(vertical: 1),
                  child: Row(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        '[${entry.timestamp}]',
                        style: GoogleFonts.sourceCodePro(
                          fontSize: FiftyTypography.labelSmall,
                          fontWeight: FiftyTypography.medium,
                          color: FiftyColors.slateGrey,
                        ),
                      ),
                      const SizedBox(width: FiftySpacing.xs),
                      Expanded(
                        child: Text(
                          entry.message,
                          style: GoogleFonts.sourceCodePro(
                            fontSize: FiftyTypography.labelSmall,
                            fontWeight: FiftyTypography.medium,
                            color: FiftyColors.cream.withValues(alpha: 0.7),
                          ),
                        ),
                      ),
                    ],
                  ),
                );
              },
            ),
          ),
      ],
    );
  }

  Widget _buildFileOwnership() {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'FILE OWNERSHIP',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),

        ...teamStatus.fileOwnership.entries.map((entry) {
          return Padding(
            padding: const EdgeInsets.symmetric(vertical: 1),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    entry.key,
                    style: GoogleFonts.sourceCodePro(
                      fontSize: FiftyTypography.labelSmall,
                      fontWeight: FiftyTypography.medium,
                      color: FiftyColors.cream.withValues(alpha: 0.6),
                    ),
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
                const SizedBox(width: FiftySpacing.sm),
                Text(
                  entry.value,
                  style: GoogleFonts.sourceCodePro(
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.bold,
                    color: FiftyColors.powderBlush,
                  ),
                ),
              ],
            ),
          );
        }),
      ],
    );
  }

  String _formatTokens(int tokens) {
    if (tokens == 0) return '0';
    if (tokens < 1000) return '$tokens';
    if (tokens < 1000000) return '${(tokens / 1000).toStringAsFixed(1)}K';
    return '${(tokens / 1000000).toStringAsFixed(1)}M';
  }
}
