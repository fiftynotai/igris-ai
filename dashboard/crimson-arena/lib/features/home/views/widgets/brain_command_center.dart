import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../data/models/brief_model.dart';
import '../../../../data/models/project_model.dart';
import '../../../../data/models/session_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Brain Command Center.
///
/// Shows three panels: Projects, Briefs, and Sessions from the brain
/// server. Mirrors the brain section from the vanilla JS dashboard.
class BrainCommandCenter extends StatelessWidget {
  const BrainCommandCenter({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      if (!vm.brainAvailable.value) {
        return ArenaCard(
          title: 'BRAIN COMMAND CENTER',
          child: Text(
            '> Brain offline. Command center unavailable.',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      return Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Section header
          Padding(
            padding: const EdgeInsets.only(
              left: FiftySpacing.xs,
              bottom: FiftySpacing.sm,
            ),
            child: Text(
              'BRAIN COMMAND CENTER',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelMedium,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.slateGrey,
                letterSpacing: FiftyTypography.letterSpacingLabelMedium,
              ),
            ),
          ),

          // Projects panel
          _ProjectsPanel(projects: vm.brainProjects),
          const SizedBox(height: FiftySpacing.sm),

          // Briefs panel
          _BriefsPanel(
            briefs: vm.brainBriefs,
            statusCounts: vm.briefStatusCounts,
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Sessions panel
          _SessionsPanel(sessions: vm.brainSessions),
        ],
      );
    });
  }
}

// ---------------------------------------------------------------------------
// Projects panel
// ---------------------------------------------------------------------------

class _ProjectsPanel extends StatelessWidget {
  final List<ProjectModel> projects;

  const _ProjectsPanel({required this.projects});

  @override
  Widget build(BuildContext context) {
    return ArenaCard(
      title: 'PROJECTS',
      trailing: Text(
        '${projects.length}',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.bold,
          color: FiftyColors.cream,
        ),
      ),
      child: projects.isEmpty
          ? Text(
              'No projects registered',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                color: FiftyColors.slateGrey,
              ),
            )
          : Wrap(
              spacing: FiftySpacing.sm,
              runSpacing: FiftySpacing.sm,
              children: projects.map((proj) {
                final isActive = proj.status == 'active';
                return Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: FiftySpacing.sm,
                    vertical: FiftySpacing.xs,
                  ),
                  decoration: BoxDecoration(
                    color: isActive
                        ? FiftyColors.hunterGreen.withValues(alpha: 0.1)
                        : FiftyColors.cream.withValues(alpha: 0.03),
                    borderRadius: FiftyRadii.smRadius,
                    border: Border.all(
                      color: isActive
                          ? FiftyColors.hunterGreen.withValues(alpha: 0.2)
                          : FiftyColors.borderDark,
                      width: 1,
                    ),
                  ),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Row(
                        mainAxisSize: MainAxisSize.min,
                        children: [
                          Text(
                            proj.name.isNotEmpty ? proj.name : proj.slug,
                            style: GoogleFonts.manrope(
                              fontSize: FiftyTypography.labelSmall,
                              fontWeight: FiftyTypography.bold,
                              color: FiftyColors.cream,
                            ),
                          ),
                          const SizedBox(width: FiftySpacing.xs),
                          Container(
                            padding: const EdgeInsets.symmetric(
                              horizontal: 4,
                              vertical: 1,
                            ),
                            decoration: BoxDecoration(
                              color: isActive
                                  ? FiftyColors.hunterGreen.withValues(
                                      alpha: 0.2)
                                  : FiftyColors.slateGrey.withValues(
                                      alpha: 0.2),
                              borderRadius: FiftyRadii.smRadius,
                            ),
                            child: Text(
                              isActive ? 'ACTIVE' : 'INACTIVE',
                              style: GoogleFonts.manrope(
                                fontSize: 8,
                                fontWeight: FiftyTypography.semiBold,
                                color: isActive
                                    ? FiftyColors.hunterGreen
                                    : FiftyColors.slateGrey,
                              ),
                            ),
                          ),
                        ],
                      ),
                      if (proj.techStack != null &&
                          proj.techStack!.isNotEmpty)
                        Padding(
                          padding: const EdgeInsets.only(top: 2),
                          child: Text(
                            proj.techStack!,
                            style: GoogleFonts.manrope(
                              fontSize: FiftyTypography.labelSmall,
                              fontWeight: FiftyTypography.medium,
                              color: FiftyColors.slateGrey,
                            ),
                            maxLines: 1,
                            overflow: TextOverflow.ellipsis,
                          ),
                        ),
                    ],
                  ),
                );
              }).toList(),
            ),
    );
  }
}

// ---------------------------------------------------------------------------
// Briefs panel
// ---------------------------------------------------------------------------

class _BriefsPanel extends StatelessWidget {
  final List<BriefModel> briefs;
  final Map<String, int> statusCounts;

  const _BriefsPanel({
    required this.briefs,
    required this.statusCounts,
  });

  @override
  Widget build(BuildContext context) {
    return ArenaCard(
      title: 'BRIEFS',
      trailing: Text(
        '${briefs.length}',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.bold,
          color: FiftyColors.cream,
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
                return _StatusPill(
                  status: entry.key,
                  count: entry.value,
                );
              }).toList(),
            ),
          if (briefs.isEmpty)
            Padding(
              padding: const EdgeInsets.only(top: FiftySpacing.xs),
              child: Text(
                'No briefs found',
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.bodySmall,
                  color: FiftyColors.slateGrey,
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

class _StatusPill extends StatelessWidget {
  final String status;
  final int count;

  const _StatusPill({required this.status, required this.count});

  @override
  Widget build(BuildContext context) {
    final color = _statusColor(status);
    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: 2,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: color.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Text(
        '$status: $count',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.semiBold,
          color: color,
        ),
      ),
    );
  }

  Color _statusColor(String status) {
    switch (status) {
      case 'Ready':
        return FiftyColors.slateGrey;
      case 'In Progress':
        return FiftyColors.warning;
      case 'Done':
        return FiftyColors.hunterGreen;
      case 'Blocked':
        return FiftyColors.burgundy;
      case 'Draft':
        return FiftyColors.cream.withValues(alpha: 0.5);
      default:
        return FiftyColors.slateGrey;
    }
  }
}

class _BriefRow extends StatelessWidget {
  final BriefModel brief;

  const _BriefRow({required this.brief});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Project
          SizedBox(
            width: 64,
            child: Text(
              brief.project,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.slateGrey,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // Brief ID
          SizedBox(
            width: 72,
            child: Text(
              brief.briefId,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: FiftyColors.cream.withValues(alpha: 0.7),
              ),
            ),
          ),
          // Title
          Expanded(
            child: Text(
              brief.title,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.5),
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
          ),
          // Priority
          SizedBox(
            width: 28,
            child: Text(
              brief.priority,
              textAlign: TextAlign.right,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.semiBold,
                color: _priorityColor(brief.priority),
              ),
            ),
          ),
        ],
      ),
    );
  }

  Color _priorityColor(String priority) {
    switch (priority) {
      case 'P0':
        return FiftyColors.burgundy;
      case 'P1':
        return FiftyColors.warning;
      case 'P2':
        return FiftyColors.slateGrey;
      default:
        return FiftyColors.cream.withValues(alpha: 0.4);
    }
  }
}

// ---------------------------------------------------------------------------
// Sessions panel
// ---------------------------------------------------------------------------

class _SessionsPanel extends StatelessWidget {
  final List<SessionModel> sessions;

  const _SessionsPanel({required this.sessions});

  @override
  Widget build(BuildContext context) {
    return ArenaCard(
      title: 'RECENT SESSIONS',
      trailing: Text(
        '${sessions.length}',
        style: GoogleFonts.manrope(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FiftyTypography.bold,
          color: FiftyColors.cream,
        ),
      ),
      child: sessions.isEmpty
          ? Text(
              'No recent sessions',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.bodySmall,
                color: FiftyColors.slateGrey,
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

class _SessionRow extends StatelessWidget {
  final SessionModel session;

  const _SessionRow({required this.session});

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: FiftySpacing.xs),
      child: Row(
        children: [
          // Time
          Text(
            FormatUtils.timeAgo(session.createdAt),
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.medium,
              color: FiftyColors.cream.withValues(alpha: 0.3),
            ),
          ),
          const SizedBox(width: FiftySpacing.sm),
          // Project
          Text(
            session.project,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.bold,
              color: FiftyColors.cream.withValues(alpha: 0.7),
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
                color: FiftyColors.burgundy.withValues(alpha: 0.15),
                borderRadius: FiftyRadii.smRadius,
              ),
              child: Text(
                session.briefId!,
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.semiBold,
                  color: FiftyColors.burgundy,
                ),
              ),
            ),
          ],
          if (session.mode != null) ...[
            const SizedBox(width: FiftySpacing.xs),
            Text(
              session.mode!,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.slateGrey,
              ),
            ),
          ],
          if (session.summary != null) ...[
            const SizedBox(width: FiftySpacing.sm),
            Expanded(
              child: Text(
                session.summary!,
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: FiftyColors.cream.withValues(alpha: 0.4),
                ),
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ] else
            const Spacer(),
        ],
      ),
    );
  }
}
