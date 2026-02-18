import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

/// A reusable, theme-aware status badge for the Crimson Arena dashboard.
///
/// Consolidates the duplicated badge patterns found across:
/// - `_ConnectionBadge` in [BrainHealthCard]
/// - `_buildConnectionBadge` in [ArenaScaffold]
/// - `_StatusPill` in [BrainCommandCenter]
/// - `_buildVital` / `_buildSyncIndicator` in [CompactVitalsStrip]
///
/// The badge renders a compact pill with an optional leading status dot,
/// a text label, and an optional trailing count. All text styles are
/// resolved from [Theme.of(context)] rather than hard-coding [GoogleFonts].
///
/// Example usage:
/// ```dart
/// StatusBadge(
///   label: 'ONLINE',
///   color: ext.success,
///   showDot: true,
/// )
///
/// StatusBadge(
///   label: 'In Progress',
///   color: ext.warning,
///   count: 3,
///   showBorder: true,
/// )
/// ```
class StatusBadge extends StatelessWidget {
  /// The text displayed inside the badge.
  final String label;

  /// The accent color used for the dot, label text, border, and background
  /// tint. When null, defaults to [Theme.of(context).colorScheme.onSurfaceVariant].
  final Color? color;

  /// Optional integer count displayed after the label (e.g. "Ready: 5").
  final int? count;

  /// Whether to show a leading status dot. Defaults to `false`.
  final bool showDot;

  /// Whether to render an outer border. Defaults to `true`.
  final bool showBorder;

  /// Diameter of the leading status dot. Defaults to 6.
  final double dotSize;

  const StatusBadge({
    super.key,
    required this.label,
    this.color,
    this.count,
    this.showDot = false,
    this.showBorder = true,
    this.dotSize = 6,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final resolvedColor = color ?? theme.colorScheme.onSurfaceVariant;
    final textStyle = theme.textTheme.labelSmall?.copyWith(
          fontWeight: FontWeight.w600,
          color: resolvedColor,
          letterSpacing: FiftyTypography.letterSpacingLabel,
        ) ??
        TextStyle(
          fontSize: FiftyTypography.labelSmall,
          fontWeight: FontWeight.w600,
          color: resolvedColor,
          letterSpacing: FiftyTypography.letterSpacingLabel,
        );

    final displayText = count != null ? '$label: $count' : label;

    return Container(
      padding: const EdgeInsets.symmetric(
        horizontal: FiftySpacing.sm,
        vertical: FiftySpacing.xs,
      ),
      decoration: BoxDecoration(
        color: resolvedColor.withValues(alpha: 0.15),
        borderRadius: FiftyRadii.smRadius,
        border: showBorder
            ? Border.all(
                color: resolvedColor.withValues(alpha: 0.3),
                width: 1,
              )
            : null,
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          if (showDot) ...[
            Container(
              width: dotSize,
              height: dotSize,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: resolvedColor,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
          ],
          Text(displayText, style: textStyle),
        ],
      ),
    );
  }
}
