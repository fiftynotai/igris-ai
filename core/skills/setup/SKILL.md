---
name: setup
tier: essential
description: "First-run guided onboarding (teach the register → hunt → rest loop + a consented first hunt) OR reconfigure an existing install (shells `igris configure`). Branches on `igris onboarding status`. Usage: /setup"
disable-model-invocation: false
allowed-tools:
  - Read
  - Grep
  - Glob
  - Bash
triggers:
  - "SETUP"
  - "guided setup"
  - "first hunt"
  - "onboard me"
  - "reconfigure igris"
  - "re-take the tour"
---

# Setup Skill

The single entry point for a new user's first 2 minutes AND for reconfiguring a
mature install. Harness-agnostic and verb-driven: this skill RUNS deterministic
`igris` verbs and narrates their agnostic output — it contains ZERO
per-harness branches.

## Step 0 — Branch on onboarding state

Run the onboarding-status verb:
```bash
igris onboarding status --json
```
It prints `{ "completed": <bool>, "boot_welcomed": <bool>, "first_run": <bool> }`
where `first_run == !completed`.

- `first_run == true` → run the **Teach** path (§A).
- `first_run == false` → run the **Reconfigure** path (§B).
- If the verb is unavailable/errors (older CLI, degraded shell), default to the
  **Teach** path — a first-time user benefits from the tour; a returning user
  can still reach `/configure` from it.

---

## §A Teach path (first run)

Goal: orient the user, then GUIDE them through one real loop. Do NOT auto-drive a
full 4-agent hunt on their behalf — the user runs the slash commands; this skill
explains and hands off.

### A.1 Explain the loop (plainly)

Render, in plain language:

```
IGRIS turns intent into shipped work through three verbs:

  /register  — capture a unit of work as a BRIEF (feature, bug, or debt).
               A brief is the durable record of "what" and "why".
  /hunt      — build the active brief: an architect plans it, a forger writes
               the code, a sentinel tests it, a warden reviews it — then it's
               committed. Tested and reviewed, not vibes.
  /rest      — bank the session: the brain remembers what happened so your next
               /boot resumes exactly where you left off.

That's the whole loop. register → hunt → rest, repeat.
```

### A.2 Offer a consented `/ground` (first real action)

Grounding writes a `coding_guidelines` context doc so every future hunt follows
YOUR project's conventions. It is **repo-safe** — it writes only under
`~/.igris/`, never into the user's repository.

- ASK first: "Want me to capture this project's coding conventions now? I'll run
  `/ground coding_guidelines` — it writes only to `~/.igris`, never your repo."
- On YES: instruct the user to run `/ground coding_guidelines` (or, if the user
  asks you to drive it, invoke the ground skill). Narrate what it produced.
- On NO: skip — note they can run `/ground` any time.

### A.3 Guide the first `/register` → `/hunt`

- Walk the user into `/register`: help them phrase their first brief (a small,
  real piece of work — a feature or a bug). Let `/register` do the actual
  capture; do not fabricate a brief for them.
- Once a brief is active, point them at `/hunt` to build it. Explain that `/hunt`
  runs the full architect → forger → sentinel → warden loop and stops for their
  approval on the plan.
- Do NOT run the hunt for them end-to-end — this is a guided hand-off, not an
  autonomous build.

### A.4 Point at `/scan`

Mention `/scan` as the way to take stock later: "Run `/scan` any time to see
your briefs, blockers, and what's next."

### A.5 Mark onboarding complete

When the user has completed (or explicitly declined to continue) their first
loop, stamp completion so `/boot` and `/setup` treat them as a returning user
from now on:
```bash
igris onboarding complete
```
Confirm: "You're set up. Future boots are silent — run `/setup` again any time to
reconfigure."

---

## §B Reconfigure path (returning user)

Goal: let a mature user re-dial their install. Shell the already-shipped
`igris configure` verb — do NOT reimplement configuration here.

### B.1 Run `igris configure`

```bash
igris configure
```
`igris configure` interactively re-dials, seeding every prompt from live state
(Enter keeps the current value):
- **identity** (name, email),
- **persona** (SOUL preset),
- **remote brain** (VPS by address),
- **cognition toggles** (perception, subconscious — default OFF),
- **the three USER.md prefs**: addressing, notification style, auto-approve
  threshold.

Narrate the verb's agnostic summary back to the user. Every write is shown and
consented by `configure` itself (atomic + chmod 600).

### B.2 Offer to re-take the tour

Offer: "Want a refresher on the register → hunt → rest loop? I can walk the tour
again." On YES, render §A.1 (the loop explanation) — but do NOT reset onboarding
state (a returning user stays `completed`).
