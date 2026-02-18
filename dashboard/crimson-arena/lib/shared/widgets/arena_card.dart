import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

/// A styled card container for Crimson Arena dashboard panels.
///
/// Provides the standard dark surface styling with optional title header
/// and consistent padding/border radius using FDL v2 tokens.
class ArenaCard extends StatelessWidget {
  /// Card title displayed in the header row.
  final String? title;

  /// Optional trailing widget in the header row (e.g., badge, count).
  final Widget? trailing;

  /// Card body content.
  final Widget child;

  /// Optional padding override (defaults to FiftySpacing.md).
  final EdgeInsetsGeometry? padding;

  const ArenaCard({
    super.key,
    this.title,
    this.trailing,
    required this.child,
    this.padding,
  });

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return Container(
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: FiftyRadii.lgRadius,
        border: Border.all(
          color: colorScheme.outline,
          width: 1,
        ),
      ),
      child: Padding(
        padding: padding ??
            const EdgeInsets.all(FiftySpacing.md),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          mainAxisSize: MainAxisSize.min,
          children: [
            if (title != null) ...[
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text(
                    title!,
                    style: textTheme.labelMedium!.copyWith(
                      color: colorScheme.onSurfaceVariant,
                      letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                    ),
                  ),
                  if (trailing != null) trailing!,
                ],
              ),
              const SizedBox(height: FiftySpacing.sm),
            ],
            child,
          ],
        ),
      ),
    );
  }
}
