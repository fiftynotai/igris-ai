# 🔥 Igris Desktop - Quick Start Guide

**Project Created:** `/Users/m.elamin/StudioProjects/igris_desktop`
**Tech Stack:** Flutter + Dart
**Design System:** FDL v1.0
**Platforms:** macOS, Windows, Linux

---

## 🚀 **Immediate Next Steps**

### **1. Navigate to Project**
```bash
cd /Users/m.elamin/StudioProjects/igris_desktop
```

### **2. Update Dependencies**
Edit `pubspec.yaml` and add FDL requirements:

```yaml
dependencies:
  flutter:
    sdk: flutter

  # UI & Fonts
  google_fonts: ^6.1.0
  flutter_svg: ^2.0.9

  # State Management
  provider: ^6.1.1

  # File System
  path_provider: ^2.1.1
  path: ^1.8.3

  # Data Parsing
  markdown: ^7.1.1
  yaml: ^3.1.2

  # Window Control
  window_manager: ^0.3.7

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0
```

Then run:
```bash
flutter pub get
```

### **3. Create FDL Theme System**

Create these files:

**`lib/core/theme/fdl_colors.dart`:**
```dart
import 'package:flutter/material.dart';

class FDLColors {
  // Brand
  static const crimson = Color(0xFF960E29);
  static const techCrimson = Color(0xFFB31337);

  // Surfaces
  static const surface0 = Color(0xFF0E0E0F);
  static const surface1 = Color(0xFF161617);
  static const surface2 = Color(0xFF1D1D1F);

  // Text
  static const textPrimary = Color(0xFFFFFFFF);
  static const textSecondary = Color(0xFFE5E5E7);
  static const textMuted = Color(0xFF9E9EA0);

  // Borders
  static const border = Color(0xFF2C2C2E);
  static const divider = Color(0xFF3A3A3C);

  // States
  static const success = Color(0xFF00BA33);
  static const warning = Color(0xFFF7A100);
  static const error = Color(0xFFB31337);
}
```

**`lib/core/theme/fdl_theme.dart`:**
```dart
import 'package:flutter/material.dart';
import 'fdl_colors.dart';

class FDLTheme {
  static ThemeData darkTheme() {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: FDLColors.surface0,
      colorScheme: ColorScheme.dark(
        primary: FDLColors.crimson,
        secondary: FDLColors.techCrimson,
        surface: FDLColors.surface1,
        background: FDLColors.surface0,
        error: FDLColors.error,
      ),
      textTheme: TextTheme(
        displayLarge: TextStyle(
          fontSize: 48,
          fontWeight: FontWeight.w700,
          color: FDLColors.textPrimary,
        ),
        headlineLarge: TextStyle(
          fontSize: 32,
          fontWeight: FontWeight.w600,
          color: FDLColors.textPrimary,
        ),
        bodyLarge: TextStyle(
          fontSize: 16,
          color: FDLColors.textSecondary,
        ),
        bodySmall: TextStyle(
          fontSize: 14,
          color: FDLColors.textSecondary,
        ),
      ),
    );
  }
}
```

### **4. Update Main App**

Replace `lib/main.dart`:

```dart
import 'package:flutter/material.dart';
import 'core/theme/fdl_theme.dart';

void main() {
  runApp(const IgrisApp());
}

class IgrisApp extends StatelessWidget {
  const IgrisApp({super.key});

  @override
  Widget build(BuildContext context) {
    return MaterialApp(
      title: 'Igris AI - Desktop',
      theme: FDLTheme.darkTheme(),
      home: const DashboardView(),
    );
  }
}

class DashboardView extends StatelessWidget {
  const DashboardView({super.key});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      body: Center(
        child: Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Text(
              'Igris AI',
              style: Theme.of(context).textTheme.displayLarge,
            ),
            const SizedBox(height: 16),
            Text(
              'Building systems that build things.',
              style: Theme.of(context).textTheme.bodyLarge,
            ),
            const SizedBox(height: 32),
            ElevatedButton(
              onPressed: () {},
              style: ElevatedButton.styleFrom(
                backgroundColor: FDLColors.crimson,
                padding: const EdgeInsets.symmetric(
                  horizontal: 24,
                  vertical: 12,
                ),
              ),
              child: const Text('Get Started'),
            ),
          ],
        ),
      ),
    );
  }
}
```

### **5. Run the App**

```bash
# For macOS:
flutter run -d macos

# For Windows:
flutter run -d windows

# For Linux:
flutter run -d linux
```

---

## 📐 **Project Structure**

```
igris_desktop/
├── lib/
│   ├── main.dart                    # Entry point
│   ├── core/
│   │   └── theme/
│   │       ├── fdl_colors.dart      # Color system
│   │       ├── fdl_theme.dart       # Theme config
│   │       └── fdl_typography.dart  # Typography (next)
│   ├── features/
│   │   ├── dashboard/
│   │   ├── briefs/
│   │   └── sessions/
│   └── shared/
│       └── widgets/
└── assets/
    ├── fonts/                       # Download FDL fonts
    └── images/
```

---

## 🎨 **Download FDL Fonts**

### **Required Fonts:**
1. **Space Grotesk** - https://fonts.google.com/specimen/Space+Grotesk
2. **Inter** - https://fonts.google.com/specimen/Inter
3. **JetBrains Mono** - https://www.jetbrains.com/lp/mono/

### **Installation:**
```bash
# Create fonts directory
mkdir -p assets/fonts

# Download and extract fonts to:
# assets/fonts/SpaceGrotesk/
# assets/fonts/Inter/
# assets/fonts/JetBrainsMono/
```

Add to `pubspec.yaml`:
```yaml
flutter:
  fonts:
    - family: SpaceGrotesk
      fonts:
        - asset: assets/fonts/SpaceGrotesk/SpaceGrotesk-Regular.ttf
        - asset: assets/fonts/SpaceGrotesk/SpaceGrotesk-Bold.ttf
          weight: 700

    - family: Inter
      fonts:
        - asset: assets/fonts/Inter/Inter-Regular.ttf
        - asset: assets/fonts/Inter/Inter-SemiBold.ttf
          weight: 600

    - family: JetBrainsMono
      fonts:
        - asset: assets/fonts/JetBrainsMono/JetBrainsMono-Regular.ttf
```

---

## 🔗 **Link to Igris AI Repository**

The desktop app will read/write from the Igris AI CLI repository:

**Project Path:** `/Users/m.elamin/StudioProjects/igris-ai`

**Data Sources:**
- Brain DB via MCP tools (`igris_brief_get`/`igris_brief_list`) - Briefs (filesystem: `~/.igris/projects/{project}/briefs/`)
- `~/.igris/projects/{project}/session/CURRENT_SESSION.md` - Session tracking
- `~/.igris/projects/{project}/context/coding_guidelines.md` - Architecture
- `SOUL.md` - Persona identity

---

## 🚀 **Development Workflow**

### **Phase 1: Foundation (Current)**
- [x] Create Flutter project
- [ ] Implement FDL theme
- [ ] Basic navigation
- [ ] File system access

### **Phase 2: Dashboard**
- [ ] Metrics cards
- [ ] Brief status overview
- [ ] Session info
- [ ] Quick actions

### **Phase 3: Brief Manager**
- [ ] List all briefs
- [ ] Filter/search
- [ ] Brief detail view
- [ ] Create/edit briefs

### **Phase 4: Advanced**
- [ ] Command palette (CMD+K)
- [ ] Settings
- [ ] AI integration
- [ ] Git operations

---

## 🎯 **Test the Initial App**

```bash
cd /Users/m.elamin/StudioProjects/igris_desktop

# Run on macOS
flutter run -d macos
```

You should see:
- Dark background (#0E0E0F)
- "Igris AI" in white
- "Building systems that build things" subtitle
- Crimson "Get Started" button

---

## 📚 **Resources**

- **Architecture:** `/Users/m.elamin/StudioProjects/igris-ai/docs/IGRIS_UI_ARCHITECTURE.md`
- **FDL Spec:** Fifty Design Language documentation
- **Flutter Docs:** https://docs.flutter.dev/
- **Material 3:** https://m3.material.io/

---

🔥 **Igris Desktop is ready to build, Partner!** 🐒⚡

**Next:** Implement the FDL theme, then start building the dashboard! 🚀
