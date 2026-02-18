import 'package:crimson_arena/core/theme/arena_text_styles.dart';
import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/agent_nexus_entry.dart';

/// Displays a 7-column agent status table for a specific instance.
///
/// Columns: ARCHITECT, FORGER, SENTINEL, WARDEN, MENDER, SEEKER, SAGE
/// Rows: Status, Time, Tokens
///
/// Working agents display a pulsing animation. Status values are
/// color-coded: IDLE (gray), WORKING (warning/yellow), DONE (green), FAIL (red).
class AgentNexusTable extends StatelessWidget {
  final String instanceId;
  final List<AgentNexusEntry> nexusData;

  const AgentNexusTable({
    super.key,
    required this.instanceId,
    required this.nexusData,
  });

  /// Agent keys to display (excluding orchestrator).
  static const _agents = [
    'architect',
    'forger',
    'sentinel',
    'warden',
    'mender',
    'seeker',
    'sage',
  ];

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      padding: const EdgeInsets.all(FiftySpacing.md),
      decoration: BoxDecoration(
        color: colorScheme.surface.withValues(alpha: 0.5),
        borderRadius: FiftyRadii.smRadius,
        border: Border.all(
          color: colorScheme.outline,
          width: 1,
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          // Section title
          Text(
            'AGENT NEXUS',
            style: textTheme.labelMedium!.copyWith(
              color: colorScheme.onSurfaceVariant,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
          const SizedBox(height: FiftySpacing.sm),

          // Agent header row (monograms)
          _buildHeaderRow(context),
          const SizedBox(height: FiftySpacing.xs),

          // Status row
          _buildDataRow(context, 'STATUS', _getStatusValues(context)),

          // Time row
          _buildDataRow(context, 'TIME', _getTimeValues(context)),

          // Tokens row
          _buildDataRow(context, 'TOKENS', _getTokenValues(context)),
        ],
      ),
    );
  }

  Widget _buildHeaderRow(BuildContext context) {
    final textTheme = Theme.of(context).textTheme;

    return Row(
      children: [
        // Row label spacer
        SizedBox(
          width: 56,
          child: Text(
            '',
            style: textTheme.labelSmall,
          ),
        ),
        // Agent monogram headers
        for (final agent in _agents)
          Expanded(
            child: Center(
              child: _AgentMonogramCell(
                agent: agent,
                isWorking: _entryFor(agent)?.status == 'WORKING',
              ),
            ),
          ),
      ],
    );
  }

  Widget _buildDataRow(
      BuildContext context, String label, List<_CellData> values) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Row(
        children: [
          // Row label
          SizedBox(
            width: 56,
            child: Text(
              label,
              style: textTheme.labelSmall!.copyWith(
                color: colorScheme.onSurfaceVariant,
                letterSpacing: FiftyTypography.letterSpacingLabel,
              ),
            ),
          ),
          // Data cells
          for (final cell in values)
            Expanded(
              child: Center(
                child: cell.isFail
                    ? GlitchEffect(
                        triggerOnMount: true,
                        intensity: 0.5,
                        offset: 2.0,
                        duration: const Duration(milliseconds: 500),
                        child: Text(
                          cell.text,
                          style: ArenaTextStyles.mono(
                            context,
                            fontSize: FiftyTypography.labelSmall,
                            fontWeight: FiftyTypography.medium,
                            color: cell.color,
                          ),
                        ),
                      )
                    : Text(
                        cell.text,
                        style: ArenaTextStyles.mono(
                          context,
                          fontSize: FiftyTypography.labelSmall,
                          fontWeight: FiftyTypography.medium,
                          color: cell.color,
                        ),
                      ),
              ),
            ),
        ],
      ),
    );
  }

  AgentNexusEntry? _entryFor(String agent) {
    for (final entry in nexusData) {
      if (entry.agent == agent) return entry;
    }
    return null;
  }

  List<_CellData> _getStatusValues(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;

    return _agents.map((agent) {
      final entry = _entryFor(agent);
      final status = entry?.status ?? 'IDLE';
      return _CellData(
        text: status,
        color: _statusColor(status, colorScheme, ext),
        isFail: status.toUpperCase() == 'FAIL',
      );
    }).toList();
  }

  List<_CellData> _getTimeValues(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return _agents.map((agent) {
      final entry = _entryFor(agent);
      if (entry == null) return _CellData(text: '--', color: colorScheme.onSurfaceVariant);
      return _CellData(
        text: entry.formattedDuration,
        color: colorScheme.onSurface.withValues(alpha: 0.7),
      );
    }).toList();
  }

  List<_CellData> _getTokenValues(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;

    return _agents.map((agent) {
      final entry = _entryFor(agent);
      if (entry == null) return _CellData(text: '0', color: colorScheme.onSurfaceVariant);
      return _CellData(
        text: _formatTokens(entry.totalTokens),
        color: colorScheme.onSurface.withValues(alpha: 0.7),
      );
    }).toList();
  }

  Color _statusColor(String status, ColorScheme colorScheme, FiftyThemeExtension ext) {
    switch (status.toUpperCase()) {
      case 'WORKING':
        return ext.warning;
      case 'DONE':
        return ext.success;
      case 'FAIL':
        return colorScheme.primary;
      default:
        return colorScheme.onSurfaceVariant;
    }
  }

  String _formatTokens(int tokens) {
    if (tokens == 0) return '0';
    if (tokens < 1000) return '$tokens';
    if (tokens < 1000000) return '${(tokens / 1000).toStringAsFixed(1)}K';
    return '${(tokens / 1000000).toStringAsFixed(1)}M';
  }
}

/// Data for a single table cell.
class _CellData {
  final String text;
  final Color color;

  /// Whether this cell represents a failure state (triggers glitch effect).
  final bool isFail;

  const _CellData({
    required this.text,
    required this.color,
    this.isFail = false,
  });
}

/// Agent monogram cell with optional pulsing animation for WORKING state.
class _AgentMonogramCell extends StatefulWidget {
  final String agent;
  final bool isWorking;

  const _AgentMonogramCell({
    required this.agent,
    required this.isWorking,
  });

  @override
  State<_AgentMonogramCell> createState() => _AgentMonogramCellState();
}

class _AgentMonogramCellState extends State<_AgentMonogramCell>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1000),
    );
    _animation = Tween<double>(begin: 0.5, end: 1.0).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
    if (widget.isWorking) {
      _controller.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(covariant _AgentMonogramCell oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.isWorking && !oldWidget.isWorking) {
      _controller.repeat(reverse: true);
    } else if (!widget.isWorking && oldWidget.isWorking) {
      _controller.stop();
      _controller.value = 1.0;
    }
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final monogram =
        AgentConstants.agentMonograms[widget.agent] ?? '--';
    // Agent-specific color -- game identity, not migrated.
    final agentColor =
        Color(AgentConstants.agentColors[widget.agent] ?? 0xFF888888);

    if (widget.isWorking) {
      return AnimatedBuilder(
        animation: _animation,
        builder: (context, child) {
          return Text(
            monogram,
            style: ArenaTextStyles.mono(
              context,
              fontSize: FiftyTypography.labelMedium,
              fontWeight: FiftyTypography.bold,
              color: agentColor.withValues(alpha: _animation.value),
            ),
          );
        },
      );
    }

    return Text(
      monogram,
      style: ArenaTextStyles.mono(
        context,
        fontSize: FiftyTypography.labelMedium,
        fontWeight: FiftyTypography.bold,
        color: agentColor.withValues(alpha: 0.7),
      ),
    );
  }
}
