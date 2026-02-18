import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../data/models/budget_model.dart';
import '../../../../data/models/context_window_model.dart';
import '../../../../data/models/sync_status_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../controllers/home_view_model.dart';

/// Compact instrument strip at the top of the HOME page.
///
/// Displays three compact gauges side-by-side:
/// - HP (token budget usage)
/// - CTX (context window usage)
/// - SYNC (sync pipeline status)
///
/// Each gauge shows a label, percentage, and mini progress bar.
class InstrumentStrip extends StatelessWidget {
  const InstrumentStrip({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.md,
        vertical: FiftySpacing.sm,
      ),
      decoration: BoxDecoration(
        color: FiftyColors.surfaceDark,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(
          color: FiftyColors.borderDark,
          width: 1,
        ),
      ),
      child: Obx(() {
        return Row(
          children: [
            // HP gauge
            Expanded(
              child: _buildBudgetGauge(vm),
            ),
            _divider(),
            // CTX gauge
            Expanded(
              child: _buildContextGauge(vm),
            ),
            _divider(),
            // SYNC gauge
            Expanded(
              child: _buildSyncGauge(vm),
            ),
            _divider(),
            // Overall stats
            Expanded(
              child: _buildOverallStats(vm),
            ),
          ],
        );
      }),
    );
  }

  Widget _divider() {
    return Container(
      width: 1,
      height: 32,
      margin: const EdgeInsets.symmetric(horizontal: FiftySpacing.sm),
      color: FiftyColors.borderDark,
    );
  }

  Widget _buildBudgetGauge(HomeViewModel vm) {
    final budget = vm.budget.value;
    if (budget == null) {
      return _Gauge(label: 'HP', value: '--', color: FiftyColors.slateGrey);
    }
    final pct = budget.percentage;
    final color = _hpColor(budget.ratio);
    return _Gauge(
      label: 'HP',
      value: '${pct.toStringAsFixed(0)}%',
      color: color,
      progress: pct / 100,
    );
  }

  Widget _buildContextGauge(HomeViewModel vm) {
    final ctx = vm.contextWindow.value;
    if (ctx == null) {
      return _Gauge(label: 'CTX', value: '--', color: FiftyColors.slateGrey);
    }
    final pct = ctx.usagePercent;
    final color = _ctxColor(ctx.usageRatio);
    return _Gauge(
      label: 'CTX',
      value: '${pct.toStringAsFixed(0)}%',
      color: color,
      progress: pct / 100,
    );
  }

  Widget _buildSyncGauge(HomeViewModel vm) {
    final sync = vm.syncStatus.value;
    if (sync == null) {
      return _Gauge(label: 'SYNC', value: '--', color: FiftyColors.slateGrey);
    }
    final isOnline = sync.isOnline;
    return _Gauge(
      label: 'SYNC',
      value: isOnline ? 'ONLINE' : 'OFFLINE',
      color: isOnline ? FiftyColors.hunterGreen : FiftyColors.burgundy,
    );
  }

  Widget _buildOverallStats(HomeViewModel vm) {
    final invocations = vm.totalInvocations.value;
    final cost = vm.totalCost.value;
    return Row(
      mainAxisAlignment: MainAxisAlignment.spaceEvenly,
      children: [
        _MiniStat(
          label: 'RUNS',
          value: FormatUtils.formatNumber(invocations),
        ),
        _MiniStat(
          label: 'COST',
          value: FormatUtils.formatCost(cost),
        ),
      ],
    );
  }

  Color _hpColor(double ratio) {
    if (ratio >= 0.90) return FiftyColors.burgundy;
    if (ratio >= 0.75) return FiftyColors.warning;
    return FiftyColors.hunterGreen;
  }

  Color _ctxColor(double ratio) {
    if (ratio >= 0.90) return FiftyColors.burgundy;
    if (ratio >= 0.80) return FiftyColors.warning;
    return FiftyColors.slateGrey;
  }
}

/// A compact gauge showing label, value, and optional progress bar.
class _Gauge extends StatelessWidget {
  final String label;
  final String value;
  final Color color;
  final double? progress;

  const _Gauge({
    required this.label,
    required this.value,
    required this.color,
    this.progress,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.center,
      children: [
        Row(
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
            const SizedBox(width: FiftySpacing.sm),
            Text(
              value,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelMedium,
                fontWeight: FiftyTypography.bold,
                color: color,
              ),
            ),
          ],
        ),
        if (progress != null) ...[
          const SizedBox(height: FiftySpacing.xs),
          SizedBox(
            width: 80,
            height: 3,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: progress!.clamp(0, 1),
                backgroundColor: FiftyColors.cream.withValues(alpha: 0.05),
                valueColor: AlwaysStoppedAnimation<Color>(color),
              ),
            ),
          ),
        ],
      ],
    );
  }
}

/// A tiny stat with label and value for the overall stats section.
class _MiniStat extends StatelessWidget {
  final String label;
  final String value;

  const _MiniStat({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    return Column(
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
        Text(
          value,
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelMedium,
            fontWeight: FiftyTypography.bold,
            color: FiftyColors.cream,
          ),
        ),
      ],
    );
  }
}
