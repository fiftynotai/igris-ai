import 'package:flutter/material.dart';

/// A segmented progress bar mimicking the HP / context window gauges.
///
/// Consolidates the identical `_SegmentedBar` implementations in
/// [TokenBudgetCard] and [ContextWindowCard] into a single public widget.
///
/// The bar is divided into [segmentCount] equal segments. Segments up to
/// the filled threshold are painted with [color]; the remaining segments
/// use the theme's surface tint (derived from [Theme.of(context)]) to
/// stay theme-aware from day one.
///
/// Example usage:
/// ```dart
/// SegmentedBar(
///   percentage: 72.5,
///   color: FiftyColors.hunterGreen,
/// )
///
/// SegmentedBar(
///   percentage: 95.0,
///   color: FiftyColors.burgundy,
///   segmentCount: 10,
///   height: 12,
/// )
/// ```
class SegmentedBar extends StatelessWidget {
  /// The fill percentage (0-100).
  final double percentage;

  /// The color used for filled segments.
  final Color color;

  /// Total number of segments to render. Defaults to 20.
  final int segmentCount;

  /// Height of each segment. Defaults to 8.
  final double height;

  /// Gap between segments. Defaults to 2.
  final double gap;

  const SegmentedBar({
    super.key,
    required this.percentage,
    required this.color,
    this.segmentCount = 20,
    this.height = 8,
    this.gap = 2,
  });

  @override
  Widget build(BuildContext context) {
    final filledCount = (percentage / 100 * segmentCount).round();

    // Derive the empty-segment color from the theme so the widget adapts
    // automatically when the theme changes.
    final theme = Theme.of(context);
    final emptyColor = theme.colorScheme.onSurface.withValues(alpha: 0.05);

    return Row(
      children: List.generate(segmentCount, (i) {
        final filled = i < filledCount;
        return Expanded(
          child: Container(
            height: height,
            margin: EdgeInsets.only(
              right: i < segmentCount - 1 ? gap : 0,
            ),
            decoration: BoxDecoration(
              color: filled ? color : emptyColor,
              borderRadius: BorderRadius.circular(2),
            ),
          ),
        );
      }),
    );
  }
}
