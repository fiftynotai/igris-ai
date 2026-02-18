/// Centralized responsive breakpoints for the Crimson Arena dashboard.
///
/// All responsive layout decisions (column counts, padding changes,
/// compact vs full labels) should reference these constants instead
/// of embedding magic numbers in individual widgets.
///
/// Breakpoints are derived from the patterns already established in
/// [ArenaScaffold], [HomePage], [AgentsPage], [InstancesPage],
/// [AgentGrid], and [AchievementGrid].
class ArenaBreakpoints {
  ArenaBreakpoints._();

  // ---------------------------------------------------------------------------
  // Page-level layout breakpoints
  // ---------------------------------------------------------------------------

  /// Compact / mobile threshold.
  ///
  /// Below this width the nav bar collapses to abbreviated tabs,
  /// page padding shrinks, and single-column layouts are used.
  static const double narrow = 600;

  /// Two-column threshold.
  ///
  /// Above this width the dashboard switches to a two-column layout
  /// (e.g. HOME left/right columns, AGENTS detail panels side-by-side).
  static const double wide = 900;

  /// Four-column threshold.
  ///
  /// Above this width grids expand to their maximum column count.
  static const double extraWide = 1200;

  // ---------------------------------------------------------------------------
  // Grid column breakpoints
  // ---------------------------------------------------------------------------

  /// Minimum width for a two-column grid (agent cards, achievements).
  static const double gridTwoColumn = 500;

  /// Minimum width for a three-column grid.
  static const double gridThreeColumn = 800;

  /// Minimum width for a four-column grid.
  static const double gridFourColumn = 1200;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /// Returns the appropriate number of grid columns for the given [width].
  ///
  /// This mirrors the column logic shared by [AgentGrid] and
  /// [AchievementGrid]:
  /// - >1200 px : 4 columns
  /// - >800 px  : 3 columns
  /// - >500 px  : 2 columns
  /// - otherwise: 1 column
  static int gridColumns(double width) {
    if (width > gridFourColumn) return 4;
    if (width > gridThreeColumn) return 3;
    if (width > gridTwoColumn) return 2;
    return 1;
  }
}
