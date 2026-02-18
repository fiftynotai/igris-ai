import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';

import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Brain Health card.
///
/// Shows brain connection status (ONLINE/OFFLINE with dot indicator),
/// and brain stats: version, db size, uptime, total records.
class BrainHealthCard extends StatelessWidget {
  const BrainHealthCard({super.key});

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final health = vm.brainHealth.value;
      final available = vm.brainAvailable.value;

      return ArenaCard(
        title: 'BRAIN STATUS',
        trailing: FiftyBadge(
          label: available ? 'ONLINE' : 'OFFLINE',
          variant: available
              ? FiftyBadgeVariant.success
              : FiftyBadgeVariant.error,
          showGlow: available,
        ),
        child: available && health != null
            ? _BrainStats(health: health)
            : Text(
                'Brain offline',
                style: textTheme.bodySmall!.copyWith(
                  color: colorScheme.onSurfaceVariant,
                ),
              ),
      );
    });
  }
}

/// Brain stats grid showing version, db size, uptime, records.
class _BrainStats extends StatelessWidget {
  final Map<String, dynamic> health;

  const _BrainStats({required this.health});

  @override
  Widget build(BuildContext context) {
    final version = health['version'] as String? ??
        health['brain_version'] as String? ??
        '--';
    final dbSizeBytes = health['db_size_bytes'] as int?;
    final dbSize = dbSizeBytes != null
        ? FormatUtils.formatBytes(dbSizeBytes)
        : (health['db_size'] as String? ?? '--');
    final uptimeSeconds = health['uptime_seconds'] as int?;
    final uptime = uptimeSeconds != null
        ? FormatUtils.formatUptime(uptimeSeconds)
        : (health['uptime'] as String? ?? '--');

    // Total records from counts map
    int totalRecords = 0;
    final counts = health['counts'] as Map<String, dynamic>?;
    if (counts != null) {
      for (final v in counts.values) {
        totalRecords += (v as num?)?.toInt() ?? 0;
      }
    } else {
      totalRecords = health['total_records'] as int? ?? 0;
    }

    return FiftyDataSlate(
      data: {
        'Version': version,
        'DB Size': dbSize,
        'Uptime': uptime,
        'Records': FormatUtils.formatNumber(totalRecords),
      },
      showBorder: false,
      showGlow: false,
    );
  }
}
