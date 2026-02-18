import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

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
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final health = vm.brainHealth.value;
      final available = vm.brainAvailable.value;

      return ArenaCard(
        title: 'BRAIN STATUS',
        trailing: _ConnectionBadge(isOnline: available),
        child: available && health != null
            ? _BrainStats(health: health)
            : Text(
                '> BRAIN OFFLINE',
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.bodySmall,
                  color: FiftyColors.slateGrey,
                ),
              ),
      );
    });
  }
}

/// Connection status badge with dot indicator.
class _ConnectionBadge extends StatelessWidget {
  final bool isOnline;

  const _ConnectionBadge({required this.isOnline});

  @override
  Widget build(BuildContext context) {
    final color = isOnline ? FiftyColors.hunterGreen : FiftyColors.burgundy;
    final label = isOnline ? 'ONLINE' : 'OFFLINE';

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: FiftySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.15),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: color.withValues(alpha: 0.3),
          width: 1,
        ),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 6,
            height: 6,
            decoration: BoxDecoration(
              shape: BoxShape.circle,
              color: color,
            ),
          ),
          const SizedBox(width: FiftySpacing.xs),
          Text(
            label,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelSmall,
              fontWeight: FiftyTypography.semiBold,
              color: color,
              letterSpacing: FiftyTypography.letterSpacingLabel,
            ),
          ),
        ],
      ),
    );
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

    return Wrap(
      spacing: FiftySpacing.lg,
      runSpacing: FiftySpacing.sm,
      children: [
        _StatItem(label: 'VERSION', value: version),
        _StatItem(label: 'DB SIZE', value: dbSize),
        _StatItem(label: 'UPTIME', value: uptime),
        _StatItem(
          label: 'RECORDS',
          value: FormatUtils.formatNumber(totalRecords),
        ),
      ],
    );
  }
}

/// A single stat item with label and value.
class _StatItem extends StatelessWidget {
  final String label;
  final String value;

  const _StatItem({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          label,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.semiBold,
            color: FiftyColors.slateGrey,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
        const SizedBox(height: 2),
        Text(
          value,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.bodyMedium,
            fontWeight: FiftyTypography.bold,
            color: FiftyColors.cream,
          ),
        ),
      ],
    );
  }
}
