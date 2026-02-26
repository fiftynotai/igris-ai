# Implementation Plan: FR-070

**Complexity:** M
**Estimated Duration:** 3-4 hours
**Risk Level:** Low

## Summary

Add instance-scoped filtering to Events and Tasks pages. Users drill from an expanded instance card via "EVENTS" and "TASKS" action buttons, navigating to the respective pages with query parameters. Events filter by `instance_id` (server-side + client-side live feed). Tasks filter by `projectSlug` from the instance (since tasks have no `instanceId` field). Both pages show a context banner when instance-filtered.

## Architecture Analysis

### Data Model Constraints

- **BrainEventModel** has `instanceId` field. Direct filtering is possible both server-side (the `event_log` table has `instance_id` column, already SELECTed at `brain-mcp-server/src/index.ts:643`) and client-side on the live feed.
- **TaskModel** has NO `instanceId` field. The closest relation is `projectSlug`. When drilling from an instance, we pass the instance's `projectSlug` to filter tasks by project scope, plus store the instance context metadata for display purposes only.
- **InstanceModel** provides `id`, `projectSlug`, `machineHostname` -- all needed for navigation and context display.

### Server-Side Gap

The brain server's `GET /api/events` endpoint (at `brain-mcp-server/src/index.ts:604-656`) already returns `instance_id` in results but does NOT accept `instance_id` as a query filter parameter. This must be added.

The `GET /api/tasks` endpoint has no `instance_id` concept -- this is expected since tasks don't belong to instances. No server change needed for tasks.

### Navigation Pattern

The app uses `Get.offNamed()` for tab switches (replaces current route). Query parameters are accessed via `Get.parameters['key']`. The `InstancesPage` already demonstrates deep linking via `Get.parameters['id']` in `initState()`. Both `EventsViewModel` and `TasksViewModel` are registered as `permanent: true` in their bindings, so the VMs persist across route changes and must explicitly check/reset instance filters on navigation.

### Binding Lifecycle Consideration

Since ViewModels are permanent (`Get.put(..., permanent: true)` in bindings), they survive route changes. This means:
- The VM's `onInit()` runs only once, not on every navigation to the page.
- Instance filter state must be set externally (from the page's `initState`) after navigation, not in `onInit`.
- `clearFilters()` or an explicit `setInstanceFilter(null)` must be called when navigating to the page WITHOUT instance params (normal tab navigation).

## Files to Modify

| File | Action | Changes |
|------|--------|---------|
| `brain-mcp-server/src/index.ts` | MODIFY | Add `instance_id` query param support to `GET /api/events` endpoint |
| `crimson-arena/.../services/brain_api_service.dart` | MODIFY | Add `instanceId` named param to `getBrainEvents()` |
| `crimson-arena/.../features/events/controllers/events_view_model.dart` | MODIFY | Add `selectedInstanceId` Rxn filter, pass to API, filter live feed |
| `crimson-arena/.../features/events/views/events_page.dart` | MODIFY | Read `?instance=xxx` from route params, call VM filter, show context banner |
| `crimson-arena/.../features/events/views/widgets/event_filter_bar.dart` | MODIFY | Show instance filter chip when active |
| `crimson-arena/.../features/tasks/controllers/tasks_view_model.dart` | MODIFY | Add `instanceContext` Rxn for display, read `?instance=xxx&project=yyy` from page |
| `crimson-arena/.../features/tasks/views/tasks_page.dart` | MODIFY | Read route params, set VM context, show context banner |
| `crimson-arena/.../features/instances/views/instances_page.dart` | MODIFY | Add action row with EVENTS / TASKS buttons in expanded content |
| `crimson-arena/.../shared/widgets/arena_scaffold.dart` | MODIFY | Support passing query params through tab navigation (clear instance context on tab switch) |

## Implementation Steps

### Phase 1: Server-Side -- Add instance_id Filter to Events API

**File:** `brain-mcp-server/src/index.ts` (lines 604-656)

1. After line 611 (`const until = ...`), add `const instanceId = req.query.instance_id as string | undefined;`
2. After the `until` condition block (after line 638), add:
   ```
   if (instanceId) {
     conditions.push('instance_id = ?');
     params.push(instanceId);
   }
   ```
3. No migration needed -- the `event_log` table already has the `instance_id` column and it's already indexed as part of the SELECT query.

### Phase 2: Flutter API Layer -- Add instanceId Param

**File:** `crimson-arena/.../services/brain_api_service.dart`

1. Add `String? instanceId` named parameter to `getBrainEvents()` method signature (after the `project` param).
2. Inside the method, add: `if (instanceId != null) params['instance_id'] = instanceId;`

### Phase 3: Events ViewModel -- Instance Filter Logic

**File:** `crimson-arena/.../features/events/controllers/events_view_model.dart`

1. Add reactive state:
   ```dart
   /// Instance ID filter for drill-down from Instances page (null = all).
   final selectedInstanceId = Rxn<String>();

   /// Display metadata for the instance context banner.
   final instanceHostname = Rxn<String>();
   final instanceProject = Rxn<String>();
   ```

2. Add `setInstanceFilter` method:
   ```dart
   void setInstanceFilter(String? instanceId, {String? hostname, String? project}) {
     selectedInstanceId.value = instanceId;
     instanceHostname.value = hostname;
     instanceProject.value = project;
     historyOffset.value = 0;
     fetchHistory();
     _onLiveEventFeedUpdate(_ws.liveEventFeed);
   }
   ```

3. Update `fetchHistory()` to pass `instanceId: selectedInstanceId.value` to `_api.getBrainEvents()`.

4. Update `_onLiveEventFeedUpdate()` to add instance filtering:
   ```dart
   final instanceId = selectedInstanceId.value;
   // ... in the where clause:
   if (instanceId != null && e.instanceId != instanceId) return false;
   ```

5. Update `clearFilters()` to also clear `selectedInstanceId`, `instanceHostname`, `instanceProject`.

6. Add `hasInstanceFilter` computed getter:
   ```dart
   bool get hasInstanceFilter => selectedInstanceId.value != null;
   ```

### Phase 4: Events Page -- Route Param Reading and Context Banner

**File:** `crimson-arena/.../features/events/views/events_page.dart`

1. Convert from `StatelessWidget` to `StatefulWidget` to use `initState()` for reading route params (matching the pattern from `InstancesPage`).

2. In `initState()`, read query params:
   ```dart
   final params = Get.parameters;
   final instanceId = params['instance'];
   if (instanceId != null && instanceId.isNotEmpty) {
     final vm = Get.find<EventsViewModel>();
     vm.setInstanceFilter(
       instanceId,
       hostname: params['hostname'],
       project: params['project'],
     );
   }
   ```

3. Add a context banner widget above the filter bar (inside `_buildContent`), shown only when `vm.hasInstanceFilter`:
   - Shows: "INSTANCE: {hostname} / {project}" with a CLEAR (X) button
   - Styled consistently with the existing filter bar aesthetic (same container style, same color scheme)
   - CLEAR button calls `vm.setInstanceFilter(null)` to remove instance scope

### Phase 5: Event Filter Bar -- Instance Chip

**File:** `crimson-arena/.../features/events/views/widgets/event_filter_bar.dart`

1. In the `Obx` that shows the CLEAR button (line 142-157), update the `hasFilter` check to also include instance filter:
   ```dart
   final hasFilter = _vm.selectedComponent.value != null ||
       _vm.searchQuery.value.isNotEmpty ||
       _vm.selectedInstanceId.value != null;
   ```

2. Add an instance chip before the CLEAR button when `_vm.selectedInstanceId.value != null`:
   ```dart
   if (_vm.selectedInstanceId.value != null)
     _FilterChip(
       label: 'INSTANCE: ${_vm.instanceHostname.value ?? _vm.selectedInstanceId.value!.substring(0, 8)}',
       color: colorScheme.tertiary,
       isSelected: true,
       onTap: () => _vm.setInstanceFilter(null),
     ),
   ```

### Phase 6: Tasks ViewModel -- Instance Context

**File:** `crimson-arena/.../features/tasks/controllers/tasks_view_model.dart`

1. Add instance context state (display-only, since tasks don't have instanceId):
   ```dart
   /// Instance context for display when drilled from Instances page.
   final instanceContextId = Rxn<String>();
   final instanceContextHostname = Rxn<String>();
   ```

2. Add `setInstanceContext` method:
   ```dart
   void setInstanceContext(String? instanceId, {String? hostname, String? projectSlug}) {
     instanceContextId.value = instanceId;
     instanceContextHostname.value = hostname;
     if (projectSlug != null) {
       selectedProject.value = projectSlug;
       fetchTasks();
     }
   }
   ```

3. Add `clearInstanceContext` method:
   ```dart
   void clearInstanceContext() {
     instanceContextId.value = null;
     instanceContextHostname.value = null;
     // Don't clear project filter -- let clearFilters handle that
   }
   ```

4. Add computed getter:
   ```dart
   bool get hasInstanceContext => instanceContextId.value != null;
   ```

5. Update `clearFilters()` to also call `clearInstanceContext()`.

### Phase 7: Tasks Page -- Route Params and Context Banner

**File:** `crimson-arena/.../features/tasks/views/tasks_page.dart`

1. Convert from `StatelessWidget` to `StatefulWidget` for `initState()`.

2. In `initState()`, read query params:
   ```dart
   final params = Get.parameters;
   final instanceId = params['instance'];
   if (instanceId != null && instanceId.isNotEmpty) {
     final vm = Get.find<TasksViewModel>();
     vm.setInstanceContext(
       instanceId,
       hostname: params['hostname'],
       projectSlug: params['project'],
     );
   }
   ```

3. Add context banner in `_buildKanban`, above the header row, shown when `vm.hasInstanceContext`:
   - Shows: "VIEWING TASKS FOR INSTANCE: {hostname} (filtered by project: {project})"
   - CLEAR button calls `vm.clearInstanceContext()` and `vm.clearFilters()`

### Phase 8: Instance Drill-Down Buttons

**File:** `crimson-arena/.../features/instances/views/instances_page.dart`

1. In `_buildExpandedContent()`, add an action row at the top of the expanded Column (before `HuntPipelineWidget`):
   ```dart
   // Drill-down action buttons
   _buildDrillDownActions(context, instance),
   const SizedBox(height: FiftySpacing.sm),
   ```

2. Implement `_buildDrillDownActions`:
   ```dart
   Widget _buildDrillDownActions(BuildContext context, InstanceModel instance) {
     return Row(
       children: [
         ArenaHoverButton(
           onTap: () => Get.offNamed(
             '/events?instance=${instance.id}&hostname=${instance.machineHostname}&project=${instance.projectSlug}',
           ),
           child: Text('EVENTS'),  // styled as action button
         ),
         SizedBox(width: FiftySpacing.sm),
         ArenaHoverButton(
           onTap: () => Get.offNamed(
             '/tasks?instance=${instance.id}&hostname=${instance.machineHostname}&project=${instance.projectSlug}',
           ),
           child: Text('TASKS'),
         ),
       ],
     );
   }
   ```

### Phase 9: Tab Navigation Cleanup

**File:** `crimson-arena/.../shared/widgets/arena_scaffold.dart`

The `_navigateTo` method (line 265-268) uses `Get.offNamed(_tabs[index].route)` which navigates without query params. This is correct -- when users click tab buttons, they should see the unfiltered global view.

However, since VMs are permanent, switching tabs won't reset instance filters. Two approaches:

**Option A (Recommended):** The pages themselves should handle this. In `initState()` of both EventsPage and TasksPage, check if `Get.parameters['instance']` is null/empty and explicitly clear the instance filter on the VM. This way, normal tab navigation clears the filter, while drill-down navigation sets it.

**Option B:** No ArenaScaffold changes needed.

Choose Option A -- add the clearing logic to Phase 4 and Phase 7 `initState()` methods:
```dart
// If no instance param, clear any leftover instance filter.
if (instanceId == null || instanceId.isEmpty) {
  vm.setInstanceFilter(null);  // or vm.clearInstanceContext()
}
```

**Important caveat:** Since the pages are StatefulWidgets and bindings are permanent, `initState()` only runs once per widget creation. If the user navigates away and back, GetX may reuse the existing widget. To handle this reliably, consider using `GetX` route awareness or `onReady`-style hooks. The safest approach is to override `didChangeDependencies` or listen to route changes. However, since `Get.offNamed` destroys the previous route's widget and creates a new one, `initState()` will actually fire each time. This is safe with `Get.offNamed`.

## Testing Strategy

### Unit Tests (EventsViewModel)

**File:** `crimson-arena/.../test/features/events/controllers/events_view_model_test.dart`

Add tests for:
1. `setInstanceFilter` sets `selectedInstanceId` and resets offset to 0
2. `setInstanceFilter` with null clears instance state
3. `clearFilters` also clears instance filter state
4. `hasInstanceFilter` returns true/false correctly
5. `fetchHistory` passes `instanceId` to API call (verify with mocktail)
6. Live event filtering respects instance filter (create events with different `instanceId` values)
7. Update existing `getBrainEvents` mock to include the new `instanceId` named param

### Unit Tests (TasksViewModel)

Create new test file or add to existing:
1. `setInstanceContext` sets display state and project filter
2. `clearInstanceContext` resets instance display state
3. `hasInstanceContext` returns true/false correctly
4. `clearFilters` also clears instance context

### Integration Verification

1. Navigate from Instances page EVENTS button -- verify events page shows filtered results with context banner
2. Navigate from Instances page TASKS button -- verify tasks page shows project-filtered results with context banner
3. Click CLEAR on context banner -- verify returns to unfiltered view
4. Switch tabs via nav bar -- verify instance filter is cleared
5. Global project selector still works independently of instance filter
6. `flutter analyze` passes with zero issues

### Server-Side Tests

Verify `GET /api/events?instance_id=xxx` returns only events for that instance. This can be tested via curl against a running brain server or by adding a test in `brain-mcp-server/src/engine/__tests__/`.

## Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Permanent VM doesn't reset instance filter on tab switch | Medium | Medium | Explicitly clear in page `initState()` when no instance param present |
| `Get.offNamed` with query params URL-encodes special chars in hostname | Low | Low | Use `Uri.encodeComponent()` for hostname value in navigation URL |
| Tasks filter by project is too broad (shows all project tasks, not just that instance's) | Low | Low | Acceptable trade-off since tasks don't have `instanceId`. Context banner makes this clear |
| Existing test mock for `getBrainEvents` breaks when adding `instanceId` param | High | Low | Update mock in setUp to include `instanceId: any(named: 'instanceId')` |
| Live event feed filtering by instanceId may miss events where `instanceId` is null | Low | Low | Only filter when `selectedInstanceId` is non-null; null instanceId events are excluded, which is correct behavior |
