import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../data/models/instance_model.dart';

/// A single instance card displaying collapsed header and optional
/// expanded content (pipeline, agent nexus, log, team mode).
///
/// Status is indicated by a colored dot:
/// - Green (hunterGreen): active
/// - Gray (slateGrey): idle
/// - Red (burgundy): stale (no heartbeat > 2 minutes)
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
    final statusColor = _statusColor;
    final isActive = instance.isActive;

    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.sm),
      child: AnimatedSize(
        duration: FiftyMotion.compiling,
        curve: FiftyMotion.standard,
        alignment: Alignment.topCenter,
        child: Container(
          decoration: BoxDecoration(
            color: FiftyColors.surfaceDark,
            borderRadius: FiftyRadii.mdRadius,
            border: Border.all(
              color: isActive && isExpanded
                  ? FiftyColors.burgundy.withValues(alpha: 0.4)
                  : FiftyColors.borderDark,
              width: isActive && isExpanded ? 1.5 : 1,
            ),
            boxShadow: isActive
                ? [
                    BoxShadow(
                      color: FiftyColors.burgundy.withValues(alpha: 0.08),
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
              _buildHeader(statusColor),

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

  Widget _buildHeader(Color statusColor) {
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
            // Status dot
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
            const SizedBox(width: FiftySpacing.sm),

            // Hostname
            Text(
              instance.machineHostname.isNotEmpty
                  ? instance.machineHostname
                  : '--',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.semiBold,
                color: FiftyColors.cream,
              ),
            ),

            _separator(),

            // Project slug
            Text(
              instance.projectSlug.isNotEmpty
                  ? instance.projectSlug.toUpperCase()
                  : '--',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.burgundy,
              ),
            ),

            _separator(),

            // Brief
            Text(
              instance.currentBrief ?? '--',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.8),
              ),
            ),

            _separator(),

            // Phase
            Text(
              (instance.currentPhase ?? '--').toUpperCase(),
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.powderBlush,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
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
                  color: FiftyColors.slateGrey.withValues(alpha: 0.2),
                  borderRadius: FiftyRadii.smRadius,
                  border: Border.all(
                    color: FiftyColors.slateGrey.withValues(alpha: 0.3),
                    width: 1,
                  ),
                ),
                child: Text(
                  'TEAM LEAD',
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.bold,
                    color: FiftyColors.slateGrey,
                    letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                  ),
                ),
              ),
            ],

            const Spacer(),

            // Elapsed time
            Text(
              _relativeTime,
              style: GoogleFonts.sourceCodePro(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.slateGrey,
              ),
            ),
            const SizedBox(width: FiftySpacing.sm),

            // Expand/collapse indicator
            Text(
              isExpanded ? '[-]' : '[+]',
              style: GoogleFonts.sourceCodePro(
                fontSize: FiftyTypography.bodySmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.slateGrey,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget _separator() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: FiftySpacing.xs),
      child: Text(
        '/',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.bodySmall,
          fontWeight: FiftyTypography.medium,
          color: FiftyColors.slateGrey.withValues(alpha: 0.5),
        ),
      ),
    );
  }

  Color get _statusColor {
    if (instance.status == 'active') return FiftyColors.hunterGreen;

    // Check for stale based on heartbeat
    if (instance.lastHeartbeat != null) {
      final heartbeat = DateTime.tryParse(instance.lastHeartbeat!);
      if (heartbeat != null) {
        final staleDuration = DateTime.now().toUtc().difference(heartbeat);
        if (staleDuration.inMinutes > 2) return FiftyColors.burgundy;
      }
    }

    return FiftyColors.slateGrey;
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
