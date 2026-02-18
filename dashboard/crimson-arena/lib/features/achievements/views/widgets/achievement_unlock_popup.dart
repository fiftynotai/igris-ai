import 'dart:async';

import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:flutter/material.dart';

import 'rarity_theme.dart';

/// Modal popup displayed when an achievement is unlocked.
///
/// Slides in from the bottom with a rarity-themed border glow.
/// Automatically dismisses after [autoDismissDuration] or on tap.
class AchievementUnlockPopup extends StatefulWidget {
  /// The achievement that was just unlocked.
  final Achievement<void> achievement;

  /// Called when the popup is dismissed (tap or auto-dismiss).
  final VoidCallback onDismiss;

  /// Duration before auto-dismiss (default 5 seconds).
  final Duration autoDismissDuration;

  const AchievementUnlockPopup({
    super.key,
    required this.achievement,
    required this.onDismiss,
    this.autoDismissDuration = const Duration(seconds: 5),
  });

  @override
  State<AchievementUnlockPopup> createState() =>
      _AchievementUnlockPopupState();
}

class _AchievementUnlockPopupState extends State<AchievementUnlockPopup>
    with SingleTickerProviderStateMixin {
  late final AnimationController _slideController;
  late final Animation<Offset> _slideAnimation;
  Timer? _autoDismissTimer;

  @override
  void initState() {
    super.initState();

    _slideController = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 400),
    );

    _slideAnimation = Tween<Offset>(
      begin: const Offset(0, 1),
      end: Offset.zero,
    ).animate(CurvedAnimation(
      parent: _slideController,
      curve: Curves.easeOutCubic,
    ));

    _slideController.forward();

    _autoDismissTimer = Timer(widget.autoDismissDuration, _dismiss);
  }

  @override
  void dispose() {
    _autoDismissTimer?.cancel();
    _slideController.dispose();
    super.dispose();
  }

  Future<void> _dismiss() async {
    _autoDismissTimer?.cancel();
    await _slideController.reverse();
    if (mounted) {
      widget.onDismiss();
    }
  }

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final rarityTheme = RarityTheme.of(widget.achievement.rarity);

    return GestureDetector(
      onTap: _dismiss,
      behavior: HitTestBehavior.opaque,
      child: Material(
        color: Colors.black54,
        child: Center(
          child: SlideTransition(
            position: _slideAnimation,
            child: Container(
              width: 380,
              padding: const EdgeInsets.all(FiftySpacing.lg),
              decoration: BoxDecoration(
                color: colorScheme.surfaceContainerHighest,
                borderRadius: FiftyRadii.lgRadius,
                border: Border.all(
                  color: rarityTheme.glowColor,
                  width: 2,
                ),
                boxShadow: [
                  BoxShadow(
                    color: rarityTheme.glowColor.withValues(alpha: 0.4),
                    blurRadius: 24,
                    spreadRadius: 4,
                  ),
                ],
              ),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                children: [
                  // Rarity label
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FiftySpacing.sm,
                      vertical: FiftySpacing.xs,
                    ),
                    decoration: BoxDecoration(
                      color: rarityTheme.glowColor.withValues(alpha: 0.15),
                      borderRadius: FiftyRadii.smRadius,
                      border: Border.all(
                        color: rarityTheme.glowColor.withValues(alpha: 0.3),
                        width: 1,
                      ),
                    ),
                    child: Text(
                      widget.achievement.rarity.displayName.toUpperCase(),
                      style: textTheme.labelSmall!.copyWith(
                        fontWeight: FiftyTypography.bold,
                        color: rarityTheme.glowColor,
                        letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                      ),
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.md),

                  // Achievement icon
                  Container(
                    width: 64,
                    height: 64,
                    decoration: BoxDecoration(
                      shape: BoxShape.circle,
                      color: rarityTheme.glowColor.withValues(alpha: 0.15),
                      border: Border.all(
                        color: rarityTheme.glowColor.withValues(alpha: 0.5),
                        width: 2,
                      ),
                    ),
                    child: Icon(
                      widget.achievement.icon ?? Icons.emoji_events,
                      color: rarityTheme.glowColor,
                      size: 32,
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.md),

                  // ACHIEVEMENT UNLOCKED header
                  Text(
                    'ACHIEVEMENT UNLOCKED',
                    style: textTheme.labelMedium!.copyWith(
                      color: rarityTheme.glowColor,
                      letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.sm),

                  // Achievement name
                  Text(
                    widget.achievement.name,
                    textAlign: TextAlign.center,
                    style: textTheme.titleLarge!.copyWith(
                      fontWeight: FiftyTypography.extraBold,
                      color: colorScheme.onSurface,
                      letterSpacing: FiftyTypography.letterSpacingDisplay,
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.xs),

                  // Description
                  Text(
                    widget.achievement.description ?? '',
                    textAlign: TextAlign.center,
                    style: textTheme.bodyMedium!.copyWith(
                      fontWeight: FiftyTypography.medium,
                      color: colorScheme.onSurfaceVariant,
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.md),

                  // Points
                  Container(
                    padding: const EdgeInsets.symmetric(
                      horizontal: FiftySpacing.md,
                      vertical: FiftySpacing.sm,
                    ),
                    decoration: BoxDecoration(
                      color: colorScheme.surface,
                      borderRadius: FiftyRadii.smRadius,
                    ),
                    child: Text(
                      '+${widget.achievement.points} PTS',
                      style: textTheme.titleSmall!.copyWith(
                        fontWeight: FiftyTypography.extraBold,
                        color: colorScheme.onSurface,
                        letterSpacing: FiftyTypography.letterSpacingLabel,
                      ),
                    ),
                  ),

                  const SizedBox(height: FiftySpacing.md),

                  // Dismiss hint
                  Text(
                    'TAP TO DISMISS',
                    style: textTheme.labelSmall!.copyWith(
                      fontWeight: FiftyTypography.medium,
                      color: colorScheme.onSurfaceVariant.withValues(alpha: 0.6),
                      letterSpacing: FiftyTypography.letterSpacingLabel,
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

/// Shows the unlock popup as an overlay entry.
///
/// Call this from the view layer when [AchievementsViewModel.unlockQueue]
/// is non-empty.
void showAchievementUnlockPopup(
  BuildContext context,
  Achievement<void> achievement, {
  VoidCallback? onDismiss,
}) {
  late OverlayEntry entry;
  entry = OverlayEntry(
    builder: (_) => AchievementUnlockPopup(
      achievement: achievement,
      onDismiss: () {
        entry.remove();
        onDismiss?.call();
      },
    ),
  );
  Overlay.of(context).insert(entry);
}
