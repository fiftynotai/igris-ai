import 'package:crimson_arena/core/theme/arena_text_styles.dart';
import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

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
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.all(FiftySpacing.md),
      decoration: BoxDecoration(
        color: colorScheme.surface.withValues(alpha: 0.5),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: colorScheme.onSurfaceVariant.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Team header
          _buildTeamHeader(context),
          const SizedBox(height: FiftySpacing.md),

          // Teammate cards
          if (teamStatus.teammates.isNotEmpty) ...[
            _buildTeammateGrid(context),
            const SizedBox(height: FiftySpacing.md),
          ],

          // Coordination log
          _buildCoordinationLog(context),

          // File ownership
          if (teamStatus.fileOwnership.isNotEmpty) ...[
            const SizedBox(height: FiftySpacing.md),
            _buildFileOwnership(context),
          ],
        ],
      ),
    );
  }

  Widget _buildTeamHeader(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return Row(
      children: [
        // Team icon
        Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: teamStatus.active
                ? ext.success
                : colorScheme.onSurfaceVariant,
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),

        Text(
          'TEAM: "${teamStatus.teamName}"',
          style: textTheme.labelMedium!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(width: FiftySpacing.sm),

        Text(
          '${teamStatus.teammates.length} briefs',
          style: textTheme.labelSmall!.copyWith(
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurface.withValues(alpha: 0.6),
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
                ? ext.success.withValues(alpha: 0.15)
                : colorScheme.onSurfaceVariant.withValues(alpha: 0.15),
            borderRadius: FiftyRadii.smRadius,
            border: Border.all(
              color: teamStatus.active
                  ? ext.success.withValues(alpha: 0.3)
                  : colorScheme.onSurfaceVariant.withValues(alpha: 0.3),
              width: 1,
            ),
          ),
          child: Text(
            teamStatus.active ? 'ACTIVE' : 'IDLE',
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.bold,
              color: teamStatus.active
                  ? ext.success
                  : colorScheme.onSurfaceVariant,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ),
      ],
    );
  }

  Widget _buildTeammateGrid(BuildContext context) {
    return Wrap(
      spacing: FiftySpacing.sm,
      runSpacing: FiftySpacing.sm,
      children:
          teamStatus.teammates.map((t) => _buildTeammateCard(context, t)).toList(),
    );
  }

  Widget _buildTeammateCard(BuildContext context, TeammateModel teammate) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final rawPhase = teammate.phase.toUpperCase();
    final phaseKey = AgentConstants.phaseMap[rawPhase];
    final currentIndex = phaseKey != null
        ? AgentConstants.huntPhases.indexOf(phaseKey)
        : -1;

    return Container(
      width: 280,
      padding: const EdgeInsets.all(FiftySpacing.sm),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: colorScheme.outline,
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
                child: Tooltip(
                  message: teammate.name,
                  child: Text(
                    teammate.name,
                    style: textTheme.bodySmall!.copyWith(
                      fontWeight: FiftyTypography.bold,
                      color: colorScheme.onSurface,
                    ),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              ),
              Text(
                teammate.brief,
                style: textTheme.bodySmall!.copyWith(
                  fontWeight: FiftyTypography.medium,
                  color: ext.accent,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Phase + elapsed
          Row(
            children: [
              Text(
                teammate.phase.toUpperCase(),
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: colorScheme.primary,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              const Spacer(),
              Text(
                teammate.elapsed,
                style: ArenaTextStyles.mono(
                  context,
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Mini pipeline
          _buildMiniPipeline(context, currentIndex),

          const SizedBox(height: FiftySpacing.xs),

          // Token count
          Row(
            children: [
              Text(
                'Tokens: ${_formatTokens(teammate.tokens)}',
                style: ArenaTextStyles.mono(
                  context,
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
              if (teammate.retries > 0) ...[
                const Spacer(),
                Text(
                  'Retries: ${teammate.retries}',
                  style: ArenaTextStyles.mono(
                    context,
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.medium,
                    color: ext.warning,
                  ),
                ),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildMiniPipeline(BuildContext context, int currentIndex) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;

    return Row(
      children: [
        for (int i = 0; i < AgentConstants.huntPhases.length; i++) ...[
          if (i > 0)
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 2),
              child: Text(
                '\u2192',
                style: ArenaTextStyles.mono(
                  context,
                  fontSize: 11,
                  color: currentIndex >= 0 && i <= currentIndex
                      ? ext.success.withValues(alpha: 0.6)
                      : colorScheme.outline,
                ),
              ),
            ),
          _buildMiniPhaseNode(context, i, currentIndex),
        ],
      ],
    );
  }

  Widget _buildMiniPhaseNode(
      BuildContext context, int index, int currentIndex) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final phase = AgentConstants.huntPhases[index];
    final isDone = currentIndex >= 0 && index < currentIndex;
    final isCurrent = index == currentIndex;

    Color color;
    if (isDone) {
      color = ext.success;
    } else if (isCurrent) {
      color = colorScheme.primary;
    } else {
      color = colorScheme.onSurfaceVariant.withValues(alpha: 0.3);
    }

    return Text(
      phase.toUpperCase().substring(0, 1),
      style: ArenaTextStyles.mono(
        context,
        fontSize: 11,
        fontWeight: isCurrent ? FiftyTypography.bold : FiftyTypography.medium,
        color: color,
      ),
    );
  }

  Widget _buildCoordinationLog(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'COORDINATION LOG',
          style: textTheme.labelMedium!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),

        if (teamStatus.coordinationLog.isEmpty)
          Center(
            child: Text(
              'No coordination data available',
              style: textTheme.bodySmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            ),
          )
        else
          ConstrainedBox(
            constraints: const BoxConstraints(maxHeight: 120),
            child: ListView.builder(
              shrinkWrap: true,
              physics: const ClampingScrollPhysics(),
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
                        style: ArenaTextStyles.mono(
                          context,
                          fontSize: FiftyTypography.labelSmall,
                          fontWeight: FiftyTypography.medium,
                          color: colorScheme.onSurfaceVariant,
                        ),
                      ),
                      const SizedBox(width: FiftySpacing.xs),
                      Expanded(
                        child: Text(
                          entry.message,
                          style: ArenaTextStyles.mono(
                            context,
                            fontSize: FiftyTypography.labelSmall,
                            fontWeight: FiftyTypography.medium,
                            color: colorScheme.onSurface.withValues(alpha: 0.7),
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

  Widget _buildFileOwnership(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          'FILE OWNERSHIP',
          style: textTheme.labelMedium!.copyWith(
            color: colorScheme.onSurfaceVariant,
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
                  child: Tooltip(
                    message: entry.key,
                    child: Text(
                      entry.key,
                      style: ArenaTextStyles.mono(
                        context,
                        fontSize: FiftyTypography.labelSmall,
                        fontWeight: FiftyTypography.medium,
                        color: colorScheme.onSurface.withValues(alpha: 0.6),
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                ),
                const SizedBox(width: FiftySpacing.sm),
                Text(
                  entry.value,
                  style: ArenaTextStyles.mono(
                    context,
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.bold,
                    color: ext.accent,
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
