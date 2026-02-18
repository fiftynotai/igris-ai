import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

/// Mono-font helper for the Crimson Arena dashboard.
///
/// The FDL v2 theme provides all Manrope text styles via the standard
/// [ThemeData.textTheme]. However, the dashboard also needs Source Code
/// Pro for monospaced content such as elapsed times, log entries, token
/// counts, and expand/collapse indicators.
///
/// This class centralises all [GoogleFonts.sourceCodePro] usage so that
/// individual widget files do not need to import `google_fonts` at all.
///
/// Usage:
/// ```dart
/// Text(
///   '12m ago',
///   style: ArenaTextStyles.mono(context, fontSize: 12),
/// )
/// ```
class ArenaTextStyles {
  ArenaTextStyles._();

  /// The monospace font family name used throughout the dashboard.
  static final String monoFontFamily = GoogleFonts.sourceCodePro().fontFamily!;

  /// Returns a [TextStyle] using Source Code Pro.
  ///
  /// The default color is derived from [Theme.of(context)] so that the
  /// style adapts automatically to theme changes. Callers can override
  /// individual properties via the named parameters.
  ///
  /// Parameters:
  /// - [fontSize] defaults to 12.0
  /// - [fontWeight] defaults to [FontWeight.w500] (medium)
  /// - [color] defaults to `theme.colorScheme.onSurface`
  /// - [letterSpacing] optional letter spacing override
  /// - [height] optional line height multiplier
  static TextStyle mono(
    BuildContext context, {
    double? fontSize,
    FontWeight? fontWeight,
    Color? color,
    double? letterSpacing,
    double? height,
  }) {
    final theme = Theme.of(context);
    return GoogleFonts.sourceCodePro(
      fontSize: fontSize ?? 12,
      fontWeight: fontWeight ?? FontWeight.w500,
      color: color ?? theme.colorScheme.onSurface,
      letterSpacing: letterSpacing,
      height: height,
    );
  }
}
