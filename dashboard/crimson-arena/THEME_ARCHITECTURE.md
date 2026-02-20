# Crimson Arena Theme Architecture Report

## Executive Summary

The Crimson Arena dashboard uses a comprehensive, token-driven design system called the **Fifty Design Language (FDL) v2**, consisting of three integrated packages:

1. **fifty_tokens** - Pure design tokens (colors, typography, spacing, shadows, radii, motion)
2. **fifty_theme** - Flutter ThemeData builder (ColorScheme, TextTheme, component themes, extensions)
3. **fifty_ui** - Pre-built FDL components (buttons, cards, badges, indicators, etc.)

The system is **dark-mode primary**, uses **Manrope** font family exclusively, and features **Burgundy (#88292F)** as the primary brand color.

---

## Package Structure

### 1. fifty_tokens - Design Token Definitions

**Location**: `/Users/m.elamin/StudioProjects/fifty_eco_system/packages/fifty_tokens/lib/src/`

**Core Token Files**:
- `colors.dart` - Color palette (Burgundy, Cream, Dark Burgundy, Slate Grey, etc.)
- `typography.dart` - Font sizes, weights, line heights, letter spacing
- `spacing.dart` - 4px base grid (xs=4, sm=8, md=12, lg=16, xl=20, xxl=24, xxxl=32, huge=40, massive=48)
- `radii.dart` - Border radius scale (sm=4, md=8, lg=12, xl=16, xxl=24, xxxl=32, full=9999)
- `shadows.dart` - Shadow tokens (sm, md, lg, primary, glow)
- `motion.dart` - Animation durations and curves

#### Colors (FiftyColors)

**Core Palette**:
```
- burgundy (#88292F)             → Primary brand color
- burgundyHover (#6E2126)        → Primary hover state
- cream (#FEFEE3)                → Light bg + dark mode text
- darkBurgundy (#1A0D0E)         → Dark mode background
- slateGrey (#335C67)            → Secondary color
- slateGreyHover (#274750)       → Secondary hover
- hunterGreen (#4B644A)          → Success/positive
- powderBlush (#FFC9B9)          → Dark mode accent
- surfaceLight (#FAF9DE)         → Light mode card surface
- surfaceDark (#2A1517)          → Dark mode card surface
```

**Semantic Colors**:
```
- primary = burgundy
- secondary = slateGrey
- success = hunterGreen
- warning (#F7A100)
- error = burgundy (consistency)
```

**Dynamic Colors**:
```
- borderLight = Colors.black.withValues(alpha: 0.05)
- borderDark = Colors.white.withValues(alpha: 0.05)
- focusLight = burgundy
- focusDark = powderBlush.withValues(alpha: 0.5)
```

#### Typography (FiftyTypography)

**Font Family**: Manrope (loaded via google_fonts)

**Font Weights**:
- regular (400), medium (500), semiBold (600), bold (700), extraBold (800)

**Type Scale**:
```
- displayLarge: 32px, 800, letterSpacing: -0.5, lineHeight: 1.2
- displayMedium: 24px, 800, letterSpacing: -0.25, lineHeight: 1.2
- titleLarge: 20px, 700, lineHeight: 1.3
- titleMedium: 18px, 700, lineHeight: 1.3
- titleSmall: 16px, 700, lineHeight: 1.3
- bodyLarge: 16px, 500, letterSpacing: 0.5, lineHeight: 1.5
- bodyMedium: 14px, 400, letterSpacing: 0.25, lineHeight: 1.5
- bodySmall: 12px, 400, letterSpacing: 0.4, lineHeight: 1.5
- labelLarge: 14px, 700, letterSpacing: 0.5, lineHeight: 1.2
- labelMedium: 12px, 700, letterSpacing: 1.5 (UPPERCASE), lineHeight: 1.2
- labelSmall: 10px, 600, letterSpacing: 0.5, lineHeight: 1.2
```

#### Spacing (FiftySpacing)

4px base grid:
```
- xs: 4px     (1x base)
- sm: 8px     (2x base) ← Primary tight gap
- md: 12px    (3x base) ← Standard gap
- lg: 16px    (4x base) ← Comfortable
- xl: 20px    (5x base)
- xxl: 24px   (6x base) ← Section spacing
- xxxl: 32px  (8x base) ← Major section
- huge: 40px  (10x base)
- massive: 48px (12x base)
```

#### Border Radius (FiftyRadii)

```
- sm: 4px        (Checkboxes, small badges)
- md: 8px        (Chips, tags)
- lg: 12px       (Standard cards, legacy inputs)
- xl: 16px       (Buttons, text fields, dropdowns) ← MOST COMMON
- xxl: 24px      (Standard cards)
- xxxl: 32px     (Hero cards, modals, dialogs)
- full: 9999px   (Pills, circles, badges)
```

#### Shadows (FiftyShadows)

```
- sm: 0 1px 2px rgba(0,0,0,0.05)           → Hover states
- md: 0 4px 6px rgba(0,0,0,0.07)          → Cards
- lg: 0 10px 15px rgba(0,0,0,0.1)         → Modals, dropdowns
- primary: 0 4px 14px rgba(136,41,47,0.2) → Primary buttons
- glow: 0 0 15px rgba(254,254,227,0.1)    → Dark mode accent focus
- none: (empty list)
```

---

### 2. fifty_theme - Theme Data Builder

**Location**: `/Users/m.elamin/StudioProjects/fifty_eco_system/packages/fifty_theme/lib/src/`

**Main Entry Point**: `FiftyTheme.dark()` → Returns complete `ThemeData`

#### What FiftyTheme.dark() Configures

```dart
ThemeData(
  useMaterial3: true,
  brightness: Brightness.dark,
  visualDensity: VisualDensity.compact,
  
  // Core colors
  colorScheme: FiftyColorScheme.dark(),  // See below
  
  // Surfaces
  scaffoldBackgroundColor: FiftyColors.darkBurgundy    (#1A0D0E)
  canvasColor: FiftyColors.darkBurgundy
  cardColor: FiftyColors.surfaceDark                   (#2A1517)
  
  // Typography
  textTheme: FiftyTextTheme.textTheme()      // Manrope
  primaryTextTheme: FiftyTextTheme.textTheme()
  fontFamily: GoogleFonts.manrope().fontFamily
  
  // Component themes (all 27 components configured)
  appBarTheme, elevatedButtonTheme, outlinedButtonTheme,
  textButtonTheme, cardTheme, inputDecorationTheme,
  dialogTheme, snackBarTheme, dividerTheme,
  checkboxTheme, radioTheme, switchTheme,
  bottomNavigationBarTheme, navigationRailTheme,
  tabBarTheme, floatingActionButtonTheme,
  chipTheme, progressIndicatorTheme, sliderTheme,
  tooltipTheme, popupMenuTheme, dropdownMenuTheme,
  bottomSheetTheme, drawerTheme, listTileTheme,
  iconTheme, scrollbarTheme,
  
  // Custom extension
  extensions: [FiftyThemeExtension.dark()]
)
```

#### ColorScheme.dark()

Maps to `Theme.of(context).colorScheme` for Material components:

```dart
ColorScheme(
  brightness: Brightness.dark,
  
  // Primary - Burgundy
  primary: FiftyColors.burgundy                    (#88292F)
  onPrimary: FiftyColors.cream
  primaryContainer: burgundy.withValues(alpha: 0.2)
  onPrimaryContainer: cream
  
  // Secondary - Slate Grey
  secondary: FiftyColors.slateGrey                 (#335C67)
  onSecondary: cream
  secondaryContainer: slateGrey.withValues(alpha: 0.2)
  onSecondaryContainer: cream
  
  // Tertiary - Hunter Green (SUCCESS)
  tertiary: FiftyColors.hunterGreen                (#4B644A)
  onTertiary: cream
  tertiaryContainer: hunterGreen.withValues(alpha: 0.2)
  onTertiaryContainer: hunterGreen
  
  // Error - Burgundy (consistent)
  error: FiftyColors.burgundy
  onError: cream
  errorContainer: burgundy.withValues(alpha: 0.2)
  onErrorContainer: cream
  
  // Surfaces - Dark Burgundy base
  surface: FiftyColors.darkBurgundy               (#1A0D0E)
  onSurface: cream
  surfaceContainerHighest: FiftyColors.surfaceDark (#2A1517)
  onSurfaceVariant: slateGrey
  
  // Outlines
  outline: FiftyColors.borderDark                 (white @ 5%)
  outlineVariant: Colors.white.withValues(alpha: 0.1)
  
  // Other
  shadow: Colors.black.withValues(alpha: 0.1)
  scrim: darkBurgundy.withValues(alpha: 0.8)
  inverseSurface: cream
  onInverseSurface: darkBurgundy
  inversePrimary: burgundy
)
```

#### FiftyThemeExtension

**Access via**: `Theme.of(context).extension<FiftyThemeExtension>()`

**Dark Mode Values**:
```dart
FiftyThemeExtension(
  // Colors (mode-aware)
  accent: FiftyColors.powderBlush              (#FFC9B9)
  success: FiftyColors.hunterGreen
  warning: FiftyColors.warning                 (#F7A100)
  info: FiftyColors.slateGrey
  
  // Shadows
  shadowSm: FiftyShadows.sm
  shadowMd: FiftyShadows.md
  shadowLg: FiftyShadows.lg
  shadowPrimary: FiftyShadows.primary
  shadowGlow: FiftyShadows.glow               (for dark mode accents)
  
  // Motion durations
  instant: Duration.zero
  fast: Duration(milliseconds: 150)
  compiling: Duration(milliseconds: 300)
  systemLoad: Duration(milliseconds: 800)
  
  // Curves
  standardCurve: Curves.easeInOut
  enterCurve: Curves.easeOut
  exitCurve: Curves.easeIn
)
```

---

### 3. fifty_ui - Pre-Built Components

**Location**: `/Users/m.elamin/StudioProjects/fifty_eco_system/packages/fifty_ui/lib/src/`

#### Available Components

**Buttons**:
- FiftyButton (primary CTA, variants: primary/secondary/tertiary, sizes: 36/48/56)
- FiftyIconButton (circular icon)
- FiftyLabeledIconButton (icon + label)

**Inputs**:
- FiftyTextField (48px height, xl radius)
- FiftySwitch (ON = slateGrey, NOT primary!)
- FiftySlider (range slider, mode-aware)
- FiftyDropdown (xl radius)
- FiftyCheckbox (v2 styling)
- FiftyRadio (v2 styling)
- FiftyRadioCard

**Containers**:
- FiftyCard
  - Sizes: standard (xxl/24px radius), hero (xxxl/32px radius)
  - Features: scanline on hover, halftone texture, hover scale, selected state
  - Shadow: md by default, glow when selected
  - Example: `/Users/m.elamin/StudioProjects/fifty_eco_system/packages/fifty_ui/lib/src/containers/fifty_card.dart`

**Display**:
- FiftyBadge (5 variants: primary/success/warning/error/neutral, factories: .tech(), .status(), .ai())
- FiftyStatusIndicator (states: ready/loading/error/offline/idle, sizes: small/medium/large)
- FiftyProgressBar (with optional label + percentage)
- FiftyStatCard (metric/KPI with trend indicators)
- FiftyChip, FiftyAvatar, FiftySectionHeader, FiftyListTile, FiftyLoadingIndicator
- FiftyDataSlate, FiftyInfoRow, FiftySettingsRow
- FiftyDivider (themed)
- FiftyProgressCard

**Feedback**:
- FiftySnackbar
- FiftyDialog (xxxl radius)
- FiftyTooltip

**Controls** (NEW in v2):
- FiftySegmentedControl (pill-style)
- FiftyNavPill

**Organisms**:
- FiftyNavBar (floating nav with glassmorphism)
- FiftyHero (dramatic headline text)

**Molecules**:
- FiftyCodeBlock (syntax highlighting)

**Utilities**:
- GlowContainer (reusable glow animation)
- KineticEffect (hover/press scale animation)
- GlitchEffect (RGB chromatic aberration)
- HalftonePainter (halftone dot patterns)

---

## How Theme.of(context) Works

### In Crimson Arena

From `main.dart`:
```dart
MaterialApp(
  theme: FiftyTheme.dark(),      // ← Sets up complete ThemeData
  darkTheme: FiftyTheme.dark(),
  themeMode: ThemeMode.dark,
)
```

### Accessing Properties

#### Via ColorScheme
```dart
final colorScheme = Theme.of(context).colorScheme;

// Common properties
colorScheme.primary                     // Burgundy (#88292F)
colorScheme.secondary                  // Slate Grey (#335C67)
colorScheme.tertiary                   // Hunter Green (#4B644A)
colorScheme.surface                    // Dark Burgundy (#1A0D0E)
colorScheme.surfaceContainerHighest    // Surface Dark (#2A1517)
colorScheme.onSurface                  // Cream (#FEFEE3)
colorScheme.onSurfaceVariant           // Slate Grey
colorScheme.outline                    // White @ 5%
colorScheme.error                      // Burgundy
```

#### Via FiftyThemeExtension
```dart
final theme = Theme.of(context);
final fifty = theme.extension<FiftyThemeExtension>()!;

// Custom properties
fifty.accent              // Powder Blush in dark mode (#FFC9B9)
fifty.success             // Hunter Green
fifty.warning             // #F7A100
fifty.info                // Slate Grey
fifty.shadowSm            // List<BoxShadow>
fifty.shadowMd
fifty.shadowGlow
fifty.fast                // Duration(milliseconds: 150)
fifty.standardCurve       // Curves.easeInOut
```

#### Via TextTheme
```dart
final textTheme = Theme.of(context).textTheme;

// All styles use Manrope via google_fonts
textTheme.displayLarge    // 32px, extraBold
textTheme.displayMedium   // 24px, extraBold
textTheme.titleLarge      // 20px, bold
textTheme.bodyMedium      // 14px, regular
textTheme.labelSmall      // 10px, semiBold
```

---

## Current ArenaCard Implementation

**Location**: `/Users/m.elamin/StudioProjects/igris-ai/dashboard/crimson-arena/lib/shared/widgets/arena_card.dart`

```dart
Container(
  decoration: BoxDecoration(
    color: FiftyColors.surfaceDark,         // #2A1517
    borderRadius: FiftyRadii.lgRadius,      // 12px
    border: Border.all(
      color: FiftyColors.borderDark,        // White @ 5%
      width: 1,
    ),
  ),
  child: Padding(
    padding: const EdgeInsets.all(FiftySpacing.md),  // 12px
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (title != null) Row(...),
        child,
      ],
    ),
  ),
);
```

**Comparison with FiftyCard**:
- ArenaCard: Manual, lg radius (12px), no shadow, static styling
- FiftyCard: Comprehensive, xxl radius (24px), md shadow by default, scanline on hover, selected state, glow, texture overlay, interactive

---

## Key Design Principles (FDL v2)

1. **Dark Mode Primary** - No light mode unless accessibility required
2. **Burgundy Accents** - Brand color for primary actions and focus states
3. **Compact Density** - Tight 4px grid, dense layouts (sm=8px tight gap, md=12px standard gap)
4. **Soft Shadows** - Subtle depth enabled in v2 (sm/md/lg/primary/glow)
5. **Manrope Unified** - Single font family for all sizes (replaces Monument/JetBrains binary system)
6. **Mode-Aware Colors** - Theme extension provides accent, success, warning, info per mode
7. **No Fades** - Kinetic slide transitions only (FDL rule)
8. **Scanline on Hover** - Cards show animated scanline effect on hover
9. **Interactive Feedback** - Hover scale, ripple effects, glow animations
10. **Accessibility** - WCAG 2.1 AA compliant, proper contrast, semantic colors

---

## Token Usage by Component Category

### Buttons (ElevatedButtonTheme)
```
backgroundColor: burgundy
foregroundColor: cream
elevation: 0
padding: EdgeInsets.symmetric(horizontal: lg=16, vertical: md=12)
shape: RoundedRectangleBorder(borderRadius: xlRadius=16)
textStyle: labelLarge (14px, bold)
overlay: cream @ 10-20% on hover/press
```

### Cards (CardTheme via ColorScheme)
```
color: surfaceContainerHighest (surfaceDark #2A1517)
elevation: 0
shape: RoundedRectangleBorder(borderRadius: xxlRadius=24, side: outline)
margin: zero
```

### Text Fields (InputDecorationTheme)
```
filled: true
fillColor: surfaceDark (dark mode)
contentPadding: EdgeInsets.symmetric(horizontal: lg=16, vertical: md=12)
border: OutlineInputBorder(borderRadius: xlRadius=16)
focusedBorder: 2px burgundy
hintStyle: bodyMedium (14px, regular), slateGrey
labelStyle: bodyMedium, slateGrey
floatingLabelStyle: bodyMedium, medium, burgundy
```

### Dialogs (DialogTheme)
```
backgroundColor: surfaceDark
elevation: 0
shape: RoundedRectangleBorder(borderRadius: xxxlRadius=32, side: outline)
titleTextStyle: titleLarge (20px, bold), cream
contentTextStyle: bodyLarge (16px, medium), cream
```

### Progress Indicators
```
color: burgundy (primary)
linearTrackColor: surfaceDark
circularTrackColor: surfaceDark
```

### Badges (Custom - not Material)
```
Variants: primary/success/warning/error/neutral
Pill shape: fullRadius (9999px)
Border: 1px, accent color
Background: accent @ 20%
Text: labelSmall (10px, medium), uppercase
Optional glow: accent @ 40% shadow with 8px blur
```

### Status Indicators (Custom)
```
Dot sizes: 6px (small), 8px (medium), 10px (large)
States: ready (success), loading (warning), error, offline (outline), idle (outline)
Text: bodySmall-bodyLarge per size
Layout: Row (dot + label + optional status text)
```

### Progress Bar (Custom)
```
Height: 8px (default, customizable)
Track: surfaceContainerHighest
Fill: primary (burgundy)
Border: 1px outline
Optional label: bodySmall, uppercase
Optional percentage: bodySmall
Animation: fast (150ms) on value change
```

---

## Token Reference Summary

### Colors
```
Primary:       burgundy (#88292F)
Secondary:     slateGrey (#335C67)
Success:       hunterGreen (#4B644A)
Warning:       #F7A100
Error:         burgundy
Accent (dark): powderBlush (#FFC9B9)
Background:    darkBurgundy (#1A0D0E)
Surface:       surfaceDark (#2A1517)
Text:          cream (#FEFEE3)
Border:        white @ 5%
```

### Spacing
```
xs:      4px
sm:      8px   ← tight gap
md:      12px  ← standard gap
lg:      16px  ← buttons, cards, padding
xl:      20px
xxl:     24px  ← sections
xxxl:    32px  ← major sections
huge:    40px
massive: 48px
```

### Radii
```
sm:      4px   (checkboxes)
md:      8px   (chips)
lg:      12px  (legacy cards)
xl:      16px  (buttons, inputs)
xxl:     24px  (standard cards)
xxxl:    32px  (hero cards, modals)
full:    9999px (pills, badges)
```

### Typography
```
Font:        Manrope (google_fonts)
Weights:     400, 500, 600, 700, 800
Display:     32px (800), 24px (800)
Title:       20px (700), 18px (700), 16px (700)
Body:        16px (500), 14px (400), 12px (400)
Label:       14px (700), 12px (700), 10px (600)
Line height: Display 1.2, Title 1.3, Body 1.5, Label 1.2
```

### Shadows
```
sm:      0 1px 2px rgba(0,0,0,0.05)
md:      0 4px 6px rgba(0,0,0,0.07)        ← cards
lg:      0 10px 15px rgba(0,0,0,0.1)
primary: 0 4px 14px rgba(burgundy,0.2)    ← buttons
glow:    0 0 15px rgba(cream,0.1)         ← dark mode focus
```

### Motion
```
instant:   0ms
fast:      150ms    ← hover transitions
compiling: 300ms    ← scanline sweep
systemLoad: 800ms   ← long animations
Curves:    standard, enter, exit
```

---

## How to Use in New Components

### 1. Access Theme
```dart
final theme = Theme.of(context);
final fifty = theme.extension<FiftyThemeExtension>();
final colorScheme = theme.colorScheme;
```

### 2. Color Selection
```dart
// Primary actions
color: colorScheme.primary                 // Burgundy

// Secondary/neutral
color: colorScheme.onSurfaceVariant        // Slate Grey

// Success
color: fifty?.success ?? FiftyColors.hunterGreen

// Text
color: colorScheme.onSurface               // Cream

// Borders
color: colorScheme.outline                 // White @ 5%

// Disabled/muted
color: colorScheme.onSurface.withValues(alpha: 0.5)
```

### 3. Spacing
```dart
// Standard padding
padding: const EdgeInsets.all(FiftySpacing.lg)              // 16px

// Tight layout
spacing: FiftySpacing.sm                                     // 8px

// Card internal
padding: const EdgeInsets.symmetric(
  horizontal: FiftySpacing.lg,    // 16px
  vertical: FiftySpacing.md,      // 12px
)

// Components
gap: FiftySpacing.sm,                                        // 8px
```

### 4. Border Radius
```dart
// Buttons, inputs
borderRadius: FiftyRadii.xlRadius                            // 16px

// Standard cards
borderRadius: FiftyRadii.xxlRadius                           // 24px

// Hero/modal
borderRadius: FiftyRadii.xxxlRadius                          // 32px

// Pills/badges
borderRadius: FiftyRadii.fullRadius                          // 9999px
```

### 5. Shadows
```dart
// Cards
boxShadow: FiftyShadows.md

// Hover/subtle
boxShadow: FiftyShadows.sm

// Modals/prominence
boxShadow: FiftyShadows.lg

// Custom glow
boxShadow: fifty?.shadowGlow
```

### 6. Typography
```dart
// Headings
style: theme.textTheme.titleLarge            // 20px, bold

// Body
style: theme.textTheme.bodyMedium            // 14px, regular

// Labels (manual for Manrope)
style: TextStyle(
  fontFamily: FiftyTypography.fontFamily,
  fontSize: FiftyTypography.labelMedium,
  fontWeight: FiftyTypography.bold,
  letterSpacing: FiftyTypography.letterSpacingLabelMedium,
)
```

### 7. Animation
```dart
// Smooth transitions
AnimatedContainer(
  duration: fifty.fast,                      // 150ms
  curve: fifty.standardCurve,
  // ...
)

// Scanline sweep
duration: FiftyMotion.compiling              // 300ms
```

---

## Summary: What's Available via Theme.of(context)

| Access Path | Available Properties |
|---|---|
| `colorScheme.primary` | Burgundy (#88292F) |
| `colorScheme.secondary` | Slate Grey (#335C67) |
| `colorScheme.tertiary` | Hunter Green (#4B644A) |
| `colorScheme.surface` | Dark Burgundy (#1A0D0E) |
| `colorScheme.surfaceContainerHighest` | Surface Dark (#2A1517) |
| `colorScheme.onSurface` | Cream (#FEFEE3) |
| `colorScheme.onSurfaceVariant` | Slate Grey |
| `colorScheme.outline` | White @ 5% |
| `colorScheme.error` | Burgundy |
| `extension<FiftyThemeExtension>().accent` | Powder Blush (#FFC9B9) |
| `extension<FiftyThemeExtension>().success` | Hunter Green |
| `extension<FiftyThemeExtension>().warning` | #F7A100 |
| `extension<FiftyThemeExtension>().shadowMd` | List<BoxShadow> |
| `extension<FiftyThemeExtension>().fast` | Duration(150ms) |
| `extension<FiftyThemeExtension>().standardCurve` | Curves.easeInOut |
| `textTheme.titleLarge` | 20px, bold, Manrope |
| `textTheme.bodyMedium` | 14px, regular, Manrope |
| `textTheme.labelSmall` | 10px, semiBold, Manrope |

All token values are also directly accessible via:
- `FiftyColors.*` (color constants)
- `FiftySpacing.*` (4px grid)
- `FiftyRadii.*` (border radius values)
- `FiftyTypography.*` (font sizes, weights)
- `FiftyShadows.*` (shadow definitions)
- `FiftyMotion.*` (durations and curves)

