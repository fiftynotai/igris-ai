import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/execution_log_entry.dart';

/// Scrollable timestamped execution log for a specific instance.
///
/// Entries are color-coded by agent and formatted according to event type:
/// - start: `AGENT started PHASE...`
/// - stop: `AGENT complete (45s, 12.4K tokens)`
/// - error: `AGENT FAILED (reason)`
/// - retry: `AGENT retry #N`
///
/// New entries slide in from the right. Displays a retry counter at the bottom.
class ExecutionLogWidget extends StatelessWidget {
  final String instanceId;
  final List<ExecutionLogEntry> entries;
  final int retryCount;

  const ExecutionLogWidget({
    super.key,
    required this.instanceId,
    required this.entries,
    this.retryCount = 0,
  });

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.all(FiftySpacing.md),
      decoration: BoxDecoration(
        color: FiftyColors.darkBurgundy.withValues(alpha: 0.5),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: FiftyColors.borderDark,
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Section header
          Row(
            children: [
              Text(
                'EXECUTION LOG',
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.labelMedium,
                  fontWeight: FiftyTypography.bold,
                  color: FiftyColors.slateGrey,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              const Spacer(),
              Text(
                'Retries: $retryCount/3',
                style: GoogleFonts.sourceCodePro(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: retryCount > 0
                      ? FiftyColors.warning
                      : FiftyColors.slateGrey,
                ),
              ),
            ],
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Log entries
          if (entries.isEmpty)
            Padding(
              padding: const EdgeInsets.symmetric(vertical: FiftySpacing.md),
              child: Text(
                'No execution data available',
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.bodySmall,
                  fontWeight: FiftyTypography.medium,
                  color: FiftyColors.slateGrey.withValues(alpha: 0.5),
                ),
              ),
            )
          else
            ConstrainedBox(
              constraints: const BoxConstraints(maxHeight: 200),
              child: ListView.builder(
                shrinkWrap: true,
                itemCount: entries.length,
                itemBuilder: (context, index) {
                  return _ExecutionLogLine(
                    entry: entries[index],
                    index: index,
                  );
                },
              ),
            ),
        ],
      ),
    );
  }
}

/// A single execution log line with slide-in animation.
class _ExecutionLogLine extends StatefulWidget {
  final ExecutionLogEntry entry;
  final int index;

  const _ExecutionLogLine({
    required this.entry,
    required this.index,
  });

  @override
  State<_ExecutionLogLine> createState() => _ExecutionLogLineState();
}

class _ExecutionLogLineState extends State<_ExecutionLogLine>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<Offset> _slideAnimation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: FiftyMotion.compiling,
    );
    _slideAnimation = Tween<Offset>(
      begin: const Offset(0.3, 0),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _controller,
      curve: FiftyMotion.enter,
    ));
    _controller.forward();
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final entry = widget.entry;
    final agentColor = Color(
      AgentConstants.agentColors[entry.agent] ?? 0xFF888888,
    );
    final timestamp = _formatTimestamp(entry.createdAt);
    final message = _formatMessage(entry);

    return SlideTransition(
      position: _slideAnimation,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 1),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            // Timestamp
            Text(
              '[$timestamp]',
              style: GoogleFonts.sourceCodePro(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.medium,
                color: FiftyColors.slateGrey,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),

            // Agent name
            Text(
              entry.agent.toUpperCase(),
              style: GoogleFonts.sourceCodePro(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.bold,
                color: agentColor,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),

            // Event message
            Expanded(
              child: Text(
                message,
                style: GoogleFonts.sourceCodePro(
                  fontSize: FiftyTypography.labelSmall,
                  fontWeight: FiftyTypography.medium,
                  color: _eventColor(entry.eventType),
                ),
                overflow: TextOverflow.ellipsis,
              ),
            ),
          ],
        ),
      ),
    );
  }

  String _formatTimestamp(String? timestamp) {
    if (timestamp == null || timestamp.isEmpty) return '--:--:--';
    final dt = DateTime.tryParse(timestamp);
    if (dt == null) return timestamp;
    final local = dt.toLocal();
    return '${local.hour.toString().padLeft(2, '0')}:'
        '${local.minute.toString().padLeft(2, '0')}:'
        '${local.second.toString().padLeft(2, '0')}';
  }

  String _formatMessage(ExecutionLogEntry entry) {
    final brief = entry.briefId ?? '';
    final phase = entry.phase ?? '';
    final duration = entry.formattedDuration;
    final tokens = _formatTokens(entry.inputTokens + entry.outputTokens);

    switch (entry.eventType) {
      case 'start':
        final parts = <String>['started'];
        if (phase.isNotEmpty) parts.add(phase);
        if (brief.isNotEmpty) parts.add(brief);
        return parts.join(' ');
      case 'stop':
        return 'complete ($duration, $tokens tokens)';
      case 'error':
        final reason = entry.errorMessage ?? 'unknown error';
        return 'FAILED ($reason)';
      case 'retry':
        return 'retry attempt';
      default:
        return entry.eventType;
    }
  }

  Color _eventColor(String eventType) {
    switch (eventType) {
      case 'start':
        return FiftyColors.cream.withValues(alpha: 0.7);
      case 'stop':
        return FiftyColors.hunterGreen;
      case 'error':
        return FiftyColors.burgundy;
      case 'retry':
        return FiftyColors.warning;
      default:
        return FiftyColors.slateGrey;
    }
  }

  String _formatTokens(int tokens) {
    if (tokens < 1000) return '$tokens';
    if (tokens < 1000000) return '${(tokens / 1000).toStringAsFixed(1)}K';
    return '${(tokens / 1000000).toStringAsFixed(1)}M';
  }
}
