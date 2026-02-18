import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import 'package:fifty_ui/fifty_ui.dart';

import '../../../../data/models/brief_model.dart';
import '../../../../shared/widgets/arena_card.dart';

/// Briefs panel for the Brain Command Center.
///
/// Displays brief status pills (Ready, In Progress, Done, etc.) and a
/// compact table of the first 10 briefs showing project, brief ID, title,
/// and priority.
class BrainBriefsPanel extends StatelessWidget {
  /// The list of briefs to display.
  final List<BriefModel> briefs;

  /// Aggregated status counts (e.g. {"Ready": 3, "Done": 5}).
  final Map<String, int> statusCounts;

  const BrainBriefsPanel({
    super.key,
    required this.briefs,
    required this.statusCounts,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return ArenaCard(
      title: 'BRIEFS',
      trailing: Text(
        '${briefs.length}',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.bold,
          color: colorScheme.onSurface,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Status pills
          if (statusCounts.isNotEmpty)
            Wrap(
              spacing: FiftySpacing.xs,
              runSpacing: FiftySpacing.xs,
              children: statusCounts.entries.map((entry) {
                return FiftyBadge(
                  label: '${entry.key}: ${entry.value}',
                  customColor: _statusColor(
                    entry.key,
                    colorScheme,
                    theme.extension<FiftyThemeExtension>()!,
                  ),
                  showGlow: false,
                );
              }).toList(),
            ),
          if (briefs.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: FiftySpacing.xs),
              child: Text(
                'No briefs found',
                style: textTheme.bodySmall!.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
            ),
          if (briefs.isNotEmpty) ...[
            const SizedBox(height: FiftySpacing.sm),
            // Brief table (compact)
            ...briefs.take(10).map((brief) => _BriefRow(brief: brief)),
          ],
        ],
      ),
    );
  }
}

/// Returns the accent color for a brief status label.
Color _statusColor(
  String status,
  ColorScheme colorScheme,
  FiftyThemeExtension ext,
) {
  switch (status) {
    case 'Ready':
      return colorScheme.onSurfaceVariant;
    case 'In Progress':
      return ext.warning;
    case 'Done':
      return ext.success;
    case 'Blocked':
      return colorScheme.primary;
    case 'Draft':
      return colorScheme.onSurface.withValues(alpha: 0.5);
    default:
      return colorScheme.onSurfaceVariant;
  }
}

/// A single brief row in the briefs table.
class _BriefRow extends StatelessWidget {
  final BriefModel brief;

  const _BriefRow({required this.brief});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Project
          Tooltip(
            message: brief.project,
            child: ConstrainedBox(
              constraints: const BoxConstraints(
                minWidth: 48,
                maxWidth: 80,
              ),
              child: Text(
                brief.project,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.medium,
                  color: colorScheme.onSurfaceVariant,
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          // Brief ID
          ConstrainedBox(
            constraints: const BoxConstraints(
              minWidth: 56,
              maxWidth: 80,
            ),
            child: Text(
              brief.briefId,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: colorScheme.onSurface.withValues(alpha: 0.7),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          // Title
          Expanded(
            child: Tooltip(
              message: brief.title,
              child: Text(
                brief.title,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.medium,
                  color: colorScheme.onSurface.withValues(alpha: 0.5),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          // Priority
          Text(
            brief.priority,
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.bold,
              color: _priorityColor(brief.priority, colorScheme, ext),
            ),
          ),
        ],
      ),
    );
  }

  Color _priorityColor(
    String priority,
    ColorScheme colorScheme,
    FiftyThemeExtension ext,
  ) {
    switch (priority) {
      case 'P0':
        return colorScheme.primary;
      case 'P1':
        return ext.warning;
      case 'P2':
        return colorScheme.onSurfaceVariant;
      default:
        return colorScheme.onSurface.withValues(alpha: 0.4);
    }
  }
}
