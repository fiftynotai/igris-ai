# Learnings & Discoveries

Captures repo-specific patterns, gotchas, and best practices discovered during implementation.

---

## Learnings

### [2025-10-13] - Folder Naming Inconsistency

**Discovery:** Some legacy modules use `data/service/` (singular) instead of `data/services/` (plural)

**Affected Modules:**
- venue: uses `data/service/`
- event: uses `data/service/`

**Pattern Going Forward:**
Always use `data/services/` (plural) for new modules

**Rationale:** Consistency with base architecture and modern Flutter conventions

---

### [2025-10-13] - GetX Timer Management Pattern

**Discovery:** Timers in ViewModels must be manually canceled in `onClose()`

**Why:** GetX doesn't auto-dispose timers like it does for streams

**Pattern:**
```dart
Timer? _timer;

@override
void onInit() {
  super.onInit();
  _timer = Timer.periodic(Duration(seconds: 10), (_) {
    // Do work
  });
}

@override
void onClose() {
  _timer?.cancel(); // Must cancel manually
  super.onClose();
}
```

**Applies to:** All ViewModels using Timer (settings, any polling logic)

---

### [2025-10-13] - Phoenix Socket Lifecycle

**Discovery:** Socket connections must be managed in ViewModel lifecycle

**Pattern:**
```dart
@override
void onInit() {
  super.onInit();
  _socketService.connect(venueId);
}

@override
void onClose() {
  _socketService.disconnect();
  super.onClose();
}
```

**Why:** Prevents memory leaks and connection issues

**Used in:** event module, kds module

---

_Add new learnings as you discover patterns during implementation_
