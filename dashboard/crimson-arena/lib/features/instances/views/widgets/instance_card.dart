import 'package:crimson_arena/core/theme/arena_text_styles.dart';
import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../data/models/instance_model.dart';

/// A single instance card displaying collapsed header and optional
/// expanded content (pipeline, agent nexus, log, team mode).
///
/// Status is indicated by a colored dot:
/// - Green (success): active
/// - Gray (onSurfaceVariant): idle
/// - Red (primary): stale (no heartbeat > 2 minutes)
class InstanceCard extends StatelessWidget {
  final InstanceModel instance;
  final bool isExpanded;
  final VoidCallback onTap;
  final Widget? expandedContent;

  const InstanceCard({
    super.key,
    required this.instance,
    required this.isExpanded,
    required this.onTap,
    this.expandedContent,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final statusColor = _resolveStatusColor(colorScheme, ext);
    final isActive = instance.isActive;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.sm),
      child: AnimatedSize(
        duration: FiftyMotion.compiling,
        curve: FiftyMotion.standard,
        alignment: Alignment.topCenter,
        child: Container(
          decoration: BoxDecoration(
            color: colorScheme.surfaceContainerHighest,
            borderRadius: FiftyRadii.mdRadius,
            border: Border.all(
              color: isActive && isExpanded
                  ? colorScheme.primary.withValues(alpha: 0.4)
                  : colorScheme.outline,
              width: isActive && isExpanded ? 1.5 : 1,
            ),
            boxShadow: isActive
                ? [
                    BoxShadow(
                      color: colorScheme.primary.withValues(alpha: 0.08),
                      blurRadius: 12,
                      spreadRadius: 0,
                    ),
                  ]
                : null,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            mainAxisSize: MainAxisSize.min,
            children: [
              // Collapsed header (always visible)
              _buildHeader(context, statusColor),

              // Expanded content
              if (isExpanded && expandedContent != null)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    FiftySpacing.md,
                    0,
                    FiftySpacing.md,
                    FiftySpacing.md,
                  ),
                  child: expandedContent,
                ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildHeader(BuildContext context, Color statusColor) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return InkWell(
      onTap: onTap,
      borderRadius: FiftyRadii.mdRadius,
      child: Padding(
        padding: const EdgeInsets.symmetric(
          horizontal: FiftySpacing.md,
          vertical: FiftySpacing.sm,
        ),
        child: Row(
          children: [
            // Status dot + label
            Container(
              width: 8,
              height: 8,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: statusColor,
                boxShadow: instance.isActive
                    ? [
                        BoxShadow(
                          color: statusColor.withValues(alpha: 0.5),
                          blurRadius: 6,
                          spreadRadius: 1,
                        ),
                      ]
                    : null,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
            Text(
              _statusLabel,
              style: textTheme.labelSmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: statusColor,
                letterSpacing: FiftyTypography.letterSpacingLabel,
              ),
            ),
            const SizedBox(width: FiftySpacing.sm),

            // Hostname
            Flexible(
              child: Tooltip(
                message: instance.machineHostname.isNotEmpty
                    ? instance.machineHostname
                    : '--',
                child: Text(
                  instance.machineHostname.isNotEmpty
                      ? instance.machineHostname
                      : '--',
                  style: textTheme.bodySmall!.copyWith(
                    fontWeight: FiftyTypography.semiBold,
                    color: colorScheme.onSurface,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),

            _separator(context),

            // Project slug
            Flexible(
              child: Tooltip(
                message: instance.projectSlug.isNotEmpty
                    ? instance.projectSlug.toUpperCase()
                    : '--',
                child: Text(
                  instance.projectSlug.isNotEmpty
                      ? instance.projectSlug.toUpperCase()
                      : '--',
                  style: textTheme.bodySmall!.copyWith(
                    fontWeight: FiftyTypography.bold,
                    color: colorScheme.primary,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),

            _separator(context),

            // Brief
            Flexible(
              child: Tooltip(
                message: instance.currentBrief ?? '--',
                child: Text(
                  instance.currentBrief ?? '--',
                  style: textTheme.bodySmall!.copyWith(
                    fontWeight: FiftyTypography.medium,
                    color: colorScheme.onSurface.withValues(alpha: 0.8),
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ),

            _separator(context),

            // Phase
            Text(
              (instance.currentPhase ?? '--').toUpperCase(),
              style: textTheme.bodySmall!.copyWith(
                fontWeight: FiftyTypography.bold,
                color: ext.accent,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
              maxLines: 1,
            ),

            // Team badge
            if (_isTeamLead) ...[
              const SizedBox(width: FiftySpacing.sm),
              Container(
                padding: const EdgeInsets.symmetric(
                  horizontal: FiftySpacing.xs,
                  vertical: 2,
                ),
                decoration: BoxDecoration(
                  color: colorScheme.onSurfaceVariant.withValues(alpha: 0.2),
                  borderRadius: FiftyRadii.smRadius,
                  border: Border.all(
                    color: colorScheme.onSurfaceVariant.withValues(alpha: 0.3),
                    width: 1,
                  ),
                ),
                child: Text(
                  'TEAM LEAD',
                  style: textTheme.labelSmall!.copyWith(
                    fontWeight: FiftyTypography.bold,
                    color: colorScheme.onSurfaceVariant,
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
                ),
              ),
            ],

            const Spacer(),

            // Elapsed time
            Text(
              _relativeTime,
              style: ArenaTextStyles.mono(
                context,
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.medium,
                color: colorScheme.onSurfaceVariant,
              ),
            ),
            const SizedBox(width: FiftySpacing.sm),

            // Expand/collapse indicator
            Text(
              isExpanded ? '[-]' : '[+]',
              style: ArenaTextStyles.mono(
                context,
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.bold,
                color: colorScheme.onSurfaceVariant,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _separator(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.xs),
      child: Text(
        '/',
        style: textTheme.bodySmall!.copyWith(
          fontWeight: FiftyTypography.medium,
          color: colorScheme.onSurfaceVariant.withValues(alpha: 0.5),
        ),
      ),
    );
  }

  Color _resolveStatusColor(ColorScheme colorScheme, FiftyThemeExtension ext) {
    if (instance.status == 'active') return ext.success;

    // Check for stale based on heartbeat
    if (instance.lastHeartbeat != null) {
      final heartbeat = DateTime.tryParse(instance.lastHeartbeat!);
      if (heartbeat != null) {
        final staleDuration = DateTime.now().toUtc().difference(heartbeat);
        if (staleDuration.inMinutes > 2) return colorScheme.primary;
      }
    }

    return colorScheme.onSurfaceVariant;
  }

  String get _statusLabel {
    if (instance.status == 'active') return 'ACTIVE';
    if (instance.lastHeartbeat != null) {
      final heartbeat = DateTime.tryParse(instance.lastHeartbeat!);
      if (heartbeat != null) {
        final staleDuration = DateTime.now().toUtc().difference(heartbeat);
        if (staleDuration.inMinutes > 2) return 'STALE';
      }
    }
    return 'IDLE';
  }

  bool get _isTeamLead {
    // The instance is a team lead if it has teammates or is flagged.
    return false; // Determined externally by checking team status.
  }

  String get _relativeTime {
    if (instance.lastHeartbeat == null) return '--';
    final heartbeat = DateTime.tryParse(instance.lastHeartbeat!);
    if (heartbeat == null) return '--';

    final diff = DateTime.now().toUtc().difference(heartbeat);
    if (diff.inSeconds < 60) return '${diff.inSeconds}s ago';
    if (diff.inMinutes < 60) return '${diff.inMinutes}m ago';
    if (diff.inHours < 24) return '${diff.inHours}h ago';
    return '${diff.inDays}d ago';
  }
}
