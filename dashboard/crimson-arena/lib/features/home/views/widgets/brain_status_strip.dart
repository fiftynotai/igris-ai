import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../core/constants/arena_breakpoints.dart';
import '../../../../core/constants/arena_sizes.dart';
import '../../../../data/models/sync_status_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/home_view_model.dart';

/// Compact brain + sync status strip on the HOME page.
///
/// Replaces the separate BrainHealthCard and SyncPanel with a single
/// horizontal strip that mirrors the InstrumentStrip visual pattern.
/// Shows brain health stats (status, version, db size, uptime, records)
/// and sync pipeline stats (status, last push, last pull, queue depth).
class BrainStatusStrip extends StatelessWidget {
  const BrainStatusStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(
          color: colorScheme.outline,
          width: 1,
        ),
      ),
      child: Obx(() {
        final vm = Get.find<HomeViewModel>();

        // Brain data
        final health = vm.brainHealth.value;
        final available = vm.brainAvailable.value;

        final version = health?['version'] as String? ??
            health?['brain_version'] as String? ??
            '--';
        final dbSizeBytes = health?['db_size_bytes'] as int?;
        final dbSize = dbSizeBytes != null
            ? FormatUtils.formatBytes(dbSizeBytes)
            : (health?['db_size'] as String? ?? '--');
        final uptimeSeconds = health?['uptime_seconds'] as int?;
        final uptime = uptimeSeconds != null
            ? FormatUtils.formatUptime(uptimeSeconds)
            : (health?['uptime'] as String? ?? '--');

        int totalRecords = 0;
        final counts = health?['counts'] as Map<String, dynamic>?;
        if (counts != null) {
          for (final v in counts.values) {
            totalRecords += (v as num?)?.toInt() ?? 0;
          }
        } else {
          totalRecords = health?['total_records'] as int? ?? 0;
        }

        // Sync data
        final sync = vm.syncStatus.value;
        final syncOnline = sync?.isOnline ?? false;
        final pushAgo = FormatUtils.timeAgo(sync?.lastPush);
        final pullAgo = FormatUtils.timeAgo(sync?.lastPull);
        final queueDepth = sync?.queueDepth ?? 0;

        final brainStats = [
          _StatusStat(label: 'BRAIN', isOnline: available),
          _MiniStat(label: 'VER', value: version),
          _MiniStat(label: 'DB', value: dbSize),
          _MiniStat(label: 'UP', value: uptime),
          _MiniStat(
            label: 'REC',
            value: FormatUtils.formatNumber(totalRecords),
          ),
        ];

        final syncStats = [
          _StatusStat(label: 'SYNC', isOnline: syncOnline),
          _MiniStat(label: 'PUSH', value: pushAgo),
          _MiniStat(label: 'PULL', value: pullAgo),
          _QueueStat(label: 'QUEUE', depth: queueDepth),
        ];

        return LayoutBuilder(
          builder: (context, constraints) {
            final isNarrow =
                constraints.maxWidth < ArenaBreakpoints.narrow;

            if (isNarrow) {
              return Column(
                children: [
                  _buildStatRow(context, brainStats),
                  const SizedBox(height: FiftySpacing.xs),
                  _buildStatRow(context, syncStats),
                ],
              );
            }

            return Row(
              children: [
                // Brain group
                ...brainStats.expand((stat) sync* {
                  final index = brainStats.indexOf(stat);
                  if (index > 0) {
                    yield _divider(context);
                  }
                  yield Expanded(child: stat);
                }),
                // Wider gap between brain and sync groups
                _groupDivider(context),
                // Sync group
                ...syncStats.expand((stat) sync* {
                  final index = syncStats.indexOf(stat);
                  if (index > 0) {
                    yield _divider(context);
                  }
                  yield Expanded(child: stat);
                }),
              ],
            );
          },
        );
      }),
    );
  }

  Widget _buildStatRow(BuildContext context, List<Widget> stats) {
    return Row(
      children: stats.expand((stat) sync* {
        final index = stats.indexOf(stat);
        if (index > 0) {
          yield _divider(context);
        }
        yield Expanded(child: stat);
      }).toList(),
    );
  }

  Widget _divider(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      width: 1,
      height: ArenaSizes.instrumentDividerHeight,
      margin: const EdgeInsets.symmetric(horizontal: FiftySpacing.sm),
      color: colorScheme.outline,
    );
  }

  Widget _groupDivider(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return Container(
      width: 1,
      height: ArenaSizes.instrumentDividerHeight,
      margin: const EdgeInsets.symmetric(horizontal: FiftySpacing.md),
      color: colorScheme.outline,
    );
  }
}

class _StatusStat extends StatelessWidget {
  final String label;
  final bool isOnline;

  const _StatusStat({required this.label, required this.isOnline});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final ext = theme.extension<FiftyThemeExtension>()!;

    final dotColor =
        isOnline ? ext.success : colorScheme.onSurfaceVariant;
    final valueText = isOnline ? 'ONLINE' : 'OFFLINE';

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: ArenaSizes.statusDotDefault,
              height: ArenaSizes.statusDotDefault,
              decoration: BoxDecoration(
                color: dotColor,
                shape: BoxShape.circle,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
            Text(
              valueText,
              style: textTheme.labelMedium!.copyWith(
                color: dotColor,
              ),
            ),
          ],
        ),
      ],
    );
  }
}

class _MiniStat extends StatelessWidget {
  final String label;
  final String value;

  const _MiniStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          value,
          style: textTheme.labelMedium!.copyWith(
            color: colorScheme.onSurface,
          ),
        ),
      ],
    );
  }
}

class _QueueStat extends StatelessWidget {
  final String label;
  final int depth;

  const _QueueStat({required this.label, required this.depth});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final ext = theme.extension<FiftyThemeExtension>()!;

    final Color valueColor;
    if (depth == 0) {
      valueColor = ext.success;
    } else if (depth <= 10) {
      valueColor = ext.warning;
    } else {
      valueColor = colorScheme.primary;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: textTheme.labelSmall!.copyWith(
            color: colorScheme.onSurfaceVariant,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        Text(
          depth.toString(),
          style: textTheme.labelMedium!.copyWith(
            color: valueColor,
          ),
        ),
      ],
    );
  }
}
