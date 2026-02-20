# FDL v2 Theme Quick Reference

## File Locations

| File | Purpose |
|---|---|
| `fifty_tokens/lib/src/colors.dart` | Color definitions |
| `fifty_tokens/lib/src/typography.dart` | Font sizes, weights |
| `fifty_tokens/lib/src/spacing.dart` | Spacing grid (4px base) |
| `fifty_tokens/lib/src/radii.dart` | Border radius values |
| `fifty_tokens/lib/src/shadows.dart` | Shadow definitions |
| `fifty_theme/lib/src/fifty_theme_data.dart` | Main theme builder |
| `fifty_theme/lib/src/color_scheme.dart` | ColorScheme mappings |
| `fifty_theme/lib/src/component_themes.dart` | Material component styling |
| `fifty_theme/lib/src/theme_extensions.dart` | FiftyThemeExtension |
| `fifty_ui/lib/fifty_ui.dart` | Component library |

## Access Patterns

### Pattern 1: Get Theme in Widget
```dart
@override
Widget build(BuildContext context) {
  final theme = Theme.of(context);
  final colorScheme = theme.colorScheme;
  final fifty = theme.extension<FiftyThemeExtension>()!;
  
  // Now use...
}
```

### Pattern 2: Use Colors
```dart
// Primary action
color: colorScheme.primary,                    // Burgundy

// Secondary action
color: colorScheme.onSurfaceVariant,          // Slate Grey

// Success/positive
color: fifty.success,                          // Hunter Green

// Text on dark
color: colorScheme.onSurface,                 // Cream

// Borders
color: colorScheme.outline,                   // White @ 5%

// Disabled
color: colorScheme.onSurface.withValues(alpha: 0.5)
```

### Pattern 3: Use Spacing
```dart
// Card padding
padding: const EdgeInsets.all(FiftySpacing.lg)     // 16px

// Element gap
gap: FiftySpacing.sm,                              // 8px

// Vertical spacing
height: FiftySpacing.xxl,                          // 24px

// Responsive
EdgeInsets.symmetric(
  horizontal: FiftySpacing.lg,    // 16px
  vertical: FiftySpacing.md,      // 12px
)
```

### Pattern 4: Use Border Radius
```dart
// Buttons, inputs
borderRadius: FiftyRadii.xlRadius,             // 16px

// Cards
borderRadius: FiftyRadii.xxlRadius,            // 24px

// Modals
borderRadius: FiftyRadii.xxxlRadius,           // 32px

// Pills/badges
borderRadius: FiftyRadii.fullRadius,           // 9999px (circle)
```

### Pattern 5: Use Typography
```dart
// From TextTheme
style: theme.textTheme.titleLarge,             // 20px, bold

style: theme.textTheme.bodyMedium,             // 14px, regular

style: theme.textTheme.labelSmall,             // 10px, semiBold

// Manual (for custom combinations)
TextStyle(
  fontFamily: FiftyTypography.fontFamily,      // Manrope
  fontSize: FiftyTypography.bodyLarge,         // 16px
  fontWeight: FiftyTypography.bold,            // 700
  color: colorScheme.onSurface,                // Cream
  letterSpacing: FiftyTypography.letterSpacingLabel,
)
```

### Pattern 6: Use Shadows
```dart
// Card shadow
boxShadow: FiftyShadows.md,

// Hover shadow
boxShadow: FiftyShadows.sm,

// Modal shadow
boxShadow: FiftyShadows.lg,

// Glow on selected
boxShadow: fifty.shadowGlow,

// No shadow
boxShadow: const []  // or FiftyShadows.none
```

### Pattern 7: Use Animation
```dart
AnimatedContainer(
  duration: fifty.fast,                        // 150ms
  curve: fifty.standardCurve,                  // Curves.easeInOut
  // properties...
)

// For scanline sweep
AnimationController(
  duration: FiftyMotion.compiling,             // 300ms
  vsync: this,
)
```

## Common Component Patterns

### Button
```dart
ElevatedButton(
  onPressed: () {},
  child: Text(
    'DEPLOY',
    style: TextStyle(
      fontFamily: FiftyTypography.fontFamily,
      fontSize: FiftyTypography.labelLarge,
      fontWeight: FiftyTypography.bold,
    ),
  ),
)
// Uses theme's elevatedButtonTheme (burgundy bg, cream text, xl radius)
```

### Card Container
```dart
Container(
  decoration: BoxDecoration(
    color: colorScheme.surfaceContainerHighest,    // surfaceDark
    borderRadius: FiftyRadii.xxlRadius,            // 24px
    border: Border.all(
      color: colorScheme.outline,                  // white @ 5%
      width: 1,
    ),
    boxShadow: FiftyShadows.md,
  ),
  padding: const EdgeInsets.all(FiftySpacing.lg),  // 16px
  child: YourContent(),
)
```

### TextField
```dart
TextField(
  decoration: InputDecoration(
    hintText: 'Enter value',
    hintStyle: TextStyle(
      fontSize: FiftyTypography.bodyMedium,
      color: FiftyColors.slateGrey,
    ),
    border: OutlineInputBorder(
      borderRadius: FiftyRadii.xlRadius,           // 16px
      borderSide: BorderSide(color: colorScheme.outline),
    ),
    focusedBorder: OutlineInputBorder(
      borderRadius: FiftyRadii.xlRadius,
      borderSide: BorderSide(
        color: colorScheme.primary,                // Burgundy
        width: 2,
      ),
    ),
    contentPadding: EdgeInsets.symmetric(
      horizontal: FiftySpacing.lg,                 // 16px
      vertical: FiftySpacing.md,                   // 12px
    ),
  ),
)
// Note: InputDecorationTheme already configured in theme
```

### Badge
```dart
Container(
  padding: const EdgeInsets.symmetric(
    horizontal: FiftySpacing.sm,                   // 8px
    vertical: FiftySpacing.xs / 2,                 // 2px
  ),
  decoration: BoxDecoration(
    color: fifty.success.withValues(alpha: 0.2),  // Green @ 20%
    borderRadius: FiftyRadii.fullRadius,           // Pill shape
    border: Border.all(
      color: fifty.success,                        // Green
      width: 1,
    ),
  ),
  child: Text(
    'READY',
    style: TextStyle(
      fontFamily: FiftyTypography.fontFamily,
      fontSize: FiftyTypography.labelSmall,        // 10px
      fontWeight: FiftyTypography.semiBold,        // 600
      color: fifty.success,
    ),
  ),
)
```

### Status Indicator
```dart
Row(
  mainAxisSize: MainAxisSize.min,
  children: [
    Container(
      width: 8,  // medium size
      height: 8,
      decoration: BoxDecoration(
        color: fifty.success,                      // Ready = green
        shape: BoxShape.circle,
      ),
    ),
    const SizedBox(width: FiftySpacing.xs),        // 4px gap
    Text(
      'Database',
      style: TextStyle(
        fontSize: FiftyTypography.bodyMedium,
        color: colorScheme.onSurface,
      ),
    ),
    const SizedBox(width: FiftySpacing.xs),
    Text(
      '[READY]',
      style: TextStyle(
        fontSize: FiftyTypography.bodyMedium,
        color: fifty.success,
      ),
    ),
  ],
)
```

### Progress Bar
```dart
Column(
  crossAxisAlignment: CrossAxisAlignment.start,
  children: [
    Row(
      mainAxisAlignment: MainAxisAlignment.spaceBetween,
      children: [
        Text(
          'UPLOADING',
          style: TextStyle(
            fontFamily: FiftyTypography.fontFamily,
            fontSize: FiftyTypography.bodySmall,
            fontWeight: FiftyTypography.medium,
            color: colorScheme.onSurfaceVariant,
          ),
        ),
        Text(
          '65%',
          style: TextStyle(
            fontSize: FiftyTypography.bodySmall,
            color: colorScheme.onSurface,
          ),
        ),
      ],
    ),
    const SizedBox(height: FiftySpacing.sm),       // 8px
    Container(
      height: 8,
      decoration: BoxDecoration(
        color: colorScheme.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(4),
        border: Border.all(color: colorScheme.outline),
      ),
      child: LayoutBuilder(
        builder: (context, constraints) {
          return AnimatedContainer(
            duration: fifty.fast,                   // 150ms
            width: constraints.maxWidth * 0.65,
            height: 8,
            decoration: BoxDecoration(
              color: colorScheme.primary,           // Burgundy
              borderRadius: BorderRadius.circular(4),
            ),
          );
        },
      ),
    ),
  ],
)
```

## Color Quick Lookup

```
Need:           Use:
Primary action  colorScheme.primary             (Burgundy #88292F)
Secondary       colorScheme.onSurfaceVariant    (Slate Grey #335C67)
Success         fifty.success                   (Hunter Green #4B644A)
Warning         fifty.warning                   (#F7A100)
Error/danger    colorScheme.error               (Burgundy)
Text (dark)     colorScheme.onSurface           (Cream #FEFEE3)
Background      colorScheme.surface             (Dark Burgundy #1A0D0E)
Card surface    colorScheme.surfaceContainerHighest (Surface Dark #2A1517)
Borders         colorScheme.outline             (White @ 5%)
Muted text      colorScheme.onSurfaceVariant    (Slate Grey)
Disabled        colorScheme.onSurface @ 50%
Accent (dark)   fifty.accent                    (Powder Blush #FFC9B9)
```

## Spacing Quick Lookup

```
Use:           Value:
Minimal        FiftySpacing.xs         (4px)
Tight gap      FiftySpacing.sm         (8px)   ← Between elements
Standard gap   FiftySpacing.md         (12px)  ← Card padding
Comfortable    FiftySpacing.lg         (16px)  ← Default padding
Generous       FiftySpacing.xl         (20px)
Section        FiftySpacing.xxl        (24px)  ← Between sections
Major section  FiftySpacing.xxxl       (32px)
Hero           FiftySpacing.huge       (40px)
Page           FiftySpacing.massive    (48px)
```

## Radius Quick Lookup

```
Use:            Value:
Checkboxes      FiftyRadii.sm          (4px)
Chips           FiftyRadii.md          (8px)
Legacy inputs   FiftyRadii.lg          (12px)
Buttons/inputs  FiftyRadii.xl          (16px)  ← MOST COMMON
Cards           FiftyRadii.xxl         (24px)
Hero/modal      FiftyRadii.xxxl        (32px)
Pills/badges    FiftyRadii.full        (9999px)
```

## Shadow Quick Lookup

```
Use:            Value:
Hover/subtle    FiftyShadows.sm        (0 1px 2px, 5%)
Cards           FiftyShadows.md        (0 4px 6px, 7%)  ← DEFAULT
Modals/menus    FiftyShadows.lg        (0 10px 15px, 10%)
Buttons         FiftyShadows.primary   (0 4px 14px, burgundy 20%)
Focus glow      fifty.shadowGlow       (0 0 15px, cream 10%)
None            FiftyShadows.none      (empty list)
```

## Duration Quick Lookup

```
Use:            Value:
Instant         Duration.zero           (0ms)
Fast (hover)    fifty.fast              (150ms)
Standard        FiftyMotion.compiling   (300ms)
Slow            FiftyMotion.systemLoad  (800ms)
```

## Font Weight Quick Lookup

```
Use:            Value:
Body text       FiftyTypography.regular         (400)
Body emphasis   FiftyTypography.medium         (500)
Small labels    FiftyTypography.semiBold       (600)
Titles/labels   FiftyTypography.bold           (700)
Display         FiftyTypography.extraBold      (800)
```

## Font Size Quick Lookup

```
Use:            Size:       Weight:
Hero headline   32px        800
Section head    24px        800
Card title      20px        700
App bar title   18px        700
List item       16px        700
Body large      16px        500
Body medium     14px        400 ← MOST COMMON
Body small      12px        400
Label large     14px        700
Label medium    12px        700 ← UPPERCASE
Label small     10px        600
```

---

## When to Use FiftyCard vs ArenaCard

**Use FiftyCard if you need:**
- Hover interactions (scanline effect)
- Selected state with glow
- Texture overlay (halftone)
- Automatic shadow management
- Interactive ripple/tap
- Standard Material behavior

**Use ArenaCard if you need:**
- Simple, static card styling
- Quick implementation
- No interactive state
- Minimal overhead

**Recommendation:** Use FiftyCard for most new components. ArenaCard exists for backward compatibility.

---

## Dependencies to Import

```dart
// For tokens
import 'package:fifty_tokens/fifty_tokens.dart';

// For theme
import 'package:fifty_theme/fifty_theme.dart';

// For components
import 'package:fifty_ui/fifty_ui.dart';

// For Google Fonts (used by theme)
import 'package:google_fonts/google_fonts.dart';

// For Flutter Material
import 'package:flutter/material.dart';
```

