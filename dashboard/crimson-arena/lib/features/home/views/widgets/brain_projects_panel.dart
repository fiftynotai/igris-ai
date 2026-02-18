import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../data/models/project_model.dart';
import '../../../../shared/widgets/arena_card.dart';

/// Projects panel for the Brain Command Center.
///
/// Displays registered brain projects as a wrapped grid of compact cards.
/// Each card shows the project name, tech stack, and active/inactive status.
class BrainProjectsPanel extends StatelessWidget {
  /// The list of projects to display.
  final List<ProjectModel> projects;

  const BrainProjectsPanel({super.key, required this.projects});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;

    return ArenaCard(
      title: 'PROJECTS',
      trailing: Text(
        '${projects.length}',
        style: textTheme.labelSmall!.copyWith(
          fontWeight: FiftyTypography.bold,
          color: colorScheme.onSurface,
        ),
      ),
      child: projects.isEmpty
          ? Text(
              'No projects registered',
              style: textTheme.bodySmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
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
                        ? ext.success.withValues(alpha: 0.1)
                        : colorScheme.onSurface.withValues(alpha: 0.03),
                    borderRadius: FiftyRadii.smRadius,
                    border: Border.all(
                      color: isActive
                          ? ext.success.withValues(alpha: 0.2)
                          : colorScheme.outline,
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
                          Flexible(
                            child: Tooltip(
                              message: proj.name.isNotEmpty ? proj.name : proj.slug,
                              child: Text(
                                proj.name.isNotEmpty ? proj.name : proj.slug,
                                style: textTheme.labelSmall!.copyWith(
                                  fontWeight: FiftyTypography.bold,
                                  color: colorScheme.onSurface,
                                ),
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                              ),
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
                                  ? ext.success.withValues(alpha: 0.2)
                                  : colorScheme.onSurfaceVariant.withValues(alpha: 0.2),
                              borderRadius: FiftyRadii.smRadius,
                            ),
                            child: Text(
                              isActive ? 'ACTIVE' : 'INACTIVE',
                              style: textTheme.labelSmall!.copyWith(
                                fontSize: 11,
                                color: isActive
                                    ? ext.success
                                    : colorScheme.onSurfaceVariant,
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
                            style: textTheme.labelSmall!.copyWith(
                              fontWeight: FiftyTypography.medium,
                              color: colorScheme.onSurfaceVariant,
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
