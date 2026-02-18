import 'package:fifty_theme/fifty_theme.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import '../../../../core/constants/agent_constants.dart';
import '../../../../data/models/instance_model.dart';

/// Displays the 5-phase hunt pipeline: PLAN -> BUILD -> TEST -> REVIEW -> DONE.
///
/// Current phase is highlighted with burgundy/glow. Completed phases are
/// shown in hunter green. Future phases are rendered in gray.
class HuntPipelineWidget extends StatelessWidget {
  final InstanceModel instance;

  const HuntPipelineWidget({
    super.key,
    required this.instance,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final rawPhase = (instance.currentPhase ?? '').toUpperCase();
    final phaseKey = AgentConstants.phaseMap[rawPhase];
    final currentIndex = phaseKey != null
        ? AgentConstants.huntPhases.indexOf(phaseKey)
        : -1;

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
          Row(
            children: [
              Text(
                'HUNT PIPELINE',
                style: textTheme.labelMedium!.copyWith(
                  color: colorScheme.onSurfaceVariant,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              if (instance.currentBrief != null) ...[
                const SizedBox(width: FiftySpacing.sm),
                Text(
                  instance.currentBrief!,
                  style: textTheme.labelMedium!.copyWith(
                    fontWeight: FiftyTypography.semiBold,
                    color: colorScheme.onSurface.withValues(alpha: 0.7),
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: FiftySpacing.md),

          // Pipeline phases
          Row(
            children: [
              for (int i = 0; i < AgentConstants.huntPhases.length; i++) ...[
                if (i > 0) _buildConnector(context, i, currentIndex),
                Expanded(child: _buildPhaseNode(context, i, currentIndex)),
              ],
            ],
          ),
        ],
      ),
    );
  }

  Widget _buildPhaseNode(BuildContext context, int index, int currentIndex) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final textTheme = theme.textTheme;
    final phase = AgentConstants.huntPhases[index];
    final isDone = currentIndex >= 0 && index < currentIndex;
    final isCurrent = index == currentIndex;

    Color nodeColor;
    Color textColor;
    Color borderColor;

    if (isDone) {
      nodeColor = ext.success.withValues(alpha: 0.2);
      textColor = ext.success;
      borderColor = ext.success.withValues(alpha: 0.5);
    } else if (isCurrent) {
      nodeColor = colorScheme.primary.withValues(alpha: 0.2);
      textColor = colorScheme.onSurface;
      borderColor = colorScheme.primary;
    } else {
      nodeColor = Colors.transparent;
      textColor = colorScheme.onSurfaceVariant.withValues(alpha: 0.5);
      borderColor = colorScheme.outline;
    }

    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        // Phase circle
        Container(
          width: 36,
          height: 36,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: nodeColor,
            border: Border.all(color: borderColor, width: isCurrent ? 2 : 1),
            boxShadow: isCurrent
                ? [
                    BoxShadow(
                      color: colorScheme.primary.withValues(alpha: 0.3),
                      blurRadius: 8,
                      spreadRadius: 1,
                    ),
                  ]
                : null,
          ),
          child: Center(
            child: isDone
                ? Icon(Icons.check, size: 16, color: textColor)
                : isCurrent
                    ? _buildPulsingDot(context)
                    : Container(
                        width: 6,
                        height: 6,
                        decoration: BoxDecoration(
                          shape: BoxShape.circle,
                          color: textColor,
                        ),
                      ),
          ),
        ),
        const SizedBox(height: FiftySpacing.xs),

        // Phase label
        Text(
          phase.toUpperCase(),
          style: textTheme.labelSmall!.copyWith(
            fontWeight:
                isCurrent ? FiftyTypography.bold : FiftyTypography.medium,
            color: textColor,
            letterSpacing: FiftyTypography.letterSpacingLabelMedium,
          ),
        ),
      ],
    );
  }

  Widget _buildConnector(BuildContext context, int index, int currentIndex) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final ext = theme.extension<FiftyThemeExtension>()!;
    final isDone = currentIndex >= 0 && index <= currentIndex;

    return SizedBox(
      width: FiftySpacing.md,
      child: Padding(
        padding: const EdgeInsets.only(bottom: FiftySpacing.lg),
        child: Container(
          height: 2,
          color: isDone
              ? ext.success.withValues(alpha: 0.5)
              : colorScheme.outline,
        ),
      ),
    );
  }

  Widget _buildPulsingDot(BuildContext context) {
    final colorScheme = Theme.of(context).colorScheme;
    return _PulsingDot(color: colorScheme.primary);
  }
}

/// A pulsing dot indicator for the current active phase.
class _PulsingDot extends StatefulWidget {
  final Color color;

  const _PulsingDot({required this.color});

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _controller;
  late final Animation<double> _animation;

  @override
  void initState() {
    super.initState();
    _controller = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1200),
    )..repeat(reverse: true);
    _animation = Tween<double>(begin: 0.4, end: 1.0).animate(
      CurvedAnimation(parent: _controller, curve: Curves.easeInOut),
    );
  }

  @override
  void dispose() {
    _controller.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return AnimatedBuilder(
      animation: _animation,
      builder: (context, child) {
        return Container(
          width: 8,
          height: 8,
          decoration: BoxDecoration(
            shape: BoxShape.circle,
            color: widget.color.withValues(alpha: _animation.value),
            boxShadow: [
              BoxShadow(
                color: widget.color.withValues(alpha: _animation.value * 0.5),
                blurRadius: 6,
                spreadRadius: 1,
              ),
            ],
          ),
        );
      },
    );
  }
}
