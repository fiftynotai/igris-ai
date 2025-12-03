# 🔥 Igris UI - Desktop Application Architecture

**Version:** 1.0
**Tech Stack:** Flutter (Dart)
**Design System:** Fifty Design Language (FDL) v1.0
**Target:** macOS, Windows, Linux Desktop

---

## 🎯 **Vision**

> **"A command line turned into a design language."**

Build a **full-featured desktop application** for Igris AI that:
- Implements **FDL design system** perfectly
- Manages **briefs, sessions, architecture** visually
- Integrates with **Claude Code CLI** and **AI workflows**
- Provides **dashboard, editor, command palette, settings**
- Maintains **dark mode first, crimson identity**

---

## 📐 **Application Structure**

### **Core Views:**

```
Igris Desktop App
├── Command Palette (CMD+K)        - Global quick actions
├── Dashboard (Home)               - Overview, metrics, status
├── Brief Manager                  - BR/TD/MG/TS list, filter, edit
├── Session Tracker                - Current session, history, resume
├── Architecture View              - Coding guidelines, patterns, map
├── AI Insights                    - LangChain/LangGraph outputs
├── Settings                       - Preferences, themes, integrations
└── Blueprint (Workflows)          - Public AI workflows, templates
```

---

## 🎨 **FDL Implementation in Flutter**

### **Package Structure:**

```
igris_desktop/
├── lib/
│   ├── main.dart                  - Entry point
│   ├── app.dart                   - Root app with FDL theme
│   ├── core/
│   │   ├── theme/
│   │   │   ├── fdl_theme.dart     - FDL color system
│   │   │   ├── fdl_typography.dart - Space Grotesk, Inter, JetBrains
│   │   │   └── fdl_components.dart - Buttons, cards, inputs
│   │   ├── constants/
│   │   │   ├── colors.dart        - FDL color tokens
│   │   │   ├── spacing.dart       - 8px system
│   │   │   └── animations.dart    - Motion system
│   │   └── utils/
│   ├── features/
│   │   ├── dashboard/
│   │   ├── briefs/
│   │   ├── sessions/
│   │   ├── architecture/
│   │   ├── ai_insights/
│   │   ├── settings/
│   │   └── command_palette/
│   ├── data/
│   │   ├── models/               - Brief, Session, Decision models
│   │   ├── repositories/         - File system access
│   │   └── services/             - Git, AI integration
│   └── shared/
│       └── widgets/              - Reusable FDL components
├── assets/
│   ├── fonts/
│   │   ├── SpaceGrotesk/
│   │   ├── Inter/
│   │   └── JetBrainsMono/
│   └── images/
│       └── crimson_agumon.png
└── pubspec.yaml
```

---

## 🎨 **FDL Color System (Flutter)**

```dart
// lib/core/theme/fdl_colors.dart

class FDLColors {
  // Brand Colors
  static const crimson = Color(0xFF960E29);       // #960E29
  static const techCrimson = Color(0xFFB31337);   // #B31337

  // Surface Hierarchy
  static const surface0 = Color(0xFF0E0E0F);      // Background
  static const surface1 = Color(0xFF161617);      // Card base
  static const surface2 = Color(0xFF1D1D1F);      // Panel
  static const surface3 = Color(0x08FFFFFF);      // rgba(255,255,255,0.03)

  // Text Hierarchy
  static const textPrimary = Color(0xFFFFFFFF);   // White
  static const textSecondary = Color(0xFFE5E5E7); // Gray
  static const textMuted = Color(0xFF9E9EA0);     // Subtle

  // Borders & Dividers
  static const border = Color(0xFF2C2C2E);
  static const divider = Color(0xFF3A3A3C);

  // States
  static const success = Color(0xFF00BA33);
  static const warning = Color(0xFFF7A100);
  static const error = Color(0xFFB31337);          // Uses tech crimson
}
```

---

## 🎨 **FDL Typography System (Flutter)**

```dart
// lib/core/theme/fdl_typography.dart

class FDLTypography {
  // Headings - Space Grotesk
  static const displayXL = TextStyle(
    fontFamily: 'SpaceGrotesk',
    fontSize: 48,
    fontWeight: FontWeight.w700,
    letterSpacing: -0.5,
    color: FDLColors.textPrimary,
  );

  static const h1 = TextStyle(
    fontFamily: 'SpaceGrotesk',
    fontSize: 32,
    fontWeight: FontWeight.w600,
    letterSpacing: -0.5,
    color: FDLColors.textPrimary,
  );

  static const h2 = TextStyle(
    fontFamily: 'SpaceGrotesk',
    fontSize: 28,
    fontWeight: FontWeight.w500,
    letterSpacing: -0.25,
    color: FDLColors.textPrimary,
  );

  // Body - Inter
  static const bodyBase = TextStyle(
    fontFamily: 'Inter',
    fontSize: 16,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.25,
    color: FDLColors.textSecondary,
  );

  static const bodySmall = TextStyle(
    fontFamily: 'Inter',
    fontSize: 14,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.25,
    color: FDLColors.textSecondary,
  );

  static const caption = TextStyle(
    fontFamily: 'Inter',
    fontSize: 12,
    fontWeight: FontWeight.w400,
    letterSpacing: 0.25,
    color: FDLColors.textMuted,
  );

  // Code - JetBrains Mono
  static const code = TextStyle(
    fontFamily: 'JetBrainsMono',
    fontSize: 14,
    fontWeight: FontWeight.w400,
    color: FDLColors.textSecondary,
  );
}
```

---

## 🎨 **FDL Component Examples**

### **FDL Button:**

```dart
// lib/shared/widgets/fdl_button.dart

enum FDLButtonType { primary, secondary, ghost, link }

class FDLButton extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final FDLButtonType type;

  const FDLButton({
    required this.label,
    this.onPressed,
    this.type = FDLButtonType.primary,
  });

  @override
  Widget build(BuildContext context) {
    return AnimatedContainer(
      duration: Duration(milliseconds: 120), // FDL fast
      curve: Curves.easeOut,
      child: ElevatedButton(
        onPressed: onPressed,
        style: ElevatedButton.styleFrom(
          backgroundColor: _getBackgroundColor(),
          foregroundColor: _getForegroundColor(),
          padding: EdgeInsets.symmetric(horizontal: 24, vertical: 12),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(10), // FDL md radius
          ),
          elevation: 0,
        ),
        child: Text(label, style: FDLTypography.bodyBase),
      ),
    );
  }

  Color _getBackgroundColor() {
    switch (type) {
      case FDLButtonType.primary:
        return FDLColors.crimson;
      case FDLButtonType.secondary:
        return FDLColors.surface2;
      case FDLButtonType.ghost:
        return Colors.transparent;
      case FDLButtonType.link:
        return Colors.transparent;
    }
  }

  Color _getForegroundColor() {
    switch (type) {
      case FDLButtonType.primary:
        return FDLColors.textPrimary;
      case FDLButtonType.secondary:
        return FDLColors.textSecondary;
      case FDLButtonType.ghost:
        return FDLColors.crimson;
      case FDLButtonType.link:
        return FDLColors.crimson;
    }
  }
}
```

### **FDL Card:**

```dart
// lib/shared/widgets/fdl_card.dart

class FDLCard extends StatelessWidget {
  final Widget child;
  final VoidCallback? onTap;
  final bool elevated;

  const FDLCard({
    required this.child,
    this.onTap,
    this.elevated = false,
  });

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: onTap != null ? SystemMouseCursors.click : SystemMouseCursors.basic,
      child: GestureDetector(
        onTap: onTap,
        child: AnimatedContainer(
          duration: Duration(milliseconds: 180), // FDL base
          curve: Curves.easeOut,
          decoration: BoxDecoration(
            color: elevated ? FDLColors.surface2 : FDLColors.surface1,
            borderRadius: BorderRadius.circular(10), // FDL md
            border: Border.all(
              color: FDLColors.border,
              width: 1,
            ),
            boxShadow: elevated ? [
              BoxShadow(
                color: Colors.black.withOpacity(0.3),
                blurRadius: 12,
                offset: Offset(0, 0),
              ),
            ] : null,
          ),
          padding: EdgeInsets.all(24), // FDL spacing
          child: child,
        ),
      ),
    );
  }
}
```

---

## 📊 **Dashboard View**

```dart
// lib/features/dashboard/dashboard_view.dart

class DashboardView extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: FDLColors.surface0,
      body: Column(
        children: [
          // Header
          _buildHeader(),

          // Metrics Row
          _buildMetrics(),

          // Brief Status
          _buildBriefStatus(),

          // Recent Activity
          _buildRecentActivity(),
        ],
      ),
    );
  }

  Widget _buildHeader() {
    return Container(
      padding: EdgeInsets.all(32),
      child: Row(
        children: [
          // Crimson Agumon Icon
          Image.asset('assets/images/crimson_agumon.png', width: 48),
          SizedBox(width: 16),
          Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text('Igris AI', style: FDLTypography.h1),
              Text('Building systems that build things.',
                   style: FDLTypography.bodySmall.copyWith(
                     color: FDLColors.textMuted,
                   )),
            ],
          ),
          Spacer(),
          // Command Palette Button
          FDLButton(
            label: 'CMD+K',
            type: FDLButtonType.ghost,
            onPressed: () => _openCommandPalette(context),
          ),
        ],
      ),
    );
  }

  Widget _buildMetrics() {
    return Row(
      children: [
        _MetricCard(
          label: 'Briefs',
          value: '21',
          change: '+3',
          color: FDLColors.crimson,
        ),
        _MetricCard(
          label: 'In Progress',
          value: '2',
          color: FDLColors.techCrimson,
        ),
        _MetricCard(
          label: 'Blockers',
          value: '0',
          color: FDLColors.success,
        ),
      ],
    );
  }
}
```

---

## 🗂️ **Brief Manager View**

```dart
// lib/features/briefs/brief_list_view.dart

class BriefListView extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Column(
      children: [
        // Filter Bar
        _buildFilterBar(),

        // Brief List
        Expanded(
          child: ListView.builder(
            itemCount: briefs.length,
            itemBuilder: (context, index) {
              return _BriefCard(brief: briefs[index]);
            },
          ),
        ),
      ],
    );
  }
}

class _BriefCard extends StatelessWidget {
  final Brief brief;

  const _BriefCard({required this.brief});

  @override
  Widget build(BuildContext context) {
    return FDLCard(
      onTap: () => _openBrief(context, brief),
      child: Row(
        children: [
          // Type Badge
          _TypeBadge(type: brief.type),
          SizedBox(width: 16),

          // Title & Description
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(brief.title, style: FDLTypography.bodyBase),
                SizedBox(height: 4),
                Text(brief.description,
                     style: FDLTypography.bodySmall.copyWith(
                       color: FDLColors.textMuted,
                     )),
              ],
            ),
          ),

          // Priority
          _PriorityBadge(priority: brief.priority),

          // Status
          _StatusBadge(status: brief.status),
        ],
      ),
    );
  }
}
```

---

## ⚡ **Command Palette**

```dart
// lib/features/command_palette/command_palette.dart

class CommandPalette extends StatelessWidget {
  @override
  Widget build(BuildContext context) {
    return Center(
      child: Container(
        width: 600,
        decoration: BoxDecoration(
          color: FDLColors.surface1,
          borderRadius: BorderRadius.circular(16), // FDL lg
          border: Border.all(color: FDLColors.crimson, width: 1),
          boxShadow: [
            BoxShadow(
              color: FDLColors.crimson.withOpacity(0.45),
              blurRadius: 8,
              offset: Offset(0, 0),
            ),
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            // Search Input
            _buildSearchInput(),

            // Command List
            _buildCommandList(),
          ],
        ),
      ),
    );
  }
}
```

---

## 🔧 **Data Integration**

### **File System Repository:**

```dart
// lib/data/repositories/brief_repository.dart

class BriefRepository {
  final String projectPath;

  BriefRepository({required this.projectPath});

  Future<List<Brief>> getAllBriefs() async {
    final briefsDir = Directory('$projectPath/ai/briefs');
    final files = briefsDir.listSync()
        .where((f) => f.path.endsWith('.md'))
        .toList();

    return files.map((f) => _parseBrief(File(f.path))).toList();
  }

  Future<Brief> saveBrief(Brief brief) async {
    final file = File('$projectPath/ai/briefs/${brief.filename}');
    await file.writeAsString(brief.toMarkdown());
    return brief;
  }

  Brief _parseBrief(File file) {
    final content = file.readAsStringSync();
    // Parse markdown frontmatter and content
    return Brief.fromMarkdown(content);
  }
}
```

---

## 🚀 **Getting Started**

### **Step 1: Create Flutter Project**

```bash
# Create new Flutter project
flutter create igris_desktop --platforms=macos,windows,linux

cd igris_desktop
```

### **Step 2: Add Dependencies**

```yaml
# pubspec.yaml
dependencies:
  flutter:
    sdk: flutter

  # UI
  google_fonts: ^6.1.0           # For FDL typography
  flutter_svg: ^2.0.9            # Icons

  # State Management
  provider: ^6.1.1               # Or Riverpod/Bloc

  # File System
  path_provider: ^2.1.1
  path: ^1.8.3

  # Data
  markdown: ^7.1.1               # Parse briefs
  yaml: ^3.1.2                   # Parse config

  # Git Integration
  git: ^2.2.1

  # Window Management
  window_manager: ^0.3.7         # Control window

dev_dependencies:
  flutter_test:
    sdk: flutter
  flutter_lints: ^3.0.0
```

### **Step 3: Add Fonts**

```yaml
# pubspec.yaml
flutter:
  fonts:
    - family: SpaceGrotesk
      fonts:
        - asset: assets/fonts/SpaceGrotesk-Regular.ttf
        - asset: assets/fonts/SpaceGrotesk-Bold.ttf
          weight: 700

    - family: Inter
      fonts:
        - asset: assets/fonts/Inter-Regular.ttf
        - asset: assets/fonts/Inter-SemiBold.ttf
          weight: 600

    - family: JetBrainsMono
      fonts:
        - asset: assets/fonts/JetBrainsMono-Regular.ttf
```

---

## 📋 **Development Roadmap**

### **Phase 1: Foundation (Week 1-2)**
- [ ] Flutter project setup
- [ ] FDL theme system implementation
- [ ] Basic navigation structure
- [ ] File system repository

### **Phase 2: Core Features (Week 3-4)**
- [ ] Dashboard view
- [ ] Brief list view
- [ ] Brief detail/editor view
- [ ] Session tracker

### **Phase 3: Advanced Features (Week 5-6)**
- [ ] Command palette
- [ ] Architecture view
- [ ] Settings
- [ ] Git integration

### **Phase 4: Polish (Week 7-8)**
- [ ] Animations & transitions
- [ ] Keyboard shortcuts
- [ ] Error handling
- [ ] Performance optimization

### **Phase 5: AI Integration (Week 9-10)**
- [ ] LangChain outputs display
- [ ] LangGraph workflow visualization
- [ ] AI insights panel
- [ ] Real-time updates

---

## 🎨 **Design Principles**

Following FDL:
- ✅ **Dark mode first** (#0E0E0F base)
- ✅ **Crimson ≤15% usage** (identity, not decoration)
- ✅ **Surface hierarchy** for depth
- ✅ **Text hierarchy** for clarity
- ✅ **Motion: 120-240ms** durations
- ✅ **Engineering precision** over noise

---

## 🔗 **Integration Points**

**With Igris AI CLI:**
- Read/write briefs in `ai/briefs/`
- Monitor session in `ai/session/CURRENT_SESSION.md`
- Update decisions, blockers, learnings
- Execute git commands

**With Claude Code:**
- Launch Claude Code from UI
- Display Claude Code output
- Sync brief status

**With AI Plugins:**
- Call LangChain hooks
- Display LangGraph outputs
- Show AI recommendations

---

🔥 **Ready to build the Igris Desktop App with Flutter + FDL, Partner!** 🐒⚡

**Next steps?**
1. Create Flutter project
2. Implement FDL theme system
3. Build dashboard prototype
4. Iterate!

**Want me to help you get started?** 🚀
