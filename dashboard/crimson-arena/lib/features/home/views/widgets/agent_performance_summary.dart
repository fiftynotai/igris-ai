import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/agent_model.dart';
import '../../../../shared/utils/format_utils.dart';
import '../../../../shared/widgets/arena_card.dart';
import '../../controllers/home_view_model.dart';

/// Agent Performance Summary.
///
/// Grid of agent cards showing key performance metrics: success rate,
/// average token consumption, average duration, and efficiency grade
/// (S/A/B/C/F).
class AgentPerformanceSummary extends StatelessWidget {
  const AgentPerformanceSummary({super.key});

  @override
  Widget build(BuildContext context) {
    final vm = Get.find<HomeViewModel>();

    return Obx(() {
      final agentsMap = vm.agents;
      final agentList = AgentConstants.agentOrder
          .where((name) => agentsMap.containsKey(name))
          .map((name) => agentsMap[name]!)
          .where((agent) => agent.invocations > 0)
          .toList();

      if (agentList.isEmpty) {
        return ArenaCard(
          title: 'AGENT PERFORMANCE',
          child: Text(
            '> No agent data available',
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.bodySmall,
              color: FiftyColors.slateGrey,
            ),
          ),
        );
      }

      return ArenaCard(
        title: 'AGENT PERFORMANCE',
        trailing: Text(
          '${agentList.length} active',
          style: GoogleFonts.manrope(
            fontSize: FiftyTypography.labelSmall,
            fontWeight: FiftyTypography.medium,
            color: FiftyColors.slateGrey,
          ),
        ),
        child: Wrap(
          spacing: FiftySpacing.sm,
          runSpacing: FiftySpacing.sm,
          children: agentList.map((agent) {
            return _AgentPerfCard(agent: agent);
          }).toList(),
        ),
      );
    });
  }
}

/// A single agent performance card.
class _AgentPerfCard extends StatelessWidget {
  final AgentModel agent;

  const _AgentPerfCard({required this.agent});

  @override
  Widget build(BuildContext context) {
    final color = Color(
      AgentConstants.agentColors[agent.name] ?? 0xFF888888,
    );
    final displayName = AgentConstants.agentNames[agent.name] ??
        agent.name.toUpperCase();
    final successPct = (agent.successRate * 100).clamp(0.0, 100.0);
    final grade = _efficiencyGrade(successPct);
    final gradeColor = _gradeColor(grade);
    final avgTokens = agent.invocations > 0
        ? agent.totalTokens ~/ agent.invocations
        : 0;

    return Container(
      width: 160,
      padding: const EdgeInsets.all(FiftySpacing.sm),
      decoration: BoxDecoration(
        color: FiftyColors.darkBurgundy,
        borderRadius: FiftyRadii.mdRadius,
        border: Border.all(
          color: color.withValues(alpha: 0.2),
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        mainAxisSize: MainAxisSize.min,
        children: [
          // Header: name + grade
          Row(
            mainAxisAlignment: MainAxisAlignment.spaceBetween,
            children: [
              Expanded(
                child: Text(
                  displayName,
                  style: GoogleFonts.manrope(
                    fontSize: FiftyTypography.labelSmall,
                    fontWeight: FiftyTypography.bold,
                    color: color,
                    letterSpacing: FiftyTypography.letterSpacingLabel,
                  ),
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
              Container(
                width: 24,
                height: 24,
                decoration: BoxDecoration(
                  color: gradeColor.withValues(alpha: 0.15),
                  borderRadius: FiftyRadii.smRadius,
                  border: Border.all(
                    color: gradeColor.withValues(alpha: 0.3),
                    width: 1,
                  ),
                ),
                child: Center(
                  child: Text(
                    grade,
                    style: GoogleFonts.manrope(
                      fontSize: FiftyTypography.labelMedium,
                      fontWeight: FiftyTypography.extraBold,
                      color: gradeColor,
                    ),
                  ),
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Success rate bar
          _MetricRow(
            label: 'Success',
            value: '${successPct.toStringAsFixed(0)}%',
            progress: successPct / 100,
            color: _successColor(successPct),
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Avg tokens
          _MetricRow(
            label: 'Avg Tok',
            value: FormatUtils.formatTokens(avgTokens),
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Avg duration
          _MetricRow(
            label: 'Avg Dur',
            value: FormatUtils.formatDuration(agent.avgDurationSeconds),
          ),
          const SizedBox(height: FiftySpacing.xs),

          // Invocations
          _MetricRow(
            label: 'Runs',
            value: FormatUtils.formatNumber(agent.invocations),
          ),
        ],
      ),
    );
  }

  String _efficiencyGrade(double successPct) {
    if (successPct > 95) return 'S';
    if (successPct > 90) return 'A';
    if (successPct > 80) return 'B';
    if (successPct > 60) return 'C';
    return 'F';
  }

  Color _gradeColor(String grade) {
    switch (grade) {
      case 'S':
        return FiftyColors.hunterGreen;
      case 'A':
        return FiftyColors.hunterGreen;
      case 'B':
        return FiftyColors.slateGrey;
      case 'C':
        return FiftyColors.warning;
      case 'F':
        return FiftyColors.burgundy;
      default:
        return FiftyColors.slateGrey;
    }
  }

  Color _successColor(double pct) {
    if (pct > 90) return FiftyColors.hunterGreen;
    if (pct > 70) return FiftyColors.warning;
    return FiftyColors.burgundy;
  }
}

/// A compact metric row with label, value, and optional progress bar.
class _MetricRow extends StatelessWidget {
  final String label;
  final String value;
  final double? progress;
  final Color? color;

  const _MetricRow({
    required this.label,
    required this.value,
    this.progress,
    this.color,
  });

  @override
  Widget build(BuildContext context) {
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Row(
          mainAxisAlignment: MainAxisAlignment.spaceBetween,
          children: [
            Text(
              label,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.cream.withValues(alpha: 0.4),
              ),
            ),
            Text(
              value,
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: color ?? FiftyColors.cream.withValues(alpha: 0.7),
              ),
            ),
          ],
        ),
        if (progress != null) ...[
          const SizedBox(height: 2),
          SizedBox(
            height: 3,
            child: ClipRRect(
              borderRadius: FiftyRadii.smRadius,
              child: LinearProgressIndicator(
                value: progress!.clamp(0, 1),
                backgroundColor: FiftyColors.cream.withValues(alpha: 0.05),
                valueColor: AlwaysStoppedAnimation<Color>(
                  color ?? FiftyColors.cream,
                ),
              ),
            ),
          ),
        ],
      ],
    );
  }
}
