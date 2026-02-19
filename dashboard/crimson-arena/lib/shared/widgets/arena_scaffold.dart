import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';

import '../../core/constants/arena_breakpoints.dart';
import '../../core/routing/app_routes.dart';
import '../../services/brain_websocket_service.dart';

/// Shared scaffold for all Crimson Arena pages.
///
/// Provides:
/// - Top navigation bar with page tabs (HOME, INSTANCES, AGENTS, ACHIEVEMENTS, SKILLS)
/// - Connection status badge (LIVE / OFFLINE)
/// - Keyboard shortcuts (Ctrl+1/2/3/4/5)
/// - Consistent dark theme styling with FDL v2 tokens
/// - Responsive nav: collapses to abbreviated tabs below 600px
class ArenaScaffold extends StatelessWidget {
  /// The page title displayed in the nav bar.
  final String title;

  /// The page body content.
  final Widget body;

  /// Index of the currently active tab (0-4).
  final int activeTabIndex;

  const ArenaScaffold({
    super.key,
    required this.title,
    required this.body,
    required this.activeTabIndex,
  });

  static const _tabs = [
    _TabDef(label: 'HOME', shortLabel: 'HM', route: AppRoutes.home),
    _TabDef(label: 'INSTANCES', shortLabel: 'IN', route: AppRoutes.instances),
    _TabDef(label: 'AGENTS', shortLabel: 'AG', route: AppRoutes.agents),
    _TabDef(
      label: 'ACHIEVEMENTS',
      shortLabel: 'AC',
      route: AppRoutes.achievements,
    ),
    _TabDef(
      label: 'SKILLS',
      shortLabel: 'SK',
      route: AppRoutes.skills,
    ),
  ];

  /// Width threshold below which the nav collapses to compact mode.
  static const double _narrowBreakpoint = ArenaBreakpoints.narrow;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;

    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.digit1, control: true):
            () => _navigateTo(0),
        const SingleActivator(LogicalKeyboardKey.digit2, control: true):
            () => _navigateTo(1),
        const SingleActivator(LogicalKeyboardKey.digit3, control: true):
            () => _navigateTo(2),
        const SingleActivator(LogicalKeyboardKey.digit4, control: true):
            () => _navigateTo(3),
        const SingleActivator(LogicalKeyboardKey.digit5, control: true):
            () => _navigateTo(4),
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: colorScheme.surface,
          body: Column(
            children: [
              _buildNavBar(context),
              Expanded(
                child: Stack(
                  children: [
                    // Subtle halftone dot texture for depth.
                    Positioned.fill(
                      child: HalftoneOverlay(
                        color: colorScheme.onSurface,
                        dotRadius: 0.8,
                        spacing: 10.0,
                        opacity: 0.03,
                      ),
                    ),
                    // Page content.
                    body,
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _buildNavBar(BuildContext context) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;

    return LayoutBuilder(
      builder: (context, constraints) {
        final isNarrow = constraints.maxWidth < _narrowBreakpoint;
        final horizontalPad =
            isNarrow ? FiftySpacing.sm : FiftySpacing.lg;

        return Container(
          height: 56,
          decoration: BoxDecoration(
            color: colorScheme.surfaceContainerHighest,
            border: Border(
              bottom: BorderSide(
                color: colorScheme.outline,
                width: 1,
              ),
            ),
          ),
          padding: EdgeInsets.symmetric(horizontal: horizontalPad),
          child: Row(
            children: [
              // Brand mark -- abbreviated on narrow screens.
              Text(
                isNarrow ? 'CA' : 'CRIMSON ARENA',
                style: textTheme.titleSmall!.copyWith(
                  fontWeight: FiftyTypography.extraBold,
                  color: colorScheme.primary,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              SizedBox(width: isNarrow ? FiftySpacing.sm : FiftySpacing.xxl),

              // Navigation tabs -- short labels on narrow screens.
              ..._tabs.asMap().entries.map((entry) => _buildTab(
                    context,
                    entry.value,
                    isActive: entry.key == activeTabIndex,
                    onTap: () => _navigateTo(entry.key),
                    compact: isNarrow,
                  )),

              const Spacer(),

              // Connection status badge
              _buildConnectionBadge(context),
            ],
          ),
        );
      },
    );
  }

  Widget _buildTab(
    BuildContext context,
    _TabDef tab, {
    required bool isActive,
    VoidCallback? onTap,
    bool compact = false,
  }) {
    final theme = Theme.of(context);
    final colorScheme = theme.colorScheme;
    final textTheme = theme.textTheme;
    final label = compact ? tab.shortLabel : tab.label;
    final hPad = compact ? FiftySpacing.sm : FiftySpacing.md;

    return Padding(
      padding: const EdgeInsets.only(right: FiftySpacing.xs),
      child: InkWell(
        onTap: onTap,
        borderRadius: FiftyRadii.smRadius,
        child: Container(
          padding: EdgeInsets.symmetric(
            horizontal: hPad,
            vertical: FiftySpacing.sm,
          ),
          decoration: BoxDecoration(
            color: isActive
                ? colorScheme.primary.withValues(alpha: 0.15)
                : Colors.transparent,
            borderRadius: FiftyRadii.smRadius,
            border: isActive
                ? Border.all(
                    color: colorScheme.primary.withValues(alpha: 0.3),
                    width: 1,
                  )
                : null,
          ),
          child: Text(
            label,
            style: textTheme.labelMedium!.copyWith(
              fontWeight: isActive
                  ? FiftyTypography.bold
                  : FiftyTypography.medium,
              color: isActive ? colorScheme.onSurface : colorScheme.onSurfaceVariant,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConnectionBadge(BuildContext context) {
    final wsService = Get.find<BrainWebSocketService>();

    return Obx(() {
      final connected = wsService.isConnected.value;
      final badge = FiftyBadge(
        label: connected ? 'LIVE' : 'OFFLINE',
        variant: connected
            ? FiftyBadgeVariant.success
            : FiftyBadgeVariant.error,
        showGlow: connected,
      );

      // Apply glitch effect when disconnected.
      if (!connected) {
        return GlitchEffect(
          triggerOnMount: true,
          intensity: 0.6,
          offset: 2.0,
          duration: const Duration(milliseconds: 500),
          child: badge,
        );
      }

      return badge;
    });
  }

  void _navigateTo(int index) {
    if (index == activeTabIndex) return;
    Get.offNamed(_tabs[index].route);
  }
}

class _TabDef {
  final String label;

  /// Abbreviated label for narrow viewports (<600px).
  final String shortLabel;
  final String route;

  const _TabDef({
    required this.label,
    required this.shortLabel,
    required this.route,
  });
}
