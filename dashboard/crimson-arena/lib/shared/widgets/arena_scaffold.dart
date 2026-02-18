import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:get/get.dart';
import 'package:google_fonts/google_fonts.dart';

import '../../core/routing/app_routes.dart';
import '../../services/brain_websocket_service.dart';

/// Shared scaffold for all Crimson Arena pages.
///
/// Provides:
/// - Top navigation bar with page tabs (HOME, INSTANCES, AGENTS, ACHIEVEMENTS)
/// - Connection status badge (LIVE / OFFLINE)
/// - Keyboard shortcuts (Ctrl+1/2/3/4)
/// - Consistent dark theme styling with FDL v2 tokens
/// - Responsive nav: collapses to abbreviated tabs below 600px
class ArenaScaffold extends StatelessWidget {
  /// The page title displayed in the nav bar.
  final String title;

  /// The page body content.
  final Widget body;

  /// Index of the currently active tab (0-3).
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
  ];

  /// Width threshold below which the nav collapses to compact mode.
  static const double _narrowBreakpoint = 600;

  @override
  Widget build(BuildContext context) {
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
      },
      child: Focus(
        autofocus: true,
        child: Scaffold(
          backgroundColor: FiftyColors.darkBurgundy,
          body: Column(
            children: [
              _buildNavBar(context),
              Expanded(
                child: Stack(
                  children: [
                    // Subtle halftone dot texture for depth.
                    const Positioned.fill(
                      child: HalftoneOverlay(
                        color: FiftyColors.cream,
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
    return LayoutBuilder(
      builder: (context, constraints) {
        final isNarrow = constraints.maxWidth < _narrowBreakpoint;
        final horizontalPad =
            isNarrow ? FiftySpacing.sm : FiftySpacing.lg;

        return Container(
          height: 56,
          decoration: BoxDecoration(
            color: FiftyColors.surfaceDark,
            border: Border(
              bottom: BorderSide(
                color: FiftyColors.borderDark,
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
                style: GoogleFonts.manrope(
                  fontSize: FiftyTypography.titleSmall,
                  fontWeight: FiftyTypography.extraBold,
                  color: FiftyColors.burgundy,
                  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
                ),
              ),
              SizedBox(width: isNarrow ? FiftySpacing.sm : FiftySpacing.xxl),

              // Navigation tabs -- short labels on narrow screens.
              ..._tabs.asMap().entries.map((entry) => _buildTab(
                    entry.value,
                    isActive: entry.key == activeTabIndex,
                    onTap: () => _navigateTo(entry.key),
                    compact: isNarrow,
                  )),

              const Spacer(),

              // Connection status badge
              _buildConnectionBadge(),
            ],
          ),
        );
      },
    );
  }

  Widget _buildTab(
    _TabDef tab, {
    required bool isActive,
    VoidCallback? onTap,
    bool compact = false,
  }) {
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
                ? FiftyColors.burgundy.withValues(alpha: 0.15)
                : Colors.transparent,
            borderRadius: FiftyRadii.smRadius,
            border: isActive
                ? Border.all(
                    color: FiftyColors.burgundy.withValues(alpha: 0.3),
                    width: 1,
                  )
                : null,
          ),
          child: Text(
            label,
            style: GoogleFonts.manrope(
              fontSize: FiftyTypography.labelMedium,
              fontWeight: isActive
                  ? FiftyTypography.bold
                  : FiftyTypography.medium,
              color: isActive ? FiftyColors.cream : FiftyColors.slateGrey,
              letterSpacing: FiftyTypography.letterSpacingLabelMedium,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildConnectionBadge() {
    final wsService = Get.find<BrainWebSocketService>();

    return Obx(() {
      final connected = wsService.isConnected.value;
      final badge = Container(
        padding: const EdgeInsets.symmetric(
          horizontal: FiftySpacing.sm,
          vertical: FiftySpacing.xs,
        ),
        decoration: BoxDecoration(
          color: connected
              ? FiftyColors.hunterGreen.withValues(alpha: 0.15)
              : FiftyColors.burgundy.withValues(alpha: 0.15),
          borderRadius: FiftyRadii.smRadius,
          border: Border.all(
            color: connected
                ? FiftyColors.hunterGreen.withValues(alpha: 0.3)
                : FiftyColors.burgundy.withValues(alpha: 0.3),
            width: 1,
          ),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              width: 6,
              height: 6,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: connected ? FiftyColors.hunterGreen : FiftyColors.burgundy,
              ),
            ),
            const SizedBox(width: FiftySpacing.xs),
            Text(
              connected ? 'LIVE' : 'OFFLINE',
              style: GoogleFonts.manrope(
                fontSize: FiftyTypography.labelSmall,
                fontWeight: FiftyTypography.semiBold,
                color: connected
                    ? FiftyColors.hunterGreen
                    : FiftyColors.burgundy,
                letterSpacing: FiftyTypography.letterSpacingLabel,
              ),
            ),
          ],
        ),
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
