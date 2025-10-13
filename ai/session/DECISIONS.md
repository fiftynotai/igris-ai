# Decision Log

Tracks architectural and technical decisions made during implementation.

---

## [2025-10-13] - Decision: Use flutter-mvvm-actions-arch as canonical reference

**Context:** Need to document architecture for Blueprint AI without duplicating docs

**Options:**
1. Document full architecture in repo
2. Reference external canonical architecture repo
3. Hybrid: brief summary + reference

**Decision:** Option 2 - Reference flutter-mvvm-actions-arch as canonical source

**Rationale:**
- Single source of truth (one place to maintain)
- Easy to update (change URL variable in template)
- Repo-specific docs focus on adaptations only
- Makes template reusable for other repos

**Consequences:**
- Must ensure base repo remains accessible
- architecture_map.md becomes lightweight adapter
- docs/ARCHITECTURE.md kept as expanded reference but notes base is canonical

---

## [2025-10-13] - Decision: Include session management system

**Context:** Need crash recovery and progress tracking for AI sessions

**Options:**
1. Use TodoWrite tool only (ephemeral)
2. Add persistent session files
3. No session management

**Decision:** Option 2 - Add /ai/session/ with 5 files (CURRENT_SESSION, DECISIONS, BLOCKERS, LEARNINGS, TEST_RESULTS)

**Rationale:**
- CLI crashes happen frequently
- Session limits cause interruptions
- Need to preserve context across sessions
- Knowledge capture for future reference
- Enables handoff between AI sessions

**Consequences:**
- 5 additional files to maintain
- Requires discipline to update during session
- TodoWrite must sync with CURRENT_SESSION.md
- Benefits outweigh maintenance cost

---

## [2025-10-13] - Decision: Create pilot task BR-001 (Printer Status Indicator)

**Context:** Need real task to test Blueprint AI workflow

**Options:**
1. Simple UI-only task
2. Full-stack feature (all layers)
3. Bug fix task

**Decision:** Option 2 - Printer connection status indicator (touches all layers)

**Rationale:**
- Tests entire workflow (View → Actions → ViewModel → Service)
- Safe (no backend changes, no data model changes)
- Useful (real user need from support tickets)
- Small (3-4 hours, fits in one session)
- Uses existing settings module (v2.6.0 feature)

**Consequences:**
- Good test of architecture adherence
- Validates brief format
- Proves session management system
- Template can be extracted after success

---

## [2025-10-13] - Decision: Track printer status separately from DeviceModel

**Context:** BR-001 requires tracking printer connection status (connected/offline/connecting)

**Options:**
1. Add status fields to DeviceModel (requires making it mutable or recreating often)
2. Track status separately in ViewModel using Map<String, PrinterStatus>
3. Create new PrinterWithStatus wrapper class

**Decision:** Option 2 - Track status in ViewModel using Map keyed by macAddress

**Rationale:**
- DeviceModel is immutable and used for persistence (good design)
- Connection status is transient and changes frequently (every 10s)
- Adding to DeviceModel would violate immutability or require constant recreation
- Map approach keeps concerns separated: DeviceModel = config, status = runtime state
- Easy to lookup status by macAddress when rendering UI

**Implementation:**
```dart
// In SettingsViewModel
final RxMap<String, PrinterStatus> _printerStatuses = <String, PrinterStatus>{}.obs;

class PrinterStatus {
  final bool isConnected;
  final String statusText;
  final Color statusColor;
}
```

**Consequences:**
- ViewModel slightly more complex (manages both devices and statuses)
- No changes needed to DeviceModel (preserves immutability)
- Status not persisted (acceptable - it's transient anyway)

---

_Add new decisions as they are made during implementation_
