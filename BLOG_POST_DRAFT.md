# From Chaos to Control: How Laziness Built an AI Engineering System

**Draft for Medium Blog Post**
**Author:** Fifty.ai
**Date:** November 9, 2025
**Status:** Draft - Add your notes below each section

---

## **Opening Hook**

*I'm lazy. Productively lazy.*

Not lazy like "I don't want to work" — lazy like "I refuse to do the same thing twice."

If I have to explain something repeatedly, I'll build a system that remembers.
If I have to copy-paste files manually, I'll write a script.
If AI can't remember what we did yesterday, I'll teach it to.

**This is productive laziness.** And it's how IGRIS AI was born.

**[YOUR NOTES:]**
i always look for shortcuts. how to not do stuff, how to build template how to build a package, how to make my code reusable everywhere


---

## **The Breaking Point: Explaining My Architecture for the 50th Time**

I started using Claude Code CLI in early 2024. It was incredible — AI that actually understood my Flutter projects, wrote features end-to-end, followed patterns.

**For one sprint, it was perfect.**

Then sprint two came. Context reset. And I had to explain *everything* again:

```
Me: "Let's add a payment feature"
Claude: "Sure! What's your architecture?"
Me: "Flutter-MVVM-Actions... it's a hybrid I built—"
Claude: "MVVM with Actions? Can you explain?"
Me: *deep breath* "It's a middle ground between MVVM and MVPVM..."
```

**50 conversations later, I was done.**

I already had my architecture template repo: `flutter-mvvm-actions-arch`. It's not a common pattern — I built it as a sweet spot between MVVM (too simple) and MVPVM (too complex). My views, my ViewModels, my base classes, my state management approach.

**But Claude Code didn't know about it.**

And I was NOT going to copy-paste my coding guidelines into every project manually. Absolutely not.

**[YOUR NOTES:]**
something like that:
i started using claude code couple month ago, i was amazed but it was easy to use it in a new project on small features but in an old project where i want to refactor them to my new structure architucure it was hard and i needed to do the same annoying steps everytime

use the link https://github.com/KalvadTech/flutter-mvvm-actions-arch
---

## **Solution 1: Make AI Learn My Architecture Once**

**The lazy solution:** Build a system that generates coding guidelines automatically.

I created a prompt that:
1. Clones my `flutter-mvvm-actions-arch` template repo
2. Analyzes my base classes, patterns, folder structure
3. Extracts naming conventions, state management rules, dependency injection patterns
4. Generates `ai/context/coding_guidelines.md` (700+ lines)

**One command:**
```
"Generate coding guidelines using my template repo:
github.com/yourname/flutter-mvvm-actions-arch"
```

**Result:** Claude now knows my architecture. Forever. In every project.

**No more:**
- "What's your ViewModel pattern?"
- "How do you handle state?"
- "Where should this file go?"

**Claude knows.** Because it read the guidelines I was too lazy to copy manually.

**[YOUR NOTES:]**

**Result:** Claude now knows my architecture. Forever. In every project.
 claude now can import my architucre and coding guideline in any project + plus do the same from anu repo deosn't have to be my arch

---

## **The Session Problem: "Wait, What Were We Doing?"**

Context resets were killing me.

Mid-feature, Claude crashes. I reopen. It asks: "How can I help you?"

**Everything gone.**

**Progress lost. Decisions forgotten. 20 minutes of work = vanished.**

**First attempt:** Create `CURRENT_SESSION.md`

```markdown
Session Goal: Implement BR-012 (Payment Module)
Current Task: Writing PaymentService tests
Next Step: Test Stripe integration
Blockers: Need API key from backend team
```

**And I told Claude:** "Update this file after every task."

**It worked... sometimes.**

**The problem:** Claude isn't "smart on its own." It's smart when *instructed*. If I don't remind it to update the session, it forgets.

**I needed enforcement, not hope.**

**[YOUR NOTES:]**
Mid-feature, Claude crashes. I reopen. It asks: "How can I help you?"
mid feature couple doing a big refactor, or when ai get into the hallucination loop because the context is too big to handle. and i need to reset the context it started by whenever i feel like i need to reset i tell claude to write what we are doing in a file. if i want to close my laptop leave work mid feature too i tell it to right a resume session file so tomorrow when i open the cli again i tell it to read the resume session file so it can understand what i'm doing.


---

## **Building Enforcement: Make Forgetting Impossible**

**The insight:** Don't ask AI to remember. Make the system prevent forgetting.

**Layer 1: Automatic Initialization**
- Claude Code startup hook (`.claude/hooks/startup.sh`)
- Runs BEFORE any user input
- Loads `CURRENT_SESSION.md` automatically
- Shows session status on launch

**No more typing:** "Read the session file and tell me where we are"
**Now:** You open Claude, it already knows.

**Layer 2: Brief-First Workflow**
- Want to modify code? Create a brief first.
- Brief template forces structure:
  - What's the problem?
  - What's the expected outcome?
  - How do we test it?
  - Priority? Effort estimate?

**Result:** Every feature has a paper trail. No more "what were we thinking when we built this?"

**Layer 3: Checkpoint Enforcement**
```
Before modifying files:
- Check: Does brief exist? (if no → stop, create brief first)
- Check: Session loaded? (if no → load it)

After completing task:
- Update session (not optional, system enforces it)
- Update brief status (automatic)
- Update TodoWrite (syncs to brief file)
```

**Forgetting is now structurally impossible.**

**This was Blueprint AI** - my personal workflow system that worked flawlessly for months.

**[YOUR NOTES:]**

worked kinda good for a while, but wasn't good enough for me. claude didn't understand the role and thought the system is optional and some times it focus on the feature and forget the workflow

---

## **The Migration Challenge: 10 Old Projects, 1 New Standard**

I had 10 Flutter projects. All built before I refined my architecture to `flutter-mvvm-actions-arch`.

I wanted to migrate them all:
- Old state management → New Actions pattern
- Missing base classes → Add them
- Inconsistent folder structure → Standardize
- Old packages → Latest versions

**Manual approach:**
- Review each project file-by-file
- Find violations
- Create task list
- Estimate: 2-3 weeks

**My patience:** Exactly zero.

**Lazy solution:** Migration Analysis System

```
"Analyze this codebase using ai/prompts/migration_analysis.md.
Compare against: github.com/yourname/flutter-mvvm-actions-arch"
```

**What it does:**
1. Clones my architecture template repo
2. Analyzes my coding_guidelines.md (generated earlier)
3. Scans the old project file-by-file
4. Compares actual code vs expected patterns
5. Generates categorized briefs:
   - **MG-XXX:** Architecture migrations (e.g., "Migrate LoginViewModel to Actions pattern")
   - **TD-XXX:** Technical debt (e.g., "Remove deprecated BaseController")
   - **BR-XXX:** Bugs found (e.g., "Null safety violation in PaymentService")
   - **TS-XXX:** Missing tests (e.g., "No tests for AuthViewModel")

**Output:** 30-40 prioritized briefs with exact tasks

**Then I just say:** "Implement MG-001"

Claude:
- Reads the brief
- Knows my architecture (from coding_guidelines.md)
- Implements the migration
- Writes tests
- Commits with conventional format

**Time saved:** 2-3 weeks → 2 days (AI does grunt work, I review and approve)

**I was too lazy to do it manually. So I made AI do it.**

**[YOUR NOTES:]**
- Missing base classes → Add them + better new base classes



---

## **The Expansion: From Personal Tool to Open Platform**

Blueprint worked perfectly for me. For months. Across multiple projects.

But I realized: **This isn't just MY problem.**

Every developer using Claude Code hits the same issues:
- Context resets
- Repeated explanations
- No memory between sessions
- No accountability ("what did AI do last week?")

**The vision expanded:**

What if instead of Claude Code being "a CLI with prompts," it became "an engineering system"?

What if I could **hijack Claude Code's entire mentality** — not as a hack, but as the designed experience?

**That's when Blueprint became IGRIS.**

**The shift:**
- **Blueprint:** My personal workflow (closed source, just me)
- **IGRIS:** A platform (open source, anyone can use/extend)

**New architecture:**
- **Plugin system:** Platform-specific tools (Flutter, React Native, web)
- **9 brief types:** Not just bugs/features — tech debt, migrations, testing, performance, dependencies
- **Self-maintenance:** IGRIS audits itself (10 autonomous operations like BUG_HUNT, CODE_QUALITY_AUDIT)
- **Protocol enforcement:** Make violations structurally impossible (not just discouraged)
- **Persona system:** Customize AI identity for performance
- **Testing:** 166 automated tests, CI/CD on GitHub Actions

**From personal tool → Engineering platform**

**[YOUR NOTES:]**

Blueprint worked perfectly for me. For months. Across multiple projects.
 i used blueprint for two three weeks, wasn't the best you will find a not above saying this.
my main idea about blueprint is a structure of workflows an organized way to work with claude code a ready prompts to use i just tell claude code to do somehting using the prompt file bla bla.
i tell claude code to do register a brief using the brief system claude search the files find the brief system and how it works and create the brief
igris is when i decided i'm still lazier than settling for that i was promised ai can replace me this isn't replacement so i need my personal assistance to understand my workflows and be able to do everything in his own or for the most part at least.
so i made a better prompts create to create igris decided to use role prompting to hijack claude mentality until i reached what i love to call selfawarenss i ask claude code who are you and it answers i'm igris what is you cutabilities and it list the features we had remembered that need to tell him who he is and what should he do with it.
an i started adding feature after feature

---

## **The Persona Discovery: When Fun Became Performance**

I added personas as an experiment. I'm a Solo Leveling fan, so I created "Igris" (shadow knight character) with:
- Dramatic language ("The shadow rises, Monarch")
- Shadow commands (ARISE, HUNT, RETREAT instead of start/implement/save)
- Loyal assistant personality

**Expected:** Entertainment value, personal fun
**Got:** Measurable performance boost

**The data:**
- Sessions with persona: Fewer protocol violations, better session updates, clearer communication
- Sessions without persona: More reminders needed, occasional skipped checkpoints

**Why it works:**

Instead of Claude being "helpful AI assistant" (vague role), it becomes "Igris, your engineering assistant with exact capabilities: brief management, session recovery, architecture enforcement" (specific identity).

**Stable identity = Consistent behavior = Better performance**

**So v2.4.0 ships with Igris persona by default.**

Users can adjust intensity:
- **Half mask** (default): Subtle, professional ("I am Igris AI v2.4.0...")
- **Light mask:** Personality hints, balanced
- **Full mask:** Complete immersion (shadow commands, dramatic language)
- **None:** Standard Claude (persona dormant)

**Or remove it entirely.** It's optional. But the default works.

**[YOUR NOTES:]**

while i was playing with creating a persona becuase i thought it's fun spacially since i decided to go with a fun name from and anime like igirs i wanted to make it more like igris this where i found out that the persona is making claude remember the system more because it's trying to maintain the system persona in every response which lead to a better performance overall and less fallback to claude default workflows.



---

## **What IGRIS Actually Does (The Honest Version)**

**My original problems → IGRIS solutions:**

| Problem I Hit | How IGRIS Solves It |
|---------------|---------------------|
| **Explaining my architecture 50+ times** | `generate_coding_guidelines.md` - Analyzes my template repo once, remembers forever |
| **Context resets lose everything** | Auto-loads `CURRENT_SESSION.md` + briefs on startup. Zero manual steps. |
| **"What did we do last week?"** | Brief system = complete audit trail. `"Show last week's work"` → Instant report |
| **Migrating 10 old projects to new architecture** | `migration_analysis.md` - Compares project vs template, generates 30+ migration briefs automatically |
| **AI forgets to update session** | Checkpoint enforcement - System prevents proceeding without updates |
| **Manually copying coding guidelines to every project** | Automation. Never copy-paste again. |
| **Long conversations degrade** | Session boundaries (ARISE → work → RETREAT), fresh context = better performance |

**Every feature exists because I personally hit that wall** and refused to accept it.

**[YOUR NOTES:]**



---

## **Real Usage: What It Looks Like**

**Scenario 1: You Notice a Blocker**
```
You: "Igris, we're blocked on BR-012. Backend endpoint /api/users
     returns 500 instead of user data. Record this in BLOCKERS.md."

IGRIS:
✅ Blocker recorded in BLOCKERS.md
✅ BR-012 brief updated with blocker info
✅ Session state saved

Do you want to create a brief for the backend team?
```

**Scenario 2: Team Handoff**
```
You: "I'm going offline. Update session with exact stopping point
     for BR-025. What should next person know?"

IGRIS:
✅ CURRENT_SESSION.md updated
✅ "Next Steps When Resuming" documented
✅ Uncommitted changes listed

Summary for handoff:
- BR-025 at 60% complete
- Payment validation implemented
- Tests pending
- Next: Write integration tests for Stripe webhook
```

**Teammate opens Claude later:**
```
Teammate: "What was the last person working on?"

IGRIS: *Reads session*
Active brief: BR-025 (Payment Module)
Status: In Progress (Phase 3 of 5)
Last update: 2 hours ago by Fifty.ai
Next steps: Stripe integration tests

Continue implementation?
```

**Scenario 3: Weekly Reporting**
```
You: "Create summary report of our work this week"

IGRIS: *Reads completed briefs from Nov 4-9*

📊 Week of Nov 4-9, 2025

Completed:
✅ 3 bugs fixed (BR-007, BR-009, BR-010)
✅ 2 features shipped (persona system, README overhaul)
✅ 1 migration completed (Blueprint→IGRIS auto-migration)

Metrics:
- 22 commits
- 5,762 lines added
- 4 briefs (1 P0, 2 P1, 1 P2)

Velocity: Excellent
Quality: All tests passing
```

**You drive. IGRIS remembers and executes.**

**[YOUR NOTES:]**



---

## **The Architecture: Why It's Different**

People ask: "Is IGRIS like Cursor AI? Like Aider?"

**No. Different category entirely.**

**Cursor/Aider/Copilot:** Tools that enhance your editor or add AI to your CLI
**IGRIS:** A system that orchestrates Claude Code to become an engineering platform

**The stack:**
```
┌─────────────────────┐
│   You (Architect)   │  ← Make decisions, set direction
└──────────┬──────────┘
           │ commands
           ↓
┌─────────────────────┐
│  IGRIS (System)     │  ← Structure, enforcement, memory
│  - Briefs           │
│  - Session tracking │
│  - Architecture     │
│  - Protocols        │
└──────────┬──────────┘
           │ orchestrates
           ↓
┌─────────────────────┐
│  Claude Code (CLI)  │  ← Execution layer
└──────────┬──────────┘
           │ powered by
           ↓
┌─────────────────────┐
│  Claude (Model)     │  ← Intelligence
└─────────────────────┘
```

**Think of it:**
- **Claude** = The engine (raw intelligence)
- **IGRIS** = The vehicle (steering, brakes, navigation, dashboard, memory)
- **You** = The driver (destination, decisions, control)

You wouldn't drive a car without brakes or a dashboard showing speed.
Why use AI without structure or memory?

**[YOUR NOTES:]**



---

## **The Meta Moment: IGRIS Built IGRIS**

Here's the beautiful part:

**IGRIS was built using IGRIS.**

Every v2.4.0 feature has a brief:
- **TD-005:** Automated Testing System (166 tests)
- **TD-011:** Blueprint→IGRIS Migration Support
- **BR-008:** Complete Plugin Uninstall System
- **TD-010:** Protocol Enforcement System

Every decision is documented (`ai/session/DECISIONS.md`).
Every protocol violation is tracked (`ai/session/PROTOCOL_VIOLATIONS.md`).

**We dogfood our own system.**

When IGRIS fails to follow its own protocols (it happens — we're honest about it), we:
1. Record the violation
2. Analyze the root cause
3. Create a PI-XXX brief (Process Improvement)
4. Fix the protocol
5. Make that violation impossible in future

**That's the engineering loop:** Use → Fail → Document → Fix → Improve → Repeat

**Example from today:**
During v2.4.0 release prep, we modified files without creating briefs first (time pressure: "30 minutes to ship").

**We didn't hide it.** We documented it in PROTOCOL_VIOLATIONS.md and will create a PI-XXX brief: "Time-pressure workflow optimization."

**Transparency > Perfection**

**[YOUR NOTES:]**

When IGRIS fails to follow its own protocols (it happens — i'm honest about it and that's why next version is coming), we:
or maybe in something else
you just tell igris to record the violation analyze what the user said and then rewrite our igris_os.md to handle this edge case so the more people use igris the more better enforcement we will be.



---

## **Lessons Learned Building IGRIS**

**1. Laziness is a feature, not a bug**
- Every manual step you do twice → Future automation opportunity
- If you're copy-pasting → Script it
- If AI forgets → Persist it to disk
- Productive laziness drives innovation

**2. Enforcement > Documentation**
- ❌ "Please update session after tasks" → Forgotten 30% of the time
- ✅ "Cannot proceed without updating session" → Never forgotten // better enforcement
- Make the right thing easy, wrong thing impossible

**3. Identity creates consistency**
- Vague AI role ("helpful assistant") → Vague, inconsistent results // -> basic role prompting
- Specific identity ("Igris, engineering assistant with capabilities: X, Y, Z") → Consistent behavior // -> better self awareness
- Persona isn't just fun — it's measurable performance improvement

**4. You must stay in control**
- **Vibe coding:** AI decides, you hope → Chaos
- **Vibe engineering:** You decide, AI executes → Discipline
- AI is the assistant, not the architect
- Never let AI make strategic decisions
// ask it to present options help you decide what to do but never take big decision on it's own or not yet at least
**5. Open source multiplies value**
- Your workflow improvements → Become mine
- My features → Solve your problems
- Community contributions → Everyone wins
- Solo development = linear growth. Open source = exponential growth.

// every developer issue is another developer issue so when everyone solve an issue igris have more capabilities

**[YOUR NOTES:]**



---

## **The Current State: IGRIS v2.4.0**

**Released today:** November 9, 2025

**What shipped:**

**Core Engineering System:**
- **Brief management:** 9 types (BR, TD, MG, TS, PI, FR, DU, PF, AC)
- **Session tracking:** Automatic recovery on context resets
- **Architecture enforcement:** Based on YOUR coding_guidelines.md
- **Testing:** 166 automated tests, CI/CD on GitHub Actions
- **Plugin system:** Extend with platform-specific tools
- **Self-maintenance:** 10 autonomous operations (BUG_HUNT, CODE_QUALITY_AUDIT, etc.)

**Documentation:**
- **README:** 1,614 lines (expanded from 850)
- **Tool comparisons:** IGRIS vs Cursor, Aider, Copilot, Plain Claude
- **Common workflows:** 5 end-to-end scenarios
- **FAQ:** 15 Q&As
- **Best practices:** "You Drive, IGRIS Assists" philosophy

**Persona System:**
- Igris (Shadow Knight) bundled and auto-activated
- 4 mask levels (none → half → light → full)
- Proven performance improvements
- Default: half mask (subtle, professional)

**User Experience:**
```bash
git clone https://github.com/fiftynotai/igris-ai
cd my-project
../igris-ai/scripts/igris_init.sh
claude

# Before you type anything:
⚔️ I am Igris AI v2.4.0, developed by Fifty.ai,
   your AI engineering assistant.

   My capabilities:
   - Brief management, session recovery, architecture enforcement
   - Quality gates, protocol enforcement

🧠 System Assessment:
├─ Session: None
├─ Briefs: 0 ready
└─ Architecture: ⚠️ coding_guidelines.md not found

💡 Recommended Actions:
1. Generate architecture standards
2. Initialize repository
3. Start new task

✅ Igris AI initialized. System ready.
```

**Zero configuration. Just works.**

**[YOUR NOTES:]**



---

## **How IGRIS Compares to Other Tools**

**IGRIS vs Cursor AI:**
- Cursor: Editor-integrated autocomplete
- IGRIS: System-level engineering framework with memory

**IGRIS vs Aider:**
- Aider: CLI chat for quick file edits
- IGRIS: End-to-end engineering (plan → build → test → commit → track)

**IGRIS vs GitHub Copilot:**
- Copilot: Line/function suggestions
- IGRIS: Full features with architecture enforcement and session recovery

**IGRIS vs Plain Claude:**
- Plain Claude: Ad-hoc prompts, manual context loading
- IGRIS + Claude: Structured workflows, automatic context, full accountability

**The difference:** IGRIS isn't just *using* AI. It's *orchestrating* AI to follow engineering discipline.

**[YOUR NOTES:]**



---

## **The "You Drive, IGRIS Assists" Philosophy**

**The biggest mistake with AI coding:** Letting AI make decisions.

**Vibe coding mindset:**
- "AI, build me a login feature"
- *Hopes it works*
- *Spends 3 hours debugging*

**Vibe engineering mindset:**
- "Register BR-015: Users can't login with special characters"
- "IGRIS, analyze requirements and propose architecture"
- *Reviews proposal, makes decisions*
- "Approved. Implement BR-015."
- *IGRIS executes, you verify*

**You notice blockers. You set priorities. You make architecture decisions.**
**IGRIS records, tracks, enforces, and executes.**

**Example:**
```
# You discover a backend API issue mid-implementation

You: "Igris, we're blocked on BR-012. The /api/users endpoint
     returns 500. Record this and note it in the brief."

IGRIS: ✅ Blocker added to BLOCKERS.md
      ✅ BR-012 updated
      ✅ Session saved

# Backend team fixes it

You: "Blocker resolved. Backend fixed the endpoint. Resume BR-012."

IGRIS: ✅ Blocker marked resolved
      ✅ Resuming from: Payment validation implementation
```

**You're the engineer. IGRIS is the assistant.**

Not the other way around.

**[YOUR NOTES:]**



---

## **What's Next: v3.0.0 Vision**

Current state (v2.4.0): Works, but installation is clunky (git clone, run scripts)

**v3.0.0 vision:**
- **Proper CLI:** `igris init`, `igris hunt BR-005`, `igris report`
- **Global storage:** `~/.igris/` with personas and plugins (reusable across projects)
- **AI-powered persona creation:** "Create persona: sarcastic British butler named Alfred" → IGRIS generates it
- **Multi-instance workflow:** Work on 2 briefs simultaneously with conflict detection
- **Better installation:** `brew install igris` or `curl | bash`

**The goal:** Make IGRIS so seamless, you forget it's there. You just engineer.

**[YOUR NOTES:]**

for this: igris still not perfect you have to focus on your prompts, focus on your context window if it gets bigger you have to remind it to follow it's own protocol. 
but for more of the cases it does the work perfectly done. until now i was trying to build igris using the easy way by just having a ready to use prompts use the claude.md file mostly to control claude
and it's been working for me specally on a personal scale. but it's not good enough so new i'm building igris own cli with "claude agent sdk and describe this" i'm doing it the proper way this was me making the assistant that can handle my 9 to 5 so i can handle what i really like to do which is problem solving



---

## **Try It Yourself**

**Installation: 2 minutes**
```bash
git clone https://github.com/fiftynotai/igris-ai
cd your-project
../igris-ai/scripts/igris_init.sh
claude
```

**First workflow: 5 minutes**
```
"Generate coding guidelines for this project"
"Register a bug: [describe issue]"
"Implement BR-001"
```

**IGRIS handles:**
- Architecture enforcement (based on your guidelines)
- Testing (automated workflow)
- Session tracking (automatic recovery)
- Conventional commits (enforced format)
- Documentation (inline comments)

**You handle:** Strategic decisions, priorities, architecture choices

**See the difference.**

**[YOUR NOTES:]**



---

## **The Invitation**

IGRIS exists because I was too lazy to:
- Explain my architecture 50 times
- Manually track what AI did
- Accept context resets killing my flow
- Copy-paste files between projects

Maybe you have the same problems.
Maybe you're tired of managing AI instead of building features.
Maybe you want to try "vibe engineering."

**Install it. Use it. Break it. Tell me what sucks.**

Then we'll create a brief, fix it together, and make it better.

**That's how open source works.**
**That's how engineering works.**

---

**Links:**
- **GitHub:** https://github.com/fiftynotai/igris-ai
- **Release v2.4.0:** https://github.com/fiftynotai/igris-ai/releases/tag/v2.4.0
- **Documentation:** Full README, setup guides, plugin development docs
- **License:** MIT (build freely, share openly)

**From vibe coding → vibe engineering.**

— Fifty.ai
Developer of IGRIS AI

---

## **YOUR OVERALL NOTES & EDITS:**

[Add your thoughts, changes, additions here]




---

**END OF DRAFT**

