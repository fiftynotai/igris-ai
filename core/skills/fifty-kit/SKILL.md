---
name: fifty-kit
description: Expert in Fifty Flutter Kit — FDL v2 design system, MVVM+Actions architecture, 15 packages, gaming systems
disable-model-invocation: false
allowed-tools:
  - Read
  - Write
  - Edit
  - Grep
  - Glob
  - Bash
triggers:
  - "fifty kit"
  - "FDL"
  - "design system"
  - "fifty flutter"
  - "fifty tokens"
  - "fifty ui"
  - "skill tree"
  - "achievement engine"
  - "mvvm actions"
  - "use the kit"
---

# Fifty Flutter Kit Expert

You are an expert in the **Fifty Flutter Kit** ecosystem — a comprehensive Flutter/Dart toolkit providing design tokens, theming, UI components, gaming systems, and architecture patterns.

**Kit Location:** `/Users/m.elamin/StudioProjects/fifty_eco_system`

## 1. Before Writing Any Code

**MANDATORY:** Before implementing anything with the kit, read the relevant package source files to confirm APIs, exports, and current versions. The knowledge below is your foundation — but always verify against the actual code.

**Read order for any task:**
1. Read the target package's `pubspec.yaml` for version and dependencies
2. Read the package's main export file (`lib/{package_name}.dart`) for public API
3. Read `design_system/fifty_design_system.md` if working with UI/theme
4. Read `templates/mvvm_actions/` if scaffolding a new module

## 2. Kit Architecture

```
fifty_flutter_kit/
├── packages/               # 15 reusable packages
│   ├── fifty_tokens/       # Design foundation (colors, typography, spacing, motion)
│   ├── fifty_theme/        # Material 3 theme generation (light + dark)
│   ├── fifty_ui/           # 40+ FDL-compliant components + effects
│   ├── fifty_forms/        # Form building, validation, multi-step wizards
│   ├── fifty_utils/        # DateTime, responsive, ApiResponse<T> state
│   ├── fifty_cache/        # TTL-based HTTP response caching
│   ├── fifty_storage/      # Secure token storage + preferences
│   ├── fifty_connectivity/  # Network monitoring + reachability probing
│   ├── fifty_audio_engine/  # 3-channel audio (BGM, SFX, Voice)
│   ├── fifty_speech_engine/ # TTS + STT unified interface
│   ├── fifty_sentences_engine/ # Sentence building + word bank
│   ├── fifty_map_engine/    # Flame-based grid game toolkit
│   ├── fifty_printing_engine/ # ESC/POS Bluetooth + WiFi printing
│   ├── fifty_skill_tree/    # Interactive skill tree widget (gaming)
│   └── fifty_achievement_engine/ # Achievement system (gaming)
├── apps/
│   └── fifty_demo/         # Demo app showcasing all packages
├── templates/
│   └── mvvm_actions/       # Production app scaffold (MVVM + Actions + GetX)
└── design_system/          # FDL v2 specification documents
```

### Dependency Graph

```
fifty_tokens (foundation — no dependencies)
     │
fifty_theme (depends on tokens)
     │
fifty_ui (depends on theme + tokens)
     │
fifty_skill_tree (depends on tokens)
fifty_achievement_engine (depends on tokens + ui)
fifty_forms (depends on ui)
     │
fifty_utils (foundation — no kit dependencies)
fifty_cache, fifty_storage, fifty_connectivity (standalone infrastructure)
fifty_audio_engine, fifty_speech_engine, fifty_map_engine (standalone engines)
fifty_printing_engine (standalone)
```

## 3. FDL v2 Design System (Fifty Design Language)

### Color Palette — "Sophisticated Warm"

| Token | Hex | Usage |
|-------|-----|-------|
| `FiftyColors.burgundy` (Primary) | `#88292F` | Primary buttons, CTAs, active states |
| `FiftyColors.burgundyHover` | `#6E2126` | Hover/pressed states |
| `FiftyColors.cream` (Light BG) | `#FEFEE3` | Light mode background |
| `FiftyColors.darkBurgundy` (Dark BG) | `#1A0D0E` | Dark mode background |
| `FiftyColors.slateGrey` (Secondary) | `#335C67` | Secondary buttons, toggles |
| `FiftyColors.slateGreyHover` | `#274750` | Secondary hover |
| `FiftyColors.hunterGreen` (Success) | `#4B644A` | Success states, checkboxes |
| `FiftyColors.powderBlush` (Accent) | `#FFC9B9` | Accents, badges, focus rings |
| `FiftyColors.surfaceLight` | `#FAF9DE` | Light mode cards/surfaces |
| `FiftyColors.surfaceDark` | `#2A1517` | Dark mode cards/surfaces |

**RULES:**
- NEVER use raw hex colors — always use `FiftyColors.*` tokens
- NEVER hardcode colors — use `Theme.of(context).colorScheme.*` for theme-aware colors
- Primary = Burgundy (NOT red, NOT crimson)
- Switch ON state = `slateGrey` (NOT primary burgundy)
- Success = `hunterGreen`

### Typography — Manrope

| Scale | Size | Weight | Line Height | Usage |
|-------|------|--------|-------------|-------|
| Display Large | 32px | ExtraBold (800) | 1.2 | Hero headlines |
| Display Medium | 24px | Bold (700) | 1.2 | Page titles |
| Title Large | 20px | SemiBold (600) | 1.3 | Section headers |
| Title Medium | 18px | SemiBold (600) | 1.3 | Card titles |
| Title Small | 16px | SemiBold (600) | 1.3 | Subsections |
| Body Large | 16px | Regular (400) | 1.5 | Primary body text |
| Body Medium | 14px | Regular (400) | 1.5 | Secondary body text |
| Body Small | 12px | Regular (400) | 1.5 | Captions |
| Label Large | 14px | Medium (500) | 1.2 | Button text |
| Label Medium | 12px | Medium (500) | 1.2 | Chips, badges |
| Label Small | 10px | Medium (500) | 1.2 | Footnotes |

**Font Family:** Manrope (via google_fonts)
**Letter Spacing:** -0.5 (display), 0 (body), 0.5 (labels), 1.5 (uppercase labels)

### Spacing — 4px Base Grid

| Token | Value | Usage |
|-------|-------|-------|
| `FiftySpacing.xs` | 4px | Minimal gaps |
| `FiftySpacing.sm` | 8px | Compact spacing |
| `FiftySpacing.md` | 12px | Card padding, form gaps |
| `FiftySpacing.lg` | 16px | Comfortable spacing |
| `FiftySpacing.xl` | 20px | Generous spacing |
| `FiftySpacing.xxl` | 24px | Section spacing |
| `FiftySpacing.xxxl` | 32px | Major sections |
| `FiftySpacing.huge` | 40px | Hero spacing |
| `FiftySpacing.massive` | 48px | Page-level |

### Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `FiftyRadii.sm` | 4px | Badges, checkboxes |
| `FiftyRadii.md` | 8px | Chips, tags |
| `FiftyRadii.lg` | 12px | Standard cards |
| `FiftyRadii.xl` | 16px | Buttons, inputs |
| `FiftyRadii.xxl` | 24px | Large cards |
| `FiftyRadii.xxxl` | 32px | Hero cards, modals |
| `FiftyRadii.full` | 9999px | Pills, circles |

### Motion — Kinetic Philosophy

**CRITICAL RULES:**
- **NO FADES** — use slides, wipes, reveals (shutter effect)
- **NO SPINNERS** — use text sequences: `"> INITIALIZING..."` → `"> LOADING..."` → `"> READY."`
- Motion feels **kinetic** — heavy but fast, like machinery

| Token | Value | Usage |
|-------|-------|-------|
| `FiftyMotion.instant` | 0ms | State changes |
| `FiftyMotion.fast` | 150ms | Micro-interactions |
| `FiftyMotion.compiling` | 300ms | Panel reveals |
| `FiftyMotion.systemLoad` | 800ms | Staggered entry |

**Easing Curves:**
- `FiftyMotion.standard` — cubic(0.2, 0, 0, 1) — default
- `FiftyMotion.enter` — cubic(0.2, 0.8, 0.2, 1) — elements entering
- `FiftyMotion.exit` — cubic(0.4, 0, 1, 1) — elements leaving

### Interactive States

| State | Behavior |
|-------|----------|
| Default | Surface + subtle border |
| Hover | Elevated shadow, subtle bg shift |
| Active/Pressed | Scale 0.98, deeper color |
| Focus | 2px primary ring (burgundy light, powderBlush dark) |
| Disabled | 50% opacity |

## 4. MVVM + Actions Architecture

### Layer Diagram

```
VIEW (Flutter Widgets — GetWidget/StatelessWidget)
  │  Displays data via Obx(), delegates user intents to Actions
  ▼
ACTIONS (ActionPresenter — Singleton)
  │  Wraps ViewModel calls with loading overlay + error snackbars
  ▼
VIEWMODEL (GetxController — Reactive State)
  │  Business logic, state management, orchestrates service calls
  ▼
SERVICE (Extends ApiService — HTTP + Cache)
  │  API communication, token management, error handling
  ▼
MODEL (Dart Classes — JSON Serializable)
    Domain objects, DTOs, immutable data structures
```

### Module Structure (Every Feature)

```
modules/{feature}/
├── actions/
│   └── {feature}_actions.dart     # UX orchestration (ActionPresenter)
├── controllers/
│   └── {feature}_view_model.dart  # Business logic (GetxController)
├── data/
│   ├── models/
│   │   └── {feature}_model.dart   # Domain objects
│   └── services/
│       └── {feature}_service.dart # API calls (extends ApiService)
├── views/
│   ├── {feature}_page.dart        # Main page widget
│   └── widgets/                   # Feature-specific widgets
└── {feature}_bindings.dart        # GetX DI registration
```

### Naming Conventions

| Element | Pattern | Example |
|---------|---------|---------|
| ViewModel | `{Feature}ViewModel` | `AuthViewModel`, `SpaceViewModel` |
| Actions | `{Feature}Actions` | `AuthActions`, `SpaceActions` |
| Service | `{Feature}Service` | `AuthService`, `NasaService` |
| Model | `{Feature}Model` | `UserModel`, `ApodModel` |
| Page | `{Feature}Page` | `LoginPage`, `SpacePage` |
| Bindings | `{Feature}Bindings` | `AuthBindings`, `SpaceBindings` |
| Locale Key | `tk{PascalCase}` | `tkLoginBtn`, `tkSignInSuccess` |

### GetX Reactive State

```dart
// In ViewModel — declare observables
class MyViewModel extends GetxController {
  final RxBool isLoading = false.obs;
  final Rx<ApiResponse<MyModel>> data = ApiResponse<MyModel>.idle().obs;
  final RxList<Item> items = <Item>[].obs;
}

// In View — observe changes
Obx(() {
  if (controller.isLoading.value) return FiftyLoadingIndicator();
  return Text(controller.data.value.data?.name ?? '');
})
```

### ApiResponse<T> State Pattern

```dart
// States: idle → loading → success(data) | error(message)
final Rx<ApiResponse<MyModel>> data = ApiResponse<MyModel>.idle().obs;

// Fetch with automatic state transitions
void fetchData() {
  apiFetch(() => _service.getData())
    .listen((value) => data.value = value);
}

// Consume in view
Obx(() {
  final response = controller.data.value;
  if (response.isLoading) return FiftyLoadingIndicator();
  if (response.hasError) return Text(response.message!);
  if (response.hasData) return MyWidget(data: response.data!);
  return SizedBox.shrink(); // idle
})
```

### Actions Layer Pattern

```dart
class MyActions extends ActionPresenter {
  static final MyActions _instance = MyActions._();
  static MyActions get instance => _instance;

  late MyViewModel _viewModel;

  MyActions._() {
    _viewModel = Get.find();
  }

  Future doSomething(BuildContext context) async {
    actionHandler(context, () async {
      await _viewModel.performAction();
      showSuccessSnackBar('Done', 'Action completed');
    });
  }
}
```

`actionHandler` automatically:
1. Shows loading overlay
2. Executes the action
3. Catches `AppException` → shows error snackbar
4. Hides loading overlay

### Dependency Injection (Bindings)

```dart
class MyBindings extends Bindings {
  @override
  void dependencies() {
    // 1. Register services first
    Get.lazyPut<MyService>(() => MyService());
    // 2. Register ViewModels (depend on services)
    Get.lazyPut<MyViewModel>(() => MyViewModel(Get.find<MyService>()));
  }
}
```

### Routing

```dart
// In RouteManager
GetPage(
  name: '/my-feature',
  page: () => const MyPage(),
  binding: MyBindings(),
  middlewares: [AuthMiddleware()], // optional
),

// Navigate
RouteManager.to('/my-feature');
RouteManager.off('/my-feature');     // replace
RouteManager.offAll('/my-feature');  // clear stack
```

## 5. UI Components Reference (forty_ui)

### Buttons
- `FiftyButton(label, onPressed, {variant, size, expanded, icon})`
  - Variants: `primary`, `secondary`, `tertiary`
  - Sizes: `small` (36px), `medium` (48px), `large` (56px)
- `FiftyIconButton(icon, onPressed, {size, variant})`
- `FiftyLabeledIconButton(icon, label, onPressed)`

### Inputs
- `FiftyTextField(label, {controller, validator, obscureText, suffix})`
- `FiftyDropdown<T>(items, onChanged, {value, hint})`
- `FiftySwitch(value, onChanged)` — ON = slateGrey, NOT primary
- `FiftySlider(value, onChanged, {min, max})`
- `FiftyCheckbox(value, onChanged, {label})`
- `FiftyRadio<T>(value, groupValue, onChanged, {label})`
- `FiftyRadioCard<T>(value, groupValue, onChanged, {title, subtitle})`

### Controls
- `FiftySegmentedControl(segments, selected, onChanged)` — pill-style

### Display
- `FiftyCard(child, {padding, margin, elevation})`
- `FiftyStatCard(title, value, {subtitle, icon, trend})` — KPI display
- `FiftyProgressBar(value, {color, height})` — linear progress
- `FiftyBadge(label, {color, size})` — status indicator
- `FiftyChip(label, {onDelete, avatar})` — tag/label
- `FiftyAvatar(name, {imageUrl, size})` — user avatar
- `FiftyListTile(title, {subtitle, leading, trailing})`
- `FiftyDataSlate(data)` — key-value panel
- `FiftyLoadingIndicator({text})` — text-based loading (NO SPINNERS)
- `FiftySectionHeader(title, {action})` — section divider
- `FiftyStatusIndicator(status, {label})` — colored dot + label
- `FiftyInfoRow(label, value)` — information row
- `FiftyProgressCard(title, progress, {subtitle})`
- `FiftySettingsRow(title, {trailing, onTap})`

### Feedback
- `FiftySnackbar.show(context, message, {type})` — toast notification
- `FiftyDialog.show(context, title, content, {actions})` — modal dialog
- `FiftyTooltip(message, child)` — hover tooltip

### Organisms
- `FiftyNavBar(items, selectedIndex, onTap)` — floating nav with glassmorphism
- `FiftyHero(text, {subtitle})` — dramatic headline

### Effects & Utilities
- `GlowContainer(child, {color, intensity})` — pulsing glow wrapper
- `KineticEffect(child)` — hover/press scale animation (0.98 on press)
- `GlitchEffect(child)` — RGB chromatic aberration effect
- `HalftoneOverlay(child)` — halftone dot texture
- `HalftonePainter()` — CustomPainter for halftone patterns
- `FiftyCodeBlock(code, {language})` — syntax-highlighted code

## 6. Gaming Packages

### fifty_skill_tree — Interactive Skill Trees

```dart
import 'package:fifty_skill_tree/fifty_skill_tree.dart';

// Create tree
final tree = SkillTree<MyData>(id: 'warrior', name: 'Warrior Skills');

// Add nodes
tree.addNode(SkillNode(
  id: 'slash', name: 'Slash', description: 'Basic attack',
  costs: [1], tier: 0, type: SkillType.active,
));
tree.addNode(SkillNode(
  id: 'power_slash', name: 'Power Slash',
  costs: [2], tier: 1, prerequisites: ['slash'],
));

// Add connections
tree.addConnection(SkillConnection(fromId: 'slash', toId: 'power_slash'));

// Display
SkillTreeView<MyData>(
  tree: tree,
  layout: RadialTreeLayout(),   // or VerticalTreeLayout, GridLayout, etc.
  theme: SkillTreeTheme.dark(), // or .light() or custom
  onNodeTap: (node) => tree.unlock(node.id),
)
```

**6 Layouts:** VerticalTreeLayout, HorizontalTreeLayout, RadialTreeLayout, GridLayout, CustomLayout
**4 Node States:** locked, available, unlocked, maxed
**4 Node Types:** passive, active, ultimate, keystone
**3 Connection Styles:** solid, dashed, animated (EnergyFlowPainter)
**Animations:** PulseAnimation, GlowAnimation, PathHighlightAnimation
**Serialization:** `tree.exportProgress()` / `tree.importProgress(json)`

### fifty_achievement_engine — Achievement System

```dart
import 'package:fifty_achievement_engine/fifty_achievement_engine.dart';

// Define achievements
final controller = AchievementController<void>(
  achievements: [
    Achievement(
      id: 'first_kill', name: 'First Blood',
      description: 'Defeat your first enemy',
      condition: EventCondition('enemy_killed'),
      rarity: AchievementRarity.common, points: 10,
    ),
    Achievement(
      id: 'kill_100', name: 'Century',
      condition: CountCondition('enemy_killed', target: 100),
      rarity: AchievementRarity.rare, points: 50,
      prerequisites: ['first_kill'],
    ),
  ],
  onUnlock: (a) => print('Unlocked: ${a.name}!'),
);

// Track events
controller.trackEvent('enemy_killed');

// Check progress
double progress = controller.getProgress('kill_100'); // 0.0 to 1.0

// Serialize
Map<String, dynamic> save = controller.exportProgress();
controller.importProgress(save);
```

**6 Condition Types:**
1. `EventCondition(eventName)` — binary event check
2. `CountCondition(eventName, target: N)` — cumulative count
3. `ThresholdCondition(statName, target: N)` — stat reaches value
4. `CompositeCondition(conditions, operator: AND|OR)` — combine conditions
5. `TimeCondition(duration, targetTime)` — time-based challenge
6. `SequenceCondition(requiredSequence)` — ordered events

**5 Rarity Tiers:** common (1x), uncommon (2x), rare (3x), epic (5x), legendary (10x)
**5 Widgets:** AchievementCard, AchievementList, AchievementPopup, AchievementProgressBar, AchievementSummary

## 7. Infrastructure Packages

### fifty_cache — HTTP Response Caching
```dart
final store = await GetStorageCacheStore.create(container: 'app_cache');
final policy = SimpleTimeToLiveCachePolicy(timeToLive: Duration(hours: 6));
final cacheManager = CacheManager(store, DefaultCacheKeyStrategy(), policy);
ApiService.configureCache(cacheManager);

// In service calls
final response = await get(url, useCache: true, forceRefresh: false);
```

### fifty_storage — Secure Token Storage
```dart
await AppStorageService.instance.setAccessToken('jwt_token');
await AppStorageService.instance.setRefreshToken('refresh_jwt');
String? token = AppStorageService.instance.accessToken;
```

### fifty_connectivity — Network Monitoring
```dart
final connVM = Get.find<ConnectionViewModel>();
Obx(() => Text(connVM.isOnline.value ? 'Online' : 'Offline'));
// ConnectivityCheckerSplash widget for app startup
```

### fifty_utils — Utilities
```dart
// DateTime extensions
DateTime.now().timeAgo(); // "2 hours ago"

// Responsive
if (ResponsiveUtils.isMobile(context)) { /* mobile layout */ }

// ApiResponse<T> state machine
apiFetch(() => service.getData()).listen((state) {
  if (state.isLoading) showSpinner();
  if (state.hasData) showData(state.data!);
  if (state.hasError) showError(state.error);
});
```

## 8. Predefined Template Modules

The `mvvm_actions` template ships with these ready-to-use modules:

| Module | Purpose | Key Classes |
|--------|---------|-------------|
| `auth` | Login, register, session management | `AuthViewModel`, `AuthActions`, `AuthService` |
| `theme` | Light/dark/system mode switching | `ThemeViewModel`, `ThemeService` |
| `locale` | Multi-language (EN, AR) | `LocalizationViewModel`, `LocalizationService` |
| `menu` | Navigation drawer + page routing | `MenuViewModel`, `MenuActions` |
| `connections` | Network connectivity monitoring | Via `fifty_connectivity` |
| `space` | Example NASA API feature (reference implementation) | `SpaceViewModel`, `SpaceActions`, `NasaService` |

### Core Infrastructure
- `ApiService` — HTTP client with caching, 401 refresh, error handling
- `ActionPresenter` — Loading overlay + error snackbar wrapper
- `RouteManager` — Centralized named route navigation
- `AppException` hierarchy — `AuthException`, `APIException`, `NetworkException`
- `FormValidators` — Email, phone, password, username validators

## 9. Error Handling Conventions

```dart
// Exception hierarchy
AppException (base)
├── AuthException      // Authentication failures
├── APIException       // Server errors (4xx, 5xx)
├── NetworkException   // No connectivity
└── FetchingException  // Data fetch errors

// In Services — throw typed exceptions
if (response.statusCode == 401) throw AuthException('Session expired');
if (response.statusCode >= 500) throw APIException('Server error');

// In Actions — caught automatically by actionHandler
actionHandler(context, () async {
  await viewModel.doWork(); // throws AppException on failure
  showSuccessSnackBar('Done', 'Success message');
}); // Errors shown as snackbars automatically
```

## 10. Implementation Checklist

When building a new feature module with the kit:

- [ ] Create module folder: `modules/{feature}/`
- [ ] Create model: `data/models/{feature}_model.dart` (fromJson/toJson)
- [ ] Create service: `data/services/{feature}_service.dart` (extends ApiService)
- [ ] Create ViewModel: `controllers/{feature}_view_model.dart` (GetxController with Rx state)
- [ ] Create Actions: `actions/{feature}_actions.dart` (extends ActionPresenter)
- [ ] Create Page: `views/{feature}_page.dart` (GetWidget, uses Obx)
- [ ] Create Bindings: `{feature}_bindings.dart` (register service → ViewModel)
- [ ] Add route to RouteManager
- [ ] Use FDL tokens for ALL colors, spacing, typography (no raw values)
- [ ] Use FDL components from fifty_ui (no custom Material widgets)
- [ ] Follow motion rules: NO FADES, NO SPINNERS
- [ ] Add locale keys for all user-facing strings
- [ ] Use ApiResponse<T> for all async data states

## 11. Common Mistakes to Avoid

1. **Raw hex colors** — ALWAYS use `FiftyColors.*` or `Theme.of(context).colorScheme`
2. **Magic number spacing** — ALWAYS use `FiftySpacing.*` tokens
3. **Spinner widgets** — Use `FiftyLoadingIndicator` with text sequences instead
4. **Fade animations** — Use slides, wipes, reveals with `FiftyMotion` curves
5. **Business logic in Views** — Delegate to Actions, keep Views thin
6. **Direct Get.find() in Views** — Use `GetWidget<T>` or `GetView<T>` instead
7. **Untyped API errors** — Always throw `AppException` subclasses
8. **Forgetting bindings** — Every module needs a `{Feature}Bindings` class
9. **Switch ON = primary** — Switch ON state is `slateGrey`, NOT burgundy
10. **Hardcoded strings** — Use `tkKey.tr` for all user-facing text

## 12. Coding Guidelines & DRY Package Principle

### Golden Rule: Consume, Don't Define

Engine packages (skill_tree, achievement, inventory, dialogue, forms, etc.) **MUST consume** theming from FDL packages. They **MUST NOT** define their own theming systems.

```
FDL Foundation Layer (fifty_tokens → fifty_theme → fifty_ui)
                          │
                          ▼
        Engine Packages (skill_tree, achievement, inventory...)
        ALL consume FDL — NONE define their own themes
```

### Anti-Pattern: Self-Contained Theming

**NEVER do this:**

```dart
// ❌ WRONG - Package defines its own theme system
class SkillTreeTheme {
  final Color lockedNodeColor;
  final Color unlockedNodeColor;
  final Color connectionColor;
  // ... 20+ custom properties

  factory SkillTreeTheme.dark() => SkillTreeTheme(
    lockedNodeColor: Color(0xFF333333),  // hardcoded!
    unlockedNodeColor: Color(0xFF00FF00), // hardcoded!
  );
}

class SkillTreeThemePresets {
  static SkillTreeTheme rpg() => ...  // more hardcoded values
  static SkillTreeTheme sciFi() => ...
}
```

**Problems:**
- FDL changes don't propagate automatically
- Inconsistent look with rest of ecosystem
- Duplicate maintenance effort
- Anti-pattern spreads to other packages

### Correct Pattern: FDL Consumption

**ALWAYS do this:**

```dart
// ✅ CORRECT - Package consumes from FDL
import 'package:fifty_tokens/fifty_tokens.dart';
import 'package:fifty_ui/fifty_ui.dart';

class SkillNodeWidget extends StatelessWidget {
  // Optional overrides (not a separate theme class)
  final Color? nodeColor;
  final Color? borderColor;

  const SkillNodeWidget({this.nodeColor, this.borderColor, super.key});

  @override
  Widget build(BuildContext context) {
    return Container(
      color: nodeColor ?? FiftyColors.surface,
      padding: FiftySpacing.insets.md,
      decoration: BoxDecoration(
        border: Border.all(color: borderColor ?? FiftyColors.border),
        borderRadius: FiftyRadii.standardRadius,
      ),
      child: Text(
        node.name,
        style: TextStyle(
          fontFamily: FiftyTypography.fontFamilyMono,
          fontSize: FiftyTypography.body,
          color: FiftyColors.textPrimary,
        ),
      ),
    );
  }
}
```

### Override Pattern

When customization is needed, use **widget-level optional parameters**, NOT a theme class:

```dart
// ✅ CORRECT - Optional overrides on widget
SkillTreeView<void>(
  controller: controller,
  layout: const VerticalTreeLayout(),
  lockedNodeColor: Colors.grey,
  unlockedNodeColor: FiftyColors.igrisGreen,
  connectionColor: FiftyColors.border,
)

// ❌ WRONG - Separate theme object
SkillTreeView<void>(
  controller: controller,
  theme: SkillTreeTheme(lockedNodeColor: Colors.grey, ...),
)
```

### State-Based Styling

For widgets with multiple states, define semantic color getters using FDL tokens:

```dart
class SkillNodeWidget extends StatelessWidget {
  Color get _nodeColor {
    switch (state) {
      case SkillState.locked:    return FiftyColors.surfaceVariant;
      case SkillState.available: return FiftyColors.surface;
      case SkillState.unlocked:  return FiftyColors.successBackground;
      case SkillState.maxed:     return FiftyColors.primaryBackground;
    }
  }

  Color get _borderColor {
    switch (state) {
      case SkillState.locked:    return FiftyColors.border;
      case SkillState.available: return FiftyColors.primary;
      case SkillState.unlocked:  return FiftyColors.success;
      case SkillState.maxed:     return FiftyColors.primaryAccent;
    }
  }
}
```

### Engine Package Checklist

When creating or reviewing an engine package:

- [ ] **Dependencies:** Includes `fifty_tokens` and `fifty_ui` in pubspec.yaml
- [ ] **No Theme Class:** Does NOT define a custom `*Theme` class with color properties
- [ ] **No Presets:** Does NOT define `*ThemePresets` with hardcoded variants
- [ ] **FDL Colors:** Uses `FiftyColors.*` for all color values
- [ ] **FDL Spacing:** Uses `FiftySpacing.*` for all padding/margins
- [ ] **FDL Typography:** Uses `FiftyTypography.*` for all text styles
- [ ] **FDL Radii:** Uses `FiftyRadii.*` for all border radius values
- [ ] **FDL Components:** Uses `FiftyCard`, `FiftyButton`, etc. where applicable
- [ ] **Optional Overrides:** Provides override parameters on widgets (not a theme object)
- [ ] **Controller Clean:** Controller does NOT have a `theme` property

### The Promotion Pattern

Not everything belongs in FDL. Use this decision tree:

1. **Is it a primitive?** (color, spacing, typography) → Must go in `fifty_tokens`
2. **Is it a generic component?** (button, card, modal) → Must go in `fifty_ui`
3. **Is it domain-specific?** (skill node, inventory slot) → Can stay in engine package, BUT must consume FDL primitives
4. **Is it used by 2+ packages?** → **PROMOTE to `fifty_ui`**

**Promotion Workflow:**
```
1. Package A creates GlowAnimation (lives in package A)
2. Package B needs same animation
3. STOP — Don't copy to Package B
4. Create brief: "Promote GlowAnimation to fifty_ui"
5. Move to fifty_ui with proper API
6. Both packages consume from fifty_ui
```

| Component | Where | Why |
|-----------|-------|-----|
| `FiftyColors.success` | fifty_tokens | Primitive |
| `FiftyButton` | fifty_ui | Generic component |
| `SkillNodeWidget` | fifty_skill_tree | Domain-specific |
| `AchievementCard` | fifty_achievement | Domain-specific |
| `GlowAnimation` | **Promote** to fifty_ui | Used by 2+ packages |
| `RarityBorder` | **Promote** to fifty_ui | Used by inventory + achievement |

### Why DRY Matters Here

When the design system changes:

**With Self-Contained Theming (Wrong):**
- Update fifty_tokens, fifty_theme, fifty_ui
- Update fifty_skill_tree **manually**
- Update fifty_achievement_engine **manually**
- Update fifty_forms **manually**
- **5+ packages to update manually**

**With FDL Consumption (Correct):**
- Update fifty_tokens, fifty_theme, fifty_ui
- **All engine packages automatically updated**

## 13. MVVM + Actions Golden Rules

These rules are **non-negotiable** for any code using the kit:

1. **Views NEVER call Services directly** — Always go through ViewModel
2. **ViewModels NEVER show UI feedback** — Actions handle loading/errors
3. **Services NEVER hold state** — ViewModels own reactive state
4. **Actions NEVER contain business logic** — Delegate to ViewModel

### Layer Boundaries

| Layer | Can Call | Cannot Call |
|-------|---------|-------------|
| View | Actions, reads ViewModel via Obx | Services directly |
| Actions | ViewModel methods | Services directly |
| ViewModel | Services, updates Rx state | UI (snackbars, dialogs) |
| Service | HTTP/API, returns data | Holds state, shows UI |

### Bindings Registration Order

**MUST follow dependency order:**
1. **Services** (no dependencies) — `Get.lazyPut`
2. **ViewModels** (depend on Services) — `Get.put` or `Get.lazyPut`
3. **Actions** (depend on ViewModels) — `Get.lazyPut`

**Cleanup order is REVERSE:**
1. Actions first
2. ViewModels second
3. Services last

### Registration Types

| Type | Use When |
|------|----------|
| `Get.put()` | Immediate initialization, permanent ViewModels |
| `Get.lazyPut()` | Lazy initialization for Services/Actions |
| `Get.lazyPut(fenix: true)` | Auto-recreate after deletion |
| `permanent: true` | Persist across navigation |

## 14. Testing Standards

| Component | Test Type | Minimum Coverage |
|-----------|-----------|------------------|
| ViewModels | Unit tests | 80% |
| Services | Unit tests | 80% |
| Actions | Unit tests | 70% |
| Models | Unit tests | 90% |
| Widgets | Widget tests | 50% |
| Critical flows | Integration tests | Key paths |

### Test File Location

```
test/modules/{module}/
├── controllers/{module}_view_model_test.dart
├── services/{module}_service_test.dart
└── actions/{module}_actions_test.dart
```

### Mocking Pattern

```dart
class MockAuthService extends Mock implements AuthService {}

void main() {
  late AuthViewModel viewModel;
  late MockAuthService mockService;

  setUp(() {
    mockService = MockAuthService();
    viewModel = AuthViewModel(mockService);
  });

  test('checkSession returns true when logged in', () async {
    when(() => mockService.isLoggedIn()).thenAnswer((_) async => true);
    final result = await viewModel.checkSession();
    expect(result, true);
  });
}
```

## 15. Code Review Checklist

- [ ] Follows MVVM + Actions architecture
- [ ] Proper layer separation (no layer skipping)
- [ ] Uses `ApiResponse<T>` and `apiFetch()` for async
- [ ] Uses `ApiHandler` for rendering API states
- [ ] Bindings register dependencies in correct order
- [ ] FDL components and tokens used for all UI
- [ ] **No custom theme classes in engine packages** (DRY rule)
- [ ] **No hardcoded colors, spacing, or typography** (FDL tokens only)
- [ ] Documentation present for public APIs
- [ ] Unit tests included for business logic
- [ ] Linter passes (zero issues)
- [ ] No hardcoded strings in UI (use locale keys)
- [ ] Error handling covers all edge cases
- [ ] Uses `const` constructors where possible
- [ ] Functions under 50 lines
