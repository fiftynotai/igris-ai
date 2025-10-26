# PF-XXX: [Performance Optimization Title]

**Type:** Performance Optimization
**Priority:** [P0-Critical | P1-High | P2-Medium | P3-Low]
**Effort:** [S-Small (< 4h) | M-Medium (1-2d) | L-Large (3-5d) | XL-Extra Large (>1w)]
**Assignee:** Igris AI
**Commanded By:** [User name from persona.json if available, otherwise "Not specified"]
**Status:** [Draft | Ready | In Progress | Done]
**Created:** [YYYY-MM-DD]
**Completed:** [YYYY-MM-DD] _(if Status: Done)_

---

## Performance Issue

**What's slow?**

[Describe the performance problem. Be specific about what operation is slow.]

**How slow is it?**
- **Current:** [Time/resource metric - e.g., 5.2 seconds, 200MB memory]
- **Expected:** [Acceptable benchmark - e.g., < 2 seconds, < 100MB memory]
- **Gap:** [Difference - e.g., 3.2 seconds too slow, 100MB excess]

**When does it occur?**
- [ ] Startup/initialization
- [ ] During specific operation: [which one]
- [ ] Under load: [what conditions]
- [ ] Always slow
- [ ] Intermittent: [pattern]

---

## Impact

**User Experience Impact:**
- [ ] Critical: Users can't complete tasks (timeout/crash)
- [ ] High: Users frustrated, workflow disrupted
- [ ] Medium: Noticeable delay, acceptable but annoying
- [ ] Low: Barely noticeable, optimization for efficiency

**Business Impact:**
- [ ] Cost: [e.g., Increased server costs]
- [ ] Scale: [e.g., Can't support more than X users]
- [ ] Reputation: [e.g., Users complaining about speed]

**Frequency:**
- [How often does this slow operation happen?]
- [How many users affected?]

---

## Root Cause Analysis

**Profiling Results:**
[Show data from profiling/benchmarking]

**Bottleneck Identified:**
- Primary bottleneck: [e.g., Database query N+1 problem]
- Secondary factors: [e.g., Unnecessary API calls, inefficient algorithm]

**Evidence:**
```
[Profiler output, logs, or benchmark data showing the bottleneck]
```

**Why is it slow?**
[Explain the technical reason for poor performance]

---

## Optimization Approach

### Strategy
[Describe the optimization strategy at a high level]

**Techniques to apply:**
- [ ] Algorithm optimization (reduce complexity)
- [ ] Caching (avoid redundant work)
- [ ] Lazy loading (defer work)
- [ ] Parallelization (concurrent execution)
- [ ] Database optimization (indexing, query optimization)
- [ ] Resource pooling (reuse connections/objects)
- [ ] Code optimization (remove inefficiencies)
- [ ] Other: [specify]

### Implementation Plan
1. [Step 1: e.g., Add caching layer]
2. [Step 2: e.g., Optimize database query]
3. [Step 3: e.g., Implement lazy loading]

---

## Benchmark Plan

### Baseline Metrics (Before Optimization)
**Test Scenario:** [Describe realistic test case]

| Metric | Current | Target | Method |
|--------|---------|--------|--------|
| Execution time | [X seconds] | [Y seconds] | [How measured] |
| Memory usage | [X MB] | [Y MB] | [How measured] |
| CPU usage | [X%] | [Y%] | [How measured] |
| Network calls | [X requests] | [Y requests] | [How measured] |
| Database queries | [X queries] | [Y queries] | [How measured] |

**Benchmark command/script:**
```bash
[How to reproduce benchmark]
```

### Target Metrics (After Optimization)
[Show expected improvement]

---

## Trade-offs

**What are we trading for performance?**

**Option A: [Optimization approach 1]**
- ✅ Pros: [Benefits]
- ❌ Cons: [Costs - e.g., Increased complexity, more memory]
- Trade-off: [What we give up for speed]

**Option B: [Optimization approach 2]**
- ✅ Pros: [Benefits]
- ❌ Cons: [Costs]
- Trade-off: [What we give up for speed]

**Chosen approach:** [Which one and why]

**Acceptable trade-offs:**
- [e.g., 20% more memory for 50% faster execution]
- [e.g., Slight code complexity increase for significant speed gain]

---

## Context & Inputs

### Affected Components
- [Component 1: how performance changes]
- [Component 2: how performance changes]

### Files to Modify
- [File 1: what optimization]
- [File 2: what optimization]

### Dependencies
- [ ] Profiling tool: [name]
- [ ] Benchmark tool: [name]
- [ ] New library needed: [if caching/pooling library required]

---

## Constraints

### Performance Targets
- **Execution time:** Must be < [X seconds]
- **Memory:** Must use < [X MB]
- **CPU:** Must use < [X%]

### Quality Constraints
- Must not break existing functionality
- Must maintain code readability
- Must not introduce bugs
- Must be maintainable (no over-optimization)

### Timeline
- **Deadline:** [Date or N/A]
- **Milestones:** [Optional checkpoints]

### Out of Scope
- [Other performance issues not addressed in this brief]

---

## Tasks

### Pending
- [ ] Task 1: [Description of work to be done]
- [ ] Task 2: [Description of work to be done]
- [ ] Task 3: [Description of work to be done]

### In Progress
_(Tasks currently being worked on)_
- [x] Task X: [Description] (started: YYYY-MM-DD HH:MM)

### Completed
_(Finished tasks)_
- [x] Task Y: [Description] (completed: YYYY-MM-DD HH:MM)

**Note:** Update this section as you work. Mark tasks in_progress when starting, completed when done. Add timestamps.

---

## Session State (Tactical - This Brief)

**Current State:** [What you're working on RIGHT NOW in this brief]
**Next Steps When Resuming:** [Exact continuation point if interrupted]
**Last Updated:** [YYYY-MM-DD HH:MM]
**Blockers:** [Any blockers specific to this brief, or "None"]

**Note:** Strategic session state (overall plan/phase across multiple briefs) managed in `ai/session/CURRENT_SESSION.md`

---

## Acceptance Criteria

**The optimization is complete when:**

1. [ ] Target performance metrics achieved
2. [ ] All benchmarks pass
3. [ ] No regressions in functionality
4. [ ] No regressions in other performance areas
5. [ ] All tests pass
6. [ ] Code review approves changes
7. [ ] Documentation updated (if algorithm changed)

---

## Test Plan

### Performance Tests
**Benchmark 1: [Test Scenario]**
**Setup:** [How to set up test]
**Command:** `[benchmark command]`
**Expected Result:** < [X seconds / X MB / etc.]
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

**Benchmark 2: [Stress Test]**
**Setup:** [How to set up test]
**Command:** `[benchmark command]`
**Expected Result:** [Metric under load]
**Actual Result:** [Fill during testing]
**Status:** [ ] Pass / [ ] Fail

### Regression Tests
- [ ] Existing feature X still works
- [ ] No memory leaks introduced
- [ ] No correctness bugs introduced
- [ ] Other performance areas not degraded

---

## Delivery

### Performance Results

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| Execution time | [X s] | [Y s] | [Z%] faster |
| Memory usage | [X MB] | [Y MB] | [Z%] reduction |
| CPU usage | [X%] | [Y%] | [Z%] reduction |
| [Other metric] | [X] | [Y] | [Z%] improvement |

### Changes Summary
- Optimizations applied: [count]
- Files modified: [count]
- Complexity trade-off: [Acceptable/Minimal/None]

### Documentation
- [ ] Performance notes: [Document optimization technique]
- [ ] Code comments: [Explain non-obvious optimizations]
- [ ] Benchmark scripts: [Saved for future verification]

---

## Notes

**Profiling Data:**
[Include profiler screenshots, flame graphs, or detailed analysis]

**References:**
- [Algorithm/technique used]
- [Articles/papers consulted]

**Future Optimizations:**
- [Ideas for further optimization if needed]
- [Next bottlenecks to address]

---

**Created:** [Date]
**Last Updated:** [Date]
**Brief Owner:** [Name]
