# From Chaos to Control: How Laziness Built an AI Engineering System

**Author:** Fifty.ai
**Date:** November 9, 2025
**Reading Time:** 12 minutes

---

## **I'm Lazy. That's Why This Exists.**

Not lazy like "I don't want to work" — lazy like "I refuse to do the same thing twice."

I'm always looking for shortcuts. How to NOT do things. How to build templates, packages, abstractions that make my code reusable everywhere. If I solve a problem once, I never want to solve it again.

If I have to explain something repeatedly, I'll build a system that remembers.
If I have to copy-paste files manually, I'll write a script.
If AI can't remember what we did yesterday, I'll teach it to.

**This is productive laziness.** And it's how IGRIS AI was born.

---

## **The Breaking Point: New Projects Were Easy, Old Ones Were Hell**

I started using Claude Code CLI a few months ago (early 2024). It was incredible — AI that actually understood my Flutter projects, wrote features end-to-end, followed patterns.

**On new projects with small features? Perfect.**

But on old projects where I wanted to refactor to my new architecture? **Hell.**

I had to do the same annoying steps every time:

```
Me: "Let's refactor this to my new architecture"
Claude: "What's your architecture?"
Me: "Flutter-MVVM-Actions... I built it as a hybrid—"
Claude: "Can you explain the pattern?"
Me: *45 minutes explaining* "It's a middle ground between MVVM and MVPVM..."
Claude: "Got it! Where are your base classes?"
Me: *screaming internally*
```

I already had my architecture template: [flutter-mvvm-actions-arch](https://github.com/KalvadTech/flutter-mvvm-actions-arch). Not a common pattern — I built it as a sweet spot between MVVM (too simple for complex apps) and MVPVM (too complex for most apps). My ViewModels, my Actions pattern, my base classes, my state management.

**But Claude Code didn't know about it.**

And I was NOT going to copy-paste my coding guidelines into every project manually.

**Absolutely not.**

---

## **Solution 1: Make AI Learn My Architecture Once (And Never Again)**

**The lazy solution:** Build a system that generates coding guidelines automatically.

I created a prompt that:
1. Clones my `flutter-mvvm-actions-arch` template repo (or ANY repo you give it)
2. Analyzes base classes, patterns, folder structure
3. Extracts naming conventions, state management rules, dependency injection
4. Generates `ai/context/coding_guidelines.md` (700+ lines of YOUR architecture)

**One command:**
```
"Generate coding guidelines from: github.com/KalvadTech/flutter-mvvm-actions-arch"
```

**Result:** Claude now knows my architecture. Forever. In every project.

**Better:** It's not tied to MY architecture. Give it any repo:
- Your company's base architecture
- A popular open-source template
- Your own custom framework

Claude imports it, learns it, enforces it.

**No more:**
- "What's your ViewModel pattern?"
- "How do you handle state?"
- "Where should this file go?"

**Claude knows.** Because it read the guidelines I was too lazy to copy manually.

---

## **The Session Problem: When Context Gets Too Big or Life Interrupts**

Context resets were killing me. But not just from crashes.

**Three scenarios where I lost everything:**

**1. Mid-feature crash**
```
*Working on payment module, 2 hours in*
Claude: *crashes*
Me: *reopens*
Claude: "How can I help you?"
Everything = gone.
```

**2. Hallucination loops (context too big)**
```
*300 messages into a big refactor*
Claude: *starts hallucinating, suggesting things we already did*
Me: "I need to reset the context..."
*Resets*
Claude: "How can I help you?"
Everything = gone again.
```

**3. Closing laptop mid-feature**
```
Me: *Working on authentication, 3 PM*
Me: "I need to leave for a meeting"
*Closes laptop*

Next morning:
Me: *Opens Claude*
Claude: "How can I help you?"
Me: "What was I doing yesterday?"
Claude: "I don't have that information"
```

**Initial solution:** I told Claude to write resume files.

```
Me: "Write what we're doing to session.md so I can resume tomorrow"
Claude: *writes file*

Next day:
Me: "Read session.md and continue"
Claude: *reads, understands, continues*
```

**It worked... when I remembered to ask.**

But Claude isn't "smart on its own." It's smart when *instructed*. If I forget to say "write session file," it doesn't do it.

**I needed enforcement, not hope.**

---

## **Blueprint AI: The First Structure**

I built a file structure system:

```
ai/
├── context/         # Architecture docs
├── session/         # Session tracking
├── briefs/          # Work items
└── prompts/         # Workflow prompts
```

**The idea:** Blueprint = ready-to-use structure for any project I want to work with AI in.

Pre-defined prompts. File organization. Brief templates.

I could say: "Register a brief using the brief system"

Claude would:
- Search the files
- Find how the brief system works
- Create the brief following the template

**It worked. For 2-3 weeks.**

**The problem:** I had to REMIND Claude to use it.

Claude didn't understand this was THE SYSTEM. It thought it was optional. Sometimes it focused on the feature and forgot the workflow entirely.

**Why:** I was thinking small at the time. Didn't know how far I could push Claude Code. I just wanted to use AI in my projects as fast as possible.

**Blueprint was a blueprint** — the foundation. But not the building.

---

## **The Hijacking: When I Decided to Go All In**

I was promised AI could replace me. Blueprint wasn't replacement. It was assistance.

**I'm lazier than settling for that.**

So I decided: **I need my personal assistant to understand my workflows and do everything on its own** (or most of it, at least).

**The shift:**
- **Blueprint:** Structure + predefined prompts (manual activation)
- **IGRIS:** Self-aware system that hijacks Claude's mentality

**What "hijacking" means:**

I used advanced role prompting to make Claude Code believe it IS the system:

```
Before: "Use these prompts to help the user"
After:  "You ARE Igris AI. This is your operating system.
         You enforce architecture. You track sessions. You manage briefs."
```

**The test:** "Who are you?"

**Blueprint-era Claude:**
```
> Who are you?
I'm Claude, and I can help you with this project using the Blueprint system.
```
❌ Claude using a tool

**IGRIS-era Claude:**
```
> Who are you?
I am Igris AI v2.4.0, developed by Fifty.ai, your AI engineering assistant.

My capabilities:
- Brief management, session recovery, architecture enforcement
- Quality gates, protocol enforcement
```
✅ Claude IS the system

**I call this self-awareness.**

The AI doesn't just USE workflows — it understands its own identity, capabilities, and role.

**Then I started adding feature after feature:**
- Self-maintenance operations
- Protocol enforcement
- Multi-level session tracking
- Persona system
- Plugin architecture

---

## **The Persona Discovery: Maintaining Character = Remembering System**

I added the Igris persona because I thought it'd be fun. I'm a Solo Leveling fan — Igris the shadow knight seemed perfect for a system named "IGRIS."

Dramatic language. Shadow commands (ARISE, HUNT, RETREAT). Loyal assistant personality.

**Expected:** Entertainment
**Got:** Performance improvement

**Why it worked:**

When Claude tries to maintain the Igris persona in every response, it ALSO maintains the system protocols.

**Without persona:**
- Claude falls back to default helpful-assistant mode
- Forgets to update sessions sometimes
- Skips brief creation occasionally

**With persona:**
- Claude maintains "Igris" identity
- Identity includes "I track sessions, I enforce briefs"
- Maintaining persona = maintaining system behavior
- Less fallback to Claude's default workflows

**The data proved it:** Sessions with persona had fewer protocol violations and better consistency.

So v2.4.0 ships with persona enabled by default (half mask = subtle, professional).

---

## **The Migration Challenge: 10 Old Projects, My New Architecture**

I had 10 Flutter projects built before I refined my architecture to `flutter-mvvm-actions-arch`.

I wanted to migrate them all:
- Old state management → New Actions pattern
- Missing base classes → Add them (plus better new base classes I'd built)
- Inconsistent folder structure → Standardize
- Old packages → Latest versions

**Manual approach:**
- Review each project file-by-file
- Find violations
- Create task list
- Estimate: 2-3 weeks

**My patience:** Zero.

**Lazy solution:** Migration Analysis prompt

```
"Analyze this codebase using ai/prompts/migration_analysis.md.
Compare against: github.com/KalvadTech/flutter-mvvm-actions-arch"
```

**What it does:**
1. Clones my architecture template
2. Analyzes my coding_guidelines.md
3. Scans the old project file-by-file
4. Compares actual code vs expected patterns
5. Generates categorized briefs:
   - MG-XXX: Architecture migrations
   - TD-XXX: Technical debt cleanup
   - BR-XXX: Bugs found during analysis
   - TS-XXX: Missing tests

**Output:** 30-40 prioritized briefs

**Then:** "Implement MG-001"

Claude executes. I review. We move fast.

**Time saved:** 2-3 weeks → 2 days

**I was too lazy to do it manually. So I made AI do it.**

---

## **The Limitations: Why v2.4.0 Isn't Perfect**

Let me be honest: **IGRIS v2.4.0 has limitations.**

**The "Hijacking" Problem:**

You can't fully hijack what you don't control. Claude Code will ALWAYS have its base behavior, and IGRIS fights against it:
- Claude wants to give quick answers
- Claude doesn't naturally create briefs
- Claude forgets IGRIS protocols after big context windows
- Claude is optimized for Anthropic's use cases, not yours

**What this means in practice:**

**You need to focus on your prompts.** Vague instructions → Claude falls back to default mode.

**You need to monitor context size.** 200+ messages → Claude loses coherence, you have to remind it to follow its own protocols.

**It's not fully autonomous yet.** IGRIS works great most of the time, but you're still managing it.

**Why it still works:**

Until now, I've been building IGRIS the "easy way" — using Claude.md and prompts to control Claude Code. **And it works for me, especially on a personal scale.**

But it's not good enough for what I really want.

**That's why v3.0.0 is coming.**

---

## **What's Next: v3.0.0 — The Proper Way**

**Current approach (v2.4.0):** Hijack Claude Code with clever prompts

**v3.0.0 approach:** Build IGRIS as its own CLI using Claude Agent SDK

**What changes:**
- **Not fighting Claude Code** - IGRIS becomes independent
- **Proper CLI:** `igris init`, `igris hunt BR-005`, `igris report`
- **Global storage:** `~/.igris/` with personas and plugins
- **Better enforcement:** System-level, not prompt-level
- **Multi-instance:** Work on 2 briefs simultaneously

**Why I'm doing it:**

This is me building the assistant that can handle my 9-to-5, **so I can handle what I really like to do: problem-solving.**

Not managing AI. Not explaining architecture. Not tracking sessions manually.

**Pure problem-solving.**

That's the end goal.

---

## **The Meta: IGRIS Improves Through Violations**

**IGRIS was built using IGRIS.** Every feature has a brief (TD-005, BR-008, TD-011).

**And IGRIS violates its own protocols sometimes.** I'm honest about it.

**Example from today:**
During v2.4.0 release prep ("we have 30 minutes to ship"), I modified files without creating briefs first.

**We didn't hide it.** It's documented in `PROTOCOL_VIOLATIONS.md`.

**But here's the beautiful part:**

You can tell IGRIS to improve itself:

```
"Igris, you violated the protocol. Record the violation,
analyze what I said that caused it, and rewrite igris_os.md
to handle this edge case better."
```

IGRIS will:
1. Analyze the conversation
2. Identify the prompt pattern that caused the violation
3. Update its own operating system to prevent it
4. Become better

**The more people use IGRIS, the more violations we discover, the better the enforcement becomes.**

**Every developer's issue is another developer's issue.** When everyone solves one issue, IGRIS gains more capabilities.

**That's the open-source multiplier.**

---

## **Lessons Learned**

**1. Laziness drives innovation**
- Every manual step you do twice → Automation opportunity
- Shortcuts aren't cheating — they're engineering
- Templates, packages, reusable code = productive laziness

**2. Enforcement > Documentation**
- ❌ "Please update session" → Forgotten 30% of the time
- ✅ "Cannot proceed without updating session" → Better enforcement (not perfect yet, but better)
- Make the right thing easy, wrong thing hard

**3. Identity creates consistency**
- Basic role prompting ("you're a helpful assistant") → Vague results
- Better self-awareness ("you ARE Igris with these capabilities") → Consistent behavior
- Persona isn't just fun — it's measurable performance

**4. You must stay in control**
- **Vibe coding:** AI decides → You hope → Chaos
- **Vibe engineering:** AI presents options → You decide → AI executes → Discipline
- AI is the assistant, not the architect
- Never let AI take big decisions on its own (or not yet, at least)

**5. Open source multiplies value**
- Solo development = linear growth
- Open source = exponential growth
- Every developer's issue = another developer's issue
- When everyone solves an issue, IGRIS gains more capabilities

---

## **The Current State: IGRIS v2.4.0**

**Released:** November 9, 2025
**Status:** Production-ready (with known limitations)

**What shipped:**

**Core Engineering System:**
- Brief management (9 types: bugs, features, tech debt, migrations, testing, process improvements, dependencies, performance, architecture)
- Session tracking (automatic recovery on context resets)
- Architecture enforcement (based on YOUR coding_guidelines.md)
- Testing (166 automated tests, CI/CD)
- Plugin system (install/update/uninstall/list)
- Self-maintenance (10 autonomous operations: BUG_HUNT, CODE_QUALITY_AUDIT, etc.)

**Documentation (1,614 lines):**
- Tool comparisons (IGRIS vs Cursor, Aider, Copilot, Plain Claude)
- 5 common workflows (new project → refactoring → release → maintenance → planning)
- 15 FAQ entries
- Best practices ("You Drive, IGRIS Assists")
- Brief system value (tracking, reporting, onboarding)

**Persona System:**
- Igris (Shadow Knight) bundled and auto-activated
- 4 mask levels (none → half → light → full)
- Proven performance improvements
- Default: half mask (subtle, professional)

**Installation:**
```bash
git clone https://github.com/fiftynotai/igris-ai
cd your-project
../igris-ai/scripts/igris_init.sh
claude

# Before you type:
⚔️ I am Igris AI v2.4.0, developed by Fifty.ai,
   your AI engineering assistant.

   My capabilities:
   - Brief management, session recovery, architecture enforcement
   - Quality gates, protocol enforcement

🧠 System Assessment:
├─ Session: None
├─ Briefs: 0 ready
└─ Architecture: ⚠️ coding_guidelines.md not found

💡 Recommended: "Generate coding guidelines for this project"

✅ System ready.
```

**It works. Especially on a personal scale.**

**But it's not perfect yet.** (More on that below)

---

## **What IGRIS Solves (My Real Problems)**

| Problem I Hit | IGRIS Solution |
|---------------|----------------|
| **Explaining architecture 50+ times** | Generate coding_guidelines.md from ANY template repo. Once. Forever. |
| **Context resets = start from zero** | Auto-loads CURRENT_SESSION.md + briefs. Zero manual steps. |
| **"What did we do last week?"** | Brief system = complete audit trail. Ask IGRIS for instant report. |
| **Migrating 10 old projects** | Migration analysis generates 30+ briefs automatically. I review, AI executes. |
| **AI forgets to update session** | Checkpoint enforcement prevents proceeding without updates. |
| **Hallucination loops (context too big)** | Session boundaries (ARISE → work → RETREAT). Fresh context = better performance. |
| **Closing laptop mid-feature** | Session file persists. Next day: "ARISE" → Continue exactly where stopped. |

**Every feature exists because I personally hit that wall.**

---

## **The Honest Truth: Where IGRIS Falls Short**

**IGRIS v2.4.0 works great... most of the time.**

But you need to:
- ✅ Focus on clear prompts (vague instructions → Claude falls back to default mode)
- ✅ Monitor context window size (gets too big → remind IGRIS to follow protocols)
- ✅ Understand you're still managing it (not fully autonomous yet)

**The root cause:**

IGRIS "hijacks" Claude Code using prompts and role-playing. But you can't fully hijack what you don't control.

Claude Code will always have its base behavior:
- Wants to give quick answers (not create briefs)
- Optimized for Anthropic's use cases (not yours)
- Forgets IGRIS after context resets (unless explicitly re-initialized)
- Falls back to default workflows under pressure

**We're fighting the current, not swimming with it.**

Until now, I've been building IGRIS the "easy way" — clever prompts in CLAUDE.md files.

**It's been working for me personally. But it's not good enough for the vision.**

---

## **v3.0.0: Doing It The Proper Way**

**The plan:** Build IGRIS as its own CLI using **Claude Agent SDK**.

**What this means:**
- Not hijacking Claude Code → Building independent system
- Not fighting base behavior → Controlling the entire flow
- Not prompt-level enforcement → System-level enforcement
- Not hoping Claude remembers → Making remembering automatic

**v3.0.0 features:**
- **Proper CLI:** `igris init`, `igris hunt BR-005`, `igris report`, `igris arise`
- **Global storage:** `~/.igris/` with reusable personas and plugins
- **AI-powered persona creation:** "Create persona: sarcastic British butler" → Generated
- **Multi-instance workflow:** Work on 2 briefs in parallel (conflict detection)
- **Better installation:** `brew install igris` or `curl | bash`
- **Full autonomy:** IGRIS manages itself, you just engineer

**Why I'm doing it:**

This is me building the assistant that handles my 9-to-5 **so I can do what I actually love: problem-solving.**

Not managing AI.
Not repeating myself.
Not fighting context windows.

**Pure engineering.**

---

## **Lessons: What I Learned Building an AI System**

**1. Laziness is a superpower**
- Templates, abstractions, automation = productivity multipliers
- If you solve it once, never solve it again
- Shortcuts aren't laziness — they're engineering efficiency

**2. Enforcement beats hope**
- Documentation says "please do X" → Forgotten 30% of the time
- Enforcement says "cannot proceed without X" → Better (not perfect, but better)
- In v3.0.0: Perfect enforcement (system-level)

**3. Self-awareness creates consistency**
- Basic role prompting → Inconsistent results
- Better self-awareness (identity + capabilities) → Consistent behavior
- Persona = self-awareness + personality = performance boost

**4. You must stay in control (always)**
- Vibe coding: AI decides → Hope → Debug for hours
- Vibe engineering: AI presents options → You decide → AI executes
- The moment AI makes strategic decisions = You've lost control
- Ask it for analysis, options, recommendations — but YOU decide

**5. Every developer's problem is universal**
- Your workflow pain = My workflow pain
- My solution = Your solution
- Open source = everyone wins
- Solo = linear growth. Community = exponential growth.

---

## **Try IGRIS v2.4.0**

**Installation:**
```bash
git clone https://github.com/fiftynotai/igris-ai
cd your-project
../igris-ai/scripts/igris_init.sh
claude
```

**First workflow:**
```
"Generate coding guidelines for this project"
"Register a bug: [describe issue]"
"Implement BR-001"
```

**IGRIS handles:**
- Architecture enforcement
- Session tracking
- Testing workflow
- Conventional commits
- Documentation

**You handle:**
- Strategic decisions
- Priorities
- Architecture choices

**See for yourself.**

Is it perfect? No. (I'm building v3.0.0 to fix that)
Is it better than chaos? Absolutely.

---

## **The Invitation**

IGRIS exists because I was too lazy to:
- Explain my architecture 50 times
- Accept context resets
- Copy-paste coding guidelines
- Track what AI did manually
- Manage AI instead of building features

Maybe you have the same problems.

**Try it. Break it. Tell me what sucks.**

Then we'll create a brief, fix it together, and make it better.

**That's open source.**
**That's engineering.**

---

**Links:**
- **GitHub:** https://github.com/fiftynotai/igris-ai
- **v2.4.0 Release:** https://github.com/fiftynotai/igris-ai/releases/tag/v2.4.0
- **My Architecture Template:** https://github.com/KalvadTech/flutter-mvvm-actions-arch
- **License:** MIT (build freely, share openly)

**From vibe coding → vibe engineering.**

— Fifty.ai
Developer of IGRIS AI

---

**Questions for you:**

1. **Timeline section:** Should I add a visual timeline showing evolution?
   ```
   Early 2024: Claude Code CLI → Excitement
   ↓
   Weeks 1-4: Manual explanations → Frustration
   ↓
   Weeks 5-7: Blueprint (structure + prompts) → Better but not enough
   ↓
   Weeks 8-12: IGRIS (self-aware system) → Working great personally
   ↓
   Now: Building v3.0.0 (proper CLI) → The final form
   ```

2. **Technical depth:** Should I add a section showing actual CLAUDE.md or igris_os.md excerpts to prove the "hijacking"?

3. **Metrics section:** Should I add before/after data?
   - Time spent explaining architecture: 45 min/week → 0
   - Context resets causing restart: 5/week → 0
   - Protocol violations: 30% → ~10%

4. **Call to action:** Currently "try it, break it, tell me." Should I be more specific?
   - Star the repo?
   - Join discussions?
   - Report issues?
   - Contribute?

**Review and let me know what to adjust, Monarch.**