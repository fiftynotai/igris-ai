import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../data/models/session_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';

/// Sessions panel for the Brain Command Center.
///
/// Displays a compact list of recent brain sessions with timestamps,
/// project names, brief IDs, modes, and summaries.
class BrainSessionsPanel extends StatelessWidget {
  /// The list of sessions to display.
  final List<SessionModel> sessions;

  const BrainSessionsPanel({super.key, required this.sessions});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return ArenaCard(
      title: 'RECENT SESSIONS',
      trailing: Text(
        '${sessions.length}',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.bold,
          color: colorScheme.onSurface,
        ),
      ),
      child: sessions.isEmpty
          ? Text(
              'No recent sessions',
              style: textTheme.bodySmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
              ),
            )
          : Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: sessions.take(8).map((session) {
                return _SessionRow(session: session);
              }).toList(),
            ),
    );
  }
}

/// A single session row in the sessions list.
class _SessionRow extends StatelessWidget {
  final SessionModel session;

  const _SessionRow({required this.session});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Time
          Text(
            FormatUtils.timeAgo(session.createdAt),
            style: textTheme.labelSmall!.copyWith(
              fontWeight: FiftyTypography.medium,
              color: colorScheme.onSurface.withValues(alpha: 0.3),
            ),
            maxLines: 1,
          ),
          const SizedBox(width: FiftySpacing.sm),
          // Project
          Flexible(
            flex: 0,
            child: Tooltip(
              message: session.project,
              child: Text(
                session.project,
                style: textTheme.labelSmall!.copyWith(
                  fontWeight: FiftyTypography.bold,
                  color: colorScheme.onSurface.withValues(alpha: 0.7),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ),
          if (session.briefId != null) ...[
            const SizedBox(width: FiftySpacing.sm),
            Container(
              padding: const EdgeInsets.symmetric(
                horizontal: 4,
                vertical: 1,
              ),
              decoration: BoxDecoration(
                color: colorScheme.primary.withValues(alpha: 0.15),
                borderRadius: FiftyRadii.smRadius,
              ),
              child: Text(
                session.briefId!,
                style: textTheme.labelSmall!.copyWith(
                  color: colorScheme.primary,
                ),
              ),
            ),
          ],
          if (session.mode != null) ...[
            const SizedBox(width: FiftySpacing.xs),
            Text(
              session.mode!,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurfaceVariant,
              ),
              maxLines: 1,
            ),
          ],
          if (session.summary != null) ...[
            const SizedBox(width: FiftySpacing.sm),
            Expanded(
              child: Tooltip(
                message: session.summary!,
                child: Text(
                  session.summary!,
                  style: textTheme.labelSmall!.copyWith(
                    fontWeight: FiftyTypography.medium,
                    color: colorScheme.onSurface.withValues(alpha: 0.4),
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),
          ] else
            const Spacer(),
        ],
      ),
    );
  }
}
