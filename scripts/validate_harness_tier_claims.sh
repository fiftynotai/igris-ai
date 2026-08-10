#!/bin/bash
set -e

# Description: harness-count claim validator (TD-367). Read-only check that
#   scans the published doc set for a HAND-WRITTEN harness count ("five
#   harnesses", "all four harnesses", "a 6-harness matrix") and reports every
#   hit alongside the count the descriptor actually declares.
#
#   Follows the header convention, env-override shape, fail-open posture and
#   exit-code contract of scripts/validate_brief_status_vocabulary.sh (TD-333)
#   and its siblings. Wired into scripts/git-hooks/pre-commit as WARN-only.
#
# WHY THIS EXISTS:
#   Before TD-367, FIVE artifacts answered "how many harnesses does IGRIS
#   support?" and they disagreed — docs/multi-cli.md alone said *five* in three
#   places and *six* in a fourth, and its per-harness method matrix was
#   structurally short a Cursor row. The fix was to delete the counts and name
#   the property instead: a harness's TIER derives from
#   harnesses.<id>.hooks.supported in harness-manifest.json, and the roster is
#   whatever `jq '.harnesses | keys'` returns. This validator is the guard that
#   keeps a count from growing back.
#
#   SCOPE, RESTATED AT ROUND 7 BECAUSE THE ORIGINAL SENTENCE IS NO LONGER TRUE.
#   This header used to say the scope was "the NUMERIC half only", and that
#   asserting the published tier LISTS equal the manifest-derived sets "needs a
#   display-name map and a generated-region convention; that is a separate,
#   larger brief". Arm 3 now derives exactly that display-name map, from the
#   descriptor, at run time — so the deferral was half wrong, and the half it was
#   wrong about is the half that kept shipping a false sentence. What REMAINS
#   deferred is the generated-region convention: this guard reports a hardcoded
#   list, it does not GENERATE the correct one, and it still cannot tell a stale
#   roster from a deliberate per-surface subset (see limits #9 and #10).
#
#   Every one of the five contradictions TD-367 originally observed was a
#   numeral, which is why the numeral is what arms 1 guards. It was not the last
#   notation the defect had.
#
# WHAT IS DELIBERATELY NOT SCANNED:
#   CHANGELOG.md and cli/CHANGELOG.md. A shipped changelog is a HISTORICAL
#   RECORD and must be allowed to say what it said — TD-367 corrects 7.1.0's
#   overclaim by APPENDING a note, never by editing the entry. A scanner that
#   flagged those files would push the next reader to rewrite history, which is
#   the opposite of the posture this repo takes.
#
# THIS GUARD HAS THREE ARMS, AND ONLY THE FIRST ONE IS A COUNT:
#   ARM 1 (COUNT) reports a NUMERAL next to the noun.
#
#   ARM 2 (ROSTER GRAMMAR) reports a CLI value grammar that spells the roster
#   out — `--harness <a|b|c|d>` — which carries NO numeral at all and is
#   therefore invisible to arm 1 by construction, no matter how the count
#   pattern is tuned. Round 6 added arm 2 because the numeral-free spelling of
#   this defect had survived every previous round: `loadout project-mcp`'s
#   REQUIRED-argument error string named four harnesses while the validator FOUR
#   LINES BELOW IT accepted `mcpTargetTypes()`, which is six. Two contradictory
#   rosters, one function, one shipped binary.
#
#   ARM 3 (DISPLAY-NAME ENUMERATION) reports the roster written out in PROSE, in
#   the names a reader sees — a contiguous delimited run of at least
#   TIER_DISPLAY_MIN display names that omits at least one declared harness.
#   Round 7 added it because the class survived a SEVENTH round through a THIRD
#   notation, and the surviving line is the sharpest statement of the whole
#   problem this guard exists for: docs/substitution.md said "Work jumps between
#   Claude Code, OpenCode, Antigravity, Codex, or Gemini CLI" — omitting cursor —
#   ELEVEN LINES ABOVE a paragraph that round 6 had just corrected to add cursor
#   as a bridge harness. One published document, contradicting itself across
#   eleven lines, byte-identical to HEAD through all six previous rounds. Arm 1
#   needs a numeral and there is none; arm 2 builds its alternation from
#   lowercase manifest ids and looks for a grammar WRAPPER, and this is neither.
#   Both existing arms were blind to it by construction.
#
#   All three arms are reported SEPARATELY — a reader sent to the wrong report
#   goes looking for a numeral that is not on the line — and any one alone sets
#   exit 1.
#
# WHAT COUNTS AS A HIT (ARM 1):
#   A numeral or number-word IMMEDIATELY adjacent to the word harness/harnesses
#   (an optional space or hyphen, an optional "igris", and since round 6 ONE
#   optional adjective of >=3 letters between them). The adjacency requirement is
#   what keeps legitimate prose out of the report: "four material surfaces" and
#   "all 6 portable hook events" are counts of something else and are not hits.
#   The match folds CASE, because a count at the start of a sentence is the same
#   defect as one mid-sentence.
#
#   THE NOUN MUST NOT BE A FILE NAME. "harness" followed by a DOT and an
#   alphanumeric is a path component, not the noun — "3 personal
#   harness.claude.md symlinks" counts SYMLINKS. COUNT_NOT_FILENAME excludes
#   exactly that shape while keeping a SENTENCE-FINAL count reporting (the `\.$`
#   arm). It is stated here rather than as a per-line carve-out because it is a
#   property of the NOTATION: no count adjacent to a filename is ever a roster
#   claim.
#
#   AND IT OVER-BLOCKS, WHICH THIS HEADER STATES IN BOTH DIRECTIONS BECAUSE IT
#   USED TO STATE ONLY ONE. The known UNDER-block is a BRACE-EXPANSION filename
#   ("harness.{claude,gemini}"), which still reports because a `{` is not
#   alphanumeric. The OVER-block is the mirror and is the more likely of the two
#   to hide a real defect: `harness.<field>` is LIVE NOTATION in this repo — the
#   tier itself derives from `harnesses.<id>.hooks.supported` — so a comment
#   reading "all 6 harness.mcp blocks are written by this module" is a genuine
#   roster count wearing a dotted field path, and COUNT_NOT_FILENAME drops it
#   silently. Verified rather than reasoned: that exact line scans to exit 0
#   while the same sentence with a bare noun reports. It is accepted rather than
#   fixed because the rule that drops it is what buys the filename exclusion its
#   zero-false-positive record, and no instance exists in the corpus today —
#   but it is written down here so a green run is not read as covering it.
#
#   THE `\.$` ARM IS LOAD-BEARING ONLY FOR THE SINGULAR, which is worth knowing
#   before anyone "simplifies" it away. A plural sentence-final count survives
#   without it BY ACCIDENT — `harness(es)?` can match just "harness" and let the
#   "e" of "es" satisfy the `[^.]` arm — so a test written on "all five
#   harnesses." alone passes whether the arm is there or not. "every 5 harness."
#   is the spelling that actually needs it. The bats twin asserts both, after a
#   mutation run showed the plural-only version of that assertion was vacuous.
#
#   THE LEADING BOUNDARY IS ASYMMETRIC BETWEEN THE TWO HALVES, and the asymmetry
#   is the whole design rather than an oversight:
#     - a DIGIT must start at a boundary that is neither ALPHANUMERIC nor a
#       HYPHEN. Both halves foreclose a brief-id over-fire observed on a real
#       line in this repo: without the alphanumeric half the first run flagged
#       "FR-136 Harness manifest schema" (the trailing 6 of a BRIEF ID next to a
#       capitalised "Harness"); without the hyphen half the WHOLE brief-id number
#       matches ("-136 Harness"), which re-appeared at TD-367's review when the
#       digit class widened from [3-7] to [0-9]+ — on the FR-136 brief-id entry
#       in the "Related" list at the end of docs/multi-cli.md. Cited by CONTENT
#       and not by line number on purpose: that doc grows, so a pinned line
#       number is the same silent drift surface this guard exists to close (it
#       had already moved 1563 -> 1644 within TD-367's own review cycle). This
#       repo's prose is saturated with FR-nnn / TD-nnn, and a guard that reports
#       a brief id as a support count is a guard people learn to ignore.
#     - a NUMBER-WORD may start at a hyphen, because no brief id spells its
#       number ("TD-four" does not exist), so the exclusion that the digit half
#       needs buys the word half nothing and costs it a whole notation. Excluding
#       the hyphen from BOTH halves is what made the compound-adjective spelling
#       "all-four-harness alpha-assembly" invisible — two live hits, in
#       core/docs/ADD-SURFACES.md and core/os/surfaces-detail.md, that TD-367's
#       round-3 review found by hand and this pattern structurally could not.
#   Measured over the full 101-file corpus at the time of the fold: the word-half
#   relaxation adds exactly those 2 hits and changes NO other verdict.
#
#   THE DIGIT MIRROR OF THAT COMPOUND IS CAUGHT BY A THIRD ALTERNATIVE, and the
#   discriminator is the SEPARATOR rather than the boundary. "all-6-harness" was
#   invisible for the same reason "all-four-harness" was: its digit sits after a
#   hyphen, which the digit half excludes for brief ids. But the two shapes are
#   separable — a BRIEF ID puts a SPACE between the number and the noun
#   ("FR-136 Harness"), while a compound adjective puts a HYPHEN
#   ("all-6-harness"). So COUNT_HYPHEN_DIGIT admits a hyphen-led digit ONLY when
#   the tail separator is ALSO a hyphen, which reports the compound and leaves
#   every brief id silent. Measured over the full 203-file corpus BEFORE it was
#   written: 12 hits -> 12 hits, i.e. it adds ZERO false positives and zero new
#   true positives on the current tree; it is a PROSPECTIVE close, and it was
#   fixed rather than merely stated because the measurement said it was free.
#   Residual it accepts, stated rather than hidden: a hyphen-JOINED brief id
#   ("FR-136-harness", a branch-name spelling) would now report. No instance
#   exists in the corpus, and the guard is WARN-only.
#
# WHAT THIS GUARD CANNOT SEE — the numbered limits below, so a green run is not
# over-read as "no false harness claim exists anywhere". THE HEADING NO LONGER
# CARRIES A COUNT OF THEM, deliberately: the summary numeral was stale at "three"
# when there were four and stale at "four" when there were five, which is the
# same defect this guard exists to catch, committed by the guard's own header.
# The individual numbers are STABLE (the bats twin cites "limit #5" by name), so
# they are kept and new limits are APPENDED; only the summary count is gone.
#   1. THE SPELLED-OUT VOCABULARY IS BOUNDED. Digits are open ([0-9]+, so 2 / 8
#      / 10 report as readily as 5), but the WORD half is a fixed FIVE-member
#      list — three, four, five, six, seven — and nothing else. "a dozen
#      harnesses", "two harnesses" and "both harnesses" are invisible. Those
#      five span the plausible roster sizes for a project with this many
#      declared harnesses; widen the list if the roster leaves that band, and
#      re-run the bats twin, which pins the spellings.
#   2. ADJACENCY IS LINE-LOCAL. grep matches within ONE line, so a count split
#      across a markdown line wrap is invisible. "the other 4" / "harnesses"
#      wrapped across two lines in docs/multi-cli.md survived TD-367's own sweep
#      for exactly this reason and was caught in review, not here. Re-wrapping a
#      paragraph can hide an existing hit or expose a new one.
#   3. THE SCAN SET IS A LIST **PLUS TWO TREES**, not the whole repo. The named
#      files in DEFAULT_DOC_SET are read; so is every *.md under core/
#      (DEFAULT_DOC_TREE) — the runtime-mirrored OS prose the agent itself reads
#      at Boot on every install; and so is every *.ts under cli/src
#      (DEFAULT_SRC_TREE) — the SHIPPED CLI, whose `--help` strings and doc
#      comments are compiled verbatim into cli/dist and read by users. What
#      remains invisible: brain-mcp-server, cli/dashboard, test/, docs/ files
#      nobody added to the list, and any other tree. The two files excluded ON
#      PURPOSE are the changelogs, above.
#
#      The core/ tree half exists because the list-only form's blind spot was not
#      theoretical: TD-367's round-3 review found SIX hand-written counts in
#      core/docs/ADD-SURFACES.md and core/os/surfaces-detail.md, both of which
#      diff byte-identical to their ~/.igris/core/ runtime mirrors. They were
#      never repo-only prose; they were shipped OS text, and the guard that was
#      meant to keep counts from growing back was structurally incapable of
#      reading them.
#
#      THE cli/src TREE HALF EXISTS FOR THE SAME REASON, ONE LAYER DOWN, and it
#      is the fifth recurrence of this class that a hand sweep did not end. The
#      guard scanned *.md ONLY, so NO shipped string in cli/src was EVER covered:
#      `igris remove --help` shipped "UN-PROJECTS from every harness" while both
#      of its prose twins (cli/README.md, docs/multi-cli.md) were hedged in the
#      SAME diff, and the rebuilt binary emitted corrected `add` help beside
#      stale `remove` help. A count in a doc comment is not a repo-side note
#      either: `removeComments` is unset, so the comment is carried verbatim into
#      the built cli/dist/**/*.js that users actually run.
#
#   4. THE NOUN IS FIXED: harness/harnesses. A count adjacent to a DIFFERENT
#      noun is invisible even when it is the same defect — "all 5 MCP targets"
#      in core/docs/ADD-SURFACES.md was a stale roster count (there are 6
#      mcp-block harnesses) and no version of this pattern reports it, because
#      the word "harness" is not on the line. Widening the noun would swallow
#      "four material surfaces" and "all 6 portable hook events", which are
#      correct counts of other things; the noun stays fixed and this limit is
#      stated instead.
#
#   5. THE INTERVENING ADJECTIVE — A LIMIT THAT WAS DECLINED AT 101 FILES AND
#      ADOPTED AT 203. KEPT AS A WORKED EXAMPLE OF WHY A DECLINE IS ONLY VALID
#      OVER THE CORPUS IT WAS MEASURED ON.
#
#      Round 4 measured the widening over the 101-file corpus of the time and
#      DECLINED it: 0 -> 4 hits, 2 true positives and 2 false ones it could not
#      separate. The corpus then DOUBLED to 203 when the cli/src walk landed, and
#      the decline was carried forward UNCHANGED rather than re-measured. It
#      should not have been. Re-run at 203 the trade INVERTS — relaxing
#      COUNT_TAIL to admit one adjective of >=3 letters reports FIVE lines:
#        - cli/src/lib/mcp-delegate.ts   "the 4 DELEGATED harnesses"   STALE
#        - cli/src/lib/mcp-register.ts   "the other 4 delegate harnesses" STALE
#        - cli/src/verbs/loadout.ts      "the 4 DELEGATED harnesses"   STALE
#        - docs/multi-cli.md             "All 4 agent harnesses"       CORRECT
#        - cli/src/lib/skills-pollution.ts "3 personal harness.claude.md" FALSE
#      The three stale ones ship into cli/dist and were WRONG FROM BIRTH:
#      mcp-register.ts's own routing is `engine === "delegate" && harness !==
#      "antigravity"`, so the delegated set is the roster minus one — FIVE, not
#      four — and cursor was onboarded (3cae4bb, 2026-06-30) FOUR DAYS AFTER
#      FR-212d (3f62061) wrote the numeral. A count that was stale before the ink
#      dried is exactly what this guard exists to catch.
#
#      NEITHER of round 4's two blockers survived, and neither was answered with
#      a per-line carve-out:
#        - "a 5th harness" — still not a hit. The >=3-letter floor on the
#          adjective slot excludes the ordinal suffixes th/st/nd/rd, so the
#          exemption this header states by name survives the widening intact.
#          Pinned by a deliberate-non-detection test in the bats twin.
#        - "3 personal harness.claude.md symlinks" — answered by NOTATION, not by
#          a line exclusion: the noun there is a FILE NAME, and
#          COUNT_NOT_FILENAME drops it. Measured: 5 -> 4 hits, and it changes NO
#          other verdict over the 203-file corpus. Its residual, stated rather
#          than discovered later: the rule keys on a dot followed by an
#          ALPHANUMERIC, so a BRACE-EXPANSION filename ("harness.{claude,gemini}")
#          still reports. That spelling exists only inside cli/src/__tests__,
#          which limit #6 prunes, so it costs nothing on the real tree — and the
#          bats twin asserts it rather than leaving it to be tripped over.
#        - "All 4 agent harnesses" (docs/multi-cli.md) — round 4 called this
#          untouchable because it is hand-written but NUMERICALLY CORRECT. That
#          was the wrong frame. The guard's own remediation advice is "replace
#          the count with the PROPERTY that produces it", and that advice applies
#          to a correct count as much as to a stale one — a correct count is
#          simply one that has not drifted YET. It now reads "every agent-surface
#          harness (agentTargetTypes())", which needs no carve-out and cannot go
#          stale at the next onboarding.
#      Residual on a clean tree after all four: ZERO. The widening ships.
#
#      THE LESSON, WHICH IS THE REASON THIS LIMIT IS KEPT RATHER THAN DELETED: a
#      measured decline is a statement about a CORPUS, not about a regex. When
#      the corpus changes, every decline taken over the old one is unverified
#      again. Round 5 doubled the corpus and inherited this decline without
#      re-running it, and three false claims shipped for one more round as a
#      direct result. Re-measure any limit below whose numbers name a corpus size
#      smaller than the one the guard currently reports.
#
#   6. THE SOURCE WALK EXCLUDES TEST FILES, and that exclusion was MEASURED, not
#      assumed. SRC_EXCLUDE_DIR prunes cli/src/__tests__ (the only test dir under
#      cli/src; zero *.test.ts / *.spec.ts live outside it). Measured over the
#      real tree before the unit was chosen — these are WALK figures for cli/src
#      alone, NOT corpus figures (the corpus is this walk plus the file list plus
#      the core/ walk, and the two quantities move by different amounts):
#        - ALL of cli/src/**/*.ts  — 203 files, 23 hits at the time of measuring
#        - EXCLUDING __tests__/    — 102 files, 12 hits at the time of measuring,
#          ALL of them genuine hand-written counts in doc comments, ZERO false
#          positives
#      Those figures are a HISTORICAL record of the choice, not a current reading:
#      the 12 have since been fixed, so the pruned walk is at 0 today.
#
#      THIS PARAGRAPH NO LONGER CARRIES A TALLY OF WHAT THE PRUNE DROPS, AND THAT
#      IS THE POINT. It carried one three times and it was wrong three times: it
#      said "ten test titles plus one file mode" (wrong about the SHAPE of three
#      of them); corrected to "eight titles and three comments" it then NAMED the
#      wrong three comments — two of the files it cited, register-brain-
#      harnesses.test.ts and registry-project-mcp.test.ts:18, were FIXED in round
#      6, so the entry described hits that no longer report while missing two that
#      do. A hand-maintained tally of the guard's own blind spot is the identical
#      defect to a hand-written harness count, committed inside the guard that
#      exists to catch it — the same lesson that already deleted the summary count
#      of these limits from the heading above. RE-DERIVE IT, NEVER RECALL IT:
#
#        TIER_SRC_EXCLUDE="" scripts/validate_harness_tier_claims.sh
#
#      That one command prints BOTH numbers this limit used to hardcode — the
#      unpruned CORPUS size on its first line and every dropped hit, with file and
#      line, below it. What is STABLE, and therefore worth writing down, is the
#      KIND of thing it drops rather than how many:
#        - `it()` TITLES — the majority, and the reason for the exclusion. A
#          title's count scopes its own fixture ("a 644 harness config", where the
#          numeral is a UNIX FILE MODE), or names a delegate-CLI argument shape,
#          and several are DERIVED two lines below in the test body from
#          harnessIds(). Reporting them is how a guard becomes one people learn to
#          ignore.
#        - DOC COMMENTS — the exclusion's observed COST, not a category it is
#          comfortable with. A comment describing PRODUCTION routing is stale for
#          exactly the reasons limit #5's shipped copies were, and EVERY ROUND
#          SINCE THIS EXCLUSION LANDED HAS HAD TO FIX ONE BY HAND. (No running
#          total is kept here on purpose — this paragraph used to carry one and
#          it went stale the same way the tally beside DEFAULT_SRC_EXCLUDE did.)
#          Two worked examples, because their SHAPES are what transfer:
#          mcp-env-normalize.test.ts's "one of the four per-harness output forms"
#          was neither the number of forms (three) nor the number of harnesses
#          (six), and round 6's own adjective widening newly exposed it without
#          anyone reading the new hit; harness-registry.test.ts's "the other 4 /
#          harnesses" for the universal skills store was one short, and it is
#          DOUBLY invisible — the noun WRAPPED to the next line (limit #2) inside
#          the directory this rule PRUNES — so un-pruning alone would not have
#          reported it. Re-read this exclusion's output whenever a surface's
#          projection rule changes; do not assume the prune is only dropping
#          fixture counts.
#      That is this exclusion's cost, observed rather than predicted: a stale
#      count inside cli/src/__tests__ really did grow back unseen, three times.
#      Read the command's output when you change this walk; do not trust a prose
#      list of what it will say. The exclusion still stands, because reporting
#      every fixture-scoping title is how a guard becomes one people learn to
#      ignore — but the honest statement of the trade is "test TITLES are
#      exempt", not "everything under __tests__ is a fixture count".
#
#      WHY THE UNIT IS A PATH AND NOT A LINE CLASSIFIER. "String literals and
#      comments only" was measured too and is WORTHLESS here: all 23 unit-A hits
#      already sit on a comment-or-quote line, so the classifier separates
#      NOTHING while adding a fragile TypeScript-lexing step to a grep. The
#      dimension that actually discriminates is test-vs-shipped, which is a path.
#      Identifiers and enum members — the noise this widening was expected to
#      hit — produced ZERO hits at either unit.
#
#      What this costs: a stale count inside cli/src/__tests__ can grow back
#      unseen. Accepted for TITLES, whose counts describe their own fixture;
#      NOT comfortable for doc comments, which is why the KIND list above says so
#      and why the command is here to be run rather than a number to be trusted.
#
#   7. THE SOURCE WALK IS cli/src ONLY. brain-mcp-server (which carries a "the
#      five harnesses" comment in parse-output.ts), cli/dashboard, cli/tests
#      (whose fr212-smoke.sh says "all 5" twice), and the bats suites under
#      test/ are NOT scanned. They are TD-368's, along with
#      harness-manifest.json's `_harnesses_comment` — a JSON string, so no *.ts
#      or *.md walk reaches it. Widening to those trees is a measurement, not a
#      one-line edit: re-run the unit comparison above on each before adding it.
#
#      TWO NAMED CANDIDATES ARE PARKED HERE FOR TD-368 SO THEY ARE OWNED RATHER
#      THAN REMEMBERED, both measured during round 7's review and both out of
#      scope for this brief:
#        - A SURFACE-KEYWORD DISCRIMINATOR for arm 2: require one of
#          mcp / bridge / brain / skills / supported on the line. Over the corpus
#          at round 7's HEAD it reports 5 hits, 5 true, 0 false — strictly more
#          productive than arm 2's own unit at equal precision. It is a widening
#          of a shipped arm on a fresh measurement, which is a brief, not a
#          blocker.
#        - THE DISPLAY-NAME / CONFIG-PATH SWEEP: the same enumeration defect
#          spelled as a list of config PATHS rather than names. Arm 3 covers the
#          display-name half; the path half is unmeasured.
#
#   8. ARM 2 SEES A VALUE GRAMMAR, NOT AN ENUMERATION IN PROSE. The broader
#      predicate — "a line naming >= N roster ids while omitting >= 1", with the
#      roster read from the descriptor — was BUILT AND MEASURED over the real
#      203-file corpus before arm 2's unit was chosen, and DECLINED. The numbers,
#      so this is not re-litigated from memory:
#        - ids anywhere on the line, N=3 ....... 100 hits
#        - ids anywhere on the line, N=4 ....... 40 hits
#        - a CONTIGUOUS delimited run, N=4 ..... 18 hits: 9 TRUE, 9 FALSE
#        - a VALUE-GRAMMAR wrapper, N=4 ........ 3 hits: 3 TRUE, 0 FALSE  <-- arm 2
#      The contiguous-run variant is the interesting one, and it is the one that
#      cannot ship. Its 9 false positives are not noise that a tighter regex
#      removes: the stale roster and the CORRECT roster are THE SAME FOUR TOKENS.
#      `{claude,codex,gemini,opencode}` is a stale `mcpTargetTypes()` (six) in
#      loadout.ts and a correct `agentTargetTypes()` (four) in harness.ts,
#      index.ts, add.ts, add-orchestrate.ts and the compile adapter's README —
#      whose valid set compile_harnesses.sh already DERIVES from
#      agent_target_types. Nothing lexical separates them; only knowing which
#      surface the sentence is about does.
#
#      THE DECIDING NUMBER IS THE ONE MEASURED *AFTER* THE FIXES, NOT SUBTRACTED
#      FROM THE ONE BEFORE. Re-run over the repaired tree the run variant still
#      reports 10 (the first draft of this paragraph said 7, by subtracting
#      instead of re-running — the identical defect one level up, caught by
#      re-deriving):
#        - 7 genuinely correct rosters (compile's --target in the adapter README,
#          index.ts, add.ts, add-orchestrate.ts, harness.ts; EntryShape's four
#          wire shapes; the adapter README's 5-axis divergence table)
#        - 2 that the probe mis-reads, because a CONTIGUOUS run cannot see an id
#          that wrapped to the next line (docs/multi-cli.md's ${VAR} rule) or one
#          that sits elsewhere on the line (docs/SETUP_GUIDE.md's restart list
#          names all six)
#        - 1 SELF-REFERENCE: MAINTAINING.md's row documenting this very decline
#      So the broad unit would sit RED on a clean tree forever, need a 10-line
#      allowlist, and flag the paragraph explaining why it was declined. Arm 2's
#      wrapper unit reports 0 over the same repaired tree. That is what decided
#      it.
#
#      So these remain invisible, and were fixed BY HAND in round 6 rather than
#      by a pattern: init.ts's "ALL supported harnesses (Claude, Gemini, Codex,
#      OpenCode)" (a parenthesised prose list — no grammar wrapper), index.ts's
#      `--cli-bridge` help naming four of knownCLITargets()'s six,
#      docs/SETUP_GUIDE.md's universal-skills-store roster, and MAINTAINING.md's
#      `mcp.projected` roster. Sweep THAT shape by hand whenever a surface's
#      projection rule changes; re-measure the run variant before adopting it.
#
#      PARTIALLY SUPERSEDED AT ROUND 7. Arm 3 now reports the prose spelling when
#      it is a contiguous DISPLAY-NAME run of >= TIER_DISPLAY_MIN, which is the
#      shape init.ts's line took. What limit #8 still declines is the LOWERCASE-ID
#      presence predicate, and its numbers above stand unchanged.
#
#   9. ARM 2 CANNOT TELL A STALE ROSTER FROM A CORRECT SUBSET — it reports the
#      NOTATION, and the reader adjudicates. A wrapper naming exactly the
#      hook-surface trio `<claude|opencode|antigravity>` is correct today and is
#      below arm 2's >= 4 threshold, so it stays quiet; but if the roster grew
#      such that a genuinely-4-member surface were spelled in a wrapper, arm 2
#      would report it. That is deliberate: a hardcoded value grammar is the
#      anti-pattern whatever set it happens to equal right now, and the fix is
#      the same either way — name the accessor. TIER_ROSTER_MIN exists so the
#      threshold can be re-measured rather than argued.
#
#      AND IT CANNOT TELL A QUOTATION FROM A CLAIM. Writing this defect down
#      inside a scanned doc REPORTS it: the MAINTAINING.md row describing arm 2
#      tripped both arms the moment it spelled a real roster inside a wrapper,
#      which is how this paragraph came to exist. Documentation of the class must
#      use PLACEHOLDER letters (`<a|b|c|d>`), the way this header and the
#      validator's own advice text do. That is not a bug to be fixed with a
#      quotation-detector — a scanner that learned to ignore prose "about" the
#      defect would ignore the defect, since every stale roster in this repo sits
#      inside prose explaining something.
#
#  10. ARM 3'S UNIT AND THRESHOLD WERE BOTH MEASURED BEFORE ADOPTION, and the
#      obvious unit lost again — for the SAME reason it lost for arm 2, one
#      notation over. Measured over the real corpus with the defect still in
#      place, counting DISTINCT display names and requiring at least one omitted:
#
#          unit                              N=3    N=4    N=5
#          names anywhere on the line ......   92     32      7
#          a CONTIGUOUS delimited run ......   45      6      1   <-- arm 3
#
#      At N=5 the broad unit reports 7 lines of which SIX are correct, and they
#      are correct in three different ways that no regex separates:
#        - an EVIDENCE claim. README.md says the handoff is "proven end-to-end
#          across four tools: Claude, OpenCode, Codex, and Antigravity". That is
#          a statement about what was TESTED. It does not become false when a
#          harness is onboarded, and "fixing" it would be falsifying it.
#        - a PER-SURFACE SUBSET. docs/multi-cli.md's `${VAR}` indirection rule
#          names every harness that resolves a ref itself — that is the roster
#          minus codex, so FIVE, and this paragraph said "four" for a round.
#          Correct as written, and NOT the roster. See the residual note under
#          the threshold discussion below: at five members it is inside arm 3's
#          reach and clears only on the line wrap.
#        - a WRAP or a SCATTER. multi-cli.md:296 names the ids around an accessor
#          that already states the exception; the run rule cannot see that and the
#          presence rule reports it.
#      The contiguous-run unit reports ONE line over the same corpus, and that one
#      is the genuine defect. Re-run AFTER the fix — re-run, never subtracted, the
#      error limit #8 records making — it reports ZERO.
#
#      THE THRESHOLD IS 5, NOT ARM 2's 4, AND IT IS AN EMPIRICAL CHOICE OVER THIS
#      CORPUS — NOT, AS THIS PARAGRAPH ASSERTED FOR A ROUND, A STRUCTURAL ONE.
#      The claim it used to make was that five "sits strictly above every declared
#      subset". THAT IS FALSE. The declared proper subsets of the roster,
#      re-derived rather than recalled:
#
#          predicate                            jq path              size
#          agents block present ............... .agents                4
#          hooks.supported == true ............ .hooks.supported       3
#          grant.kind != "covered" ............ .grant.kind            4
#          mcp.projected == true .............. .mcp.projected         5   <--
#          mcp block present .................. .mcp                   6
#
#      `mcp.projected` is a DECLARED five-member proper subset — antigravity is
#      the FR-179 carve-out — and it is not an internal detail: the shipped,
#      exported `mcpProjectedHarnesses()` in cli/src/lib/harness-descriptor.ts
#      reads exactly it, and its own doc comment names the predicate. So the
#      threshold sits ON a declared subset rather than above one, and a doc
#      enumerating the MCP-projected harnesses in display names would report as
#      a false positive.
#
#      WHAT ACTUALLY JUSTIFIES 5 IS THE MEASUREMENT, RE-RUN OVER THE REPAIRED
#      TREE (re-run, never subtracted — limit #8 records making that error):
#        - N=5 ..... 0 hits
#        - N=4 ..... 5 hits, ALL FIVE CORRECT, in four distinct ways:
#            README.md's "proven end-to-end across four tools"  EVIDENCE CLAIM
#            docs/multi-cli.md's delegated-set parenthetical     WRAPPED SUBSET
#            docs/multi-cli.md's ${VAR} indirection rule         WRAPPED SUBSET
#            MAINTAINING.md's row describing this guard          SELF-REFERENCE
#            cli-adapters/README.md's agentTargetTypes() gloss   NAMED ACCESSOR
#      There is no 4-name roster in this corpus that SHOULD be caught, so
#      dropping to 4 buys nothing and costs five false positives — one of them
#      the documentation of the decline itself, which is limit #9's second
#      blindness arriving on schedule. TIER_DISPLAY_MIN exists so this can be
#      re-measured rather than argued, and limit #5's lesson applies to it before
#      any other — with one extra edge now that the ground is EMPIRICAL rather
#      than structural: the threshold is unverified the moment the roster changes
#      AND the moment the corpus changes. That is the weaker guarantee, and
#      saying so is the point of correcting this paragraph.
#
#      THE FIVE-MEMBER RESIDUAL IS REAL, AND THIS CORPUS ALREADY CARRIES TWO OF
#      IT. This paragraph used to say "None exists — measured, not assumed". It
#      was neither. Two lines in docs/multi-cli.md enumerate a five-member subset
#      in display names TODAY, and both are CORRECT sentences that the shipped
#      threshold would report if it could reach them:
#        - THE `${VAR}` INDIRECTION RULE. Every harness except codex resolves the
#          ref itself, which is FIVE, and the rule names all five. (This limit
#          called them "the four harnesses that resolve a ref themselves" for a
#          round — a stale roster count inside the paragraph documenting stale
#          roster counts.) It clears for exactly ONE reason and it is limit #2:
#          the fifth name wrapped to the next line. Joined onto one line it
#          REPORTS at the shipped threshold. Measured, not reasoned.
#        - THE DELEGATED-SET PARENTHETICAL, `mcpAgentIds()` minus antigravity,
#          also five. It needs TWO accidents rather than one: the wrap AND an
#          interposed "— since FR-192 —" that breaks contiguity. Joined verbatim
#          it stays quiet; joined with that parenthetical removed it reports.
#      So the residual is neither prospective nor bought by the threshold being
#      well-chosen — it is carried by LINE WRAPPING, which limit #2 already names
#      as a thing that moves whenever a paragraph is re-flowed. Re-wrap either
#      paragraph and a correct sentence turns red. The remedy is unchanged and is
#      the guard's own advice rather than a carve-out: name the accessor
#      (`mcpProjectedHarnesses()`, `mcpAgentIds()`), because a hand-listed subset
#      goes stale at the next onboarding exactly like a hand-listed full roster.
#      The guard is WARN-only, which is what makes accepting this survivable.
#
#      AND ARM 3 INHERITS BOTH OF LIMIT #9'S BLINDNESSES VERBATIM. It cannot tell
#      a stale roster from a deliberate subset — it reports the NOTATION and the
#      reader adjudicates — and it cannot tell a QUOTATION from a claim, so
#      documentation of this class must use PLACEHOLDER names the way this
#      paragraph does. The delimiter set is deliberately PROSE punctuation (comma,
#      "or", "and", the Oxford comma, and the slash-joined form); the pipe is
#      arm 2's, inside a wrapper, and adding it here would report the
#      surfaces-block projector's axis TABLE in
#      core/scripts/cli-adapters/README.md — which is CORRECT as written, because
#      `cursor` appears ZERO times in that bash adapter and a cursor column would
#      make the table false.
#
#  11. THE ANAPHORIC COUNT — A NOTATION NO ARM CAN SEE, MEASURED AND DECLINED,
#      WITH ALL THREE OF ITS LIVE INSTANCES FIXED BY HAND. The count is written
#      but the NOUN IS ELIDED, referred back to instead: "the other <N>", "the
#      OTHER <N> un-register". Every arm is blind to it BY CONSTRUCTION rather
#      than by tuning — arm 1 requires the noun adjacent, arm 2 a CLI
#      value-grammar wrapper, arm 3 a display-name run — so this is a STRUCTURAL
#      gap and not another spelling of one already covered. (No ordinal is
#      attached to it on purpose: a running tally of how many notations this
#      class has worn would be one more hand-maintained count inside the guard
#      that exists to catch them, and the heading above already deleted its
#      count of these limits for exactly that reason.)
#
#      IT WAS NOT THEORETICAL. Three instances shipped, ALL in cli/src, ALL off by
#      one, ALL omitting cursor, and ALL in files this same diff was already
#      correcting — two of the three inside the VERY SAME comment block as a line
#      it had just fixed:
#        - cli/src/lib/mcp-shape.ts   "the other three pass refs through" — the
#          switch below it has SIX cases. Its `@param` twin seven lines away had
#          been corrected in the same round while this sentence shipped on.
#        - cli/src/verbs/loadout.ts   "the delegate path for the other 4",
#          SIXTEEN lines under a corrected line that reads "`mcpTargetTypes()`
#          minus the antigravity carve-out" — i.e. five.
#        - cli/src/verbs/remove.ts    "the OTHER 4 un-register", where the
#          targeted set defaults to `mcpTargetTypes()` (six) and the antigravity
#          filter leaves five.
#      `removeComments` is unset, so all three compiled verbatim into
#      cli/dist/**/*.js. Each is now stated as the PROPERTY, not re-numbered.
#
#      A FOURTH ARM WAS BUILT AND MEASURED BEFORE BEING DECLINED, on the same
#      terms as arms 2 and 3. Over the 203-file corpus WITH the defect still in
#      place:
#
#          unit                                          hits   true   false
#          the anaphor alone ..........................    15      3      12
#          + harness vocabulary on the SAME line ......     4      2       2
#          + harness vocabulary within +/- 3 lines ....     8      3       5
#          + harness vocabulary within +/- 10 lines ...     8      3       5
#
#      The same-line discriminator is the only one with tolerable precision and
#      it MISSES remove.ts — that comment names no harness at all; "antigravity"
#      is on the line above. Widening to a context window recovers it and buys
#      five false positives, which do not shrink with a tighter regex because
#      they are counts of OTHER things next to harness prose: dashboard
#      endpoints, brain read modules, BR-080 required arrays, portable hook
#      EVENTS (limit #4's fixed-noun problem, arriving from the other side), and
#      MAINTAINING.md's row describing this guard (limit #9's quotation-vs-claim
#      blindness).
#
#      THE DECIDING NUMBER IS THE ONE MEASURED *AFTER* THE FIXES — re-run, never
#      subtracted, the error limit #8 records making. Over the repaired tree:
#        - the anaphor alone .......................... 12 hits, 0 true
#        - + harness vocabulary, same line ............  2 hits, 0 true
#        - + harness vocabulary, +/- 3 or +/- 10 lines   5 hits, 0 true
#      So the best unit would sit RED on a clean tree forever, need a five-line
#      allowlist, and flag the paragraph explaining why it was declined. That is
#      the identical verdict, on the identical evidence, that limit #8 reached
#      for arm 2's broad predicate. DECLINED, and the three true positives are
#      fixed by hand instead — which is what limit #8's own record says happens
#      to a notation with no shippable unit. Re-measure before adopting it: this
#      decline is a statement about a CORPUS (limit #5), and the corpus grows.
#
#      THE CONFIG-PATH SHAPE WAS SWEPT IN THE SAME PASS AND IS CLEAN — recorded
#      because "we looked and found nothing" is a measurement and limit #7 parked
#      it as unmeasured. The same enumeration defect spelled as a list of config
#      PATHS rather than names, with the paths DERIVED from each harness's
#      `mcp.config_path`: at BOTH N=4 and N=5 the presence predicate reports
#      exactly ONE line over the corpus, core/scripts/cli-adapters/README.md's
#      5-axis divergence table, which is CORRECT as written for the reason limit
#      #10 already gives — `cursor` appears ZERO times in that bash adapter, so a
#      cursor column would make the table false. Zero true positives; nothing to
#      build. The CONTIGUOUS-run unit reports zero at N=5, because a path
#      contains the slash the prose delimiter set uses.
#
#   The numerals TD-367 deliberately left in place are ORDINALS about events
#   rather than live support claims — e.g. "6th declared harness" in
#   docs/multi-cli.md's Cursor section. "6th" does not match: it puts a "t"
#   where the pattern wants the word harness or a separator.
#
# HOW YOU KNOW THE PATTERNS ARE STILL ALIVE:
#   A COUNT_PATTERN — or an arm-2 or arm-3 alternation built from an empty
#   roster — that stops matching anything prints OK forever and is
#   indistinguishable on-tree from a clean corpus. Nothing here can detect that.
#   The ONLY liveness proof is the bats twin,
#   test/validate_harness_tier_claims.test.bash, which feeds fixtures carrying
#   every spelling and asserts exit 1 — if you edit COUNT_PATTERN, that suite is
#   what tells you whether you changed it into a no-op.
#
#   AND A GREEN TWIN IS NOT THE SAME PROOF, which round 7 learned the hard way.
#   Every arm-3 assertion was arm-checked by MUTATING this file and confirming a
#   NAMED test went red; the first pass of that matrix reported six mutations
#   applied when perl had silently interpolated `$0` and `${...}` inside its
#   \Q...\E and changed nothing, and two more collided with a BYTE-IDENTICAL
#   statement in arm 2 and mutated the wrong arm. Compare the file before and
#   after, and read the diff, before believing an arm-check. Two survivors came
#   out of that: an unreachable `n < 2` bail-out, now deleted, and the id-half
#   hyphen relaxation, which needed a fixture harness whose KEY is hyphenated AND
#   whose agent_id differs — with an identical agent_id the agent half relaxes
#   first and the equality test hides the id half entirely.
#
# Usage: scripts/validate_harness_tier_claims.sh
# Env overrides (test injection):
#   HARNESS_MANIFEST  override the descriptor path
#                     (default: <repo-root>/harness-manifest.json)
#   TIER_DOC_SET      override the scanned FILE list, space-separated. A path is
#                     read relative to the repo root unless it is absolute, so a
#                     test can point the scanner at a fixture outside the tree
#                     rather than writing one into it. (Default: the published
#                     artifacts that carry a tier or roster sentence, plus
#                     MAINTAINING.md, the contract home.)
#                     Setting it also turns BOTH TREE halves OFF unless
#                     TIER_DOC_TREE / TIER_SRC_TREE are set too, so a fixture-list
#                     test scans exactly its fixtures and its asserted counts do
#                     not move when someone adds a core/ doc or a cli/src module.
#   TIER_DOC_TREE     override the walked MARKDOWN tree(s), space-separated, same
#                     relative/absolute rule. (Default: core — every *.md under
#                     it, sorted, deduped against the file list.) Symlinks are
#                     NOT followed, so a mirror symlink cannot walk the scanner
#                     out of the repo. Set to the empty string to scan the file
#                     list only.
#   TIER_SRC_TREE     override the walked SOURCE tree(s), space-separated, same
#                     relative/absolute rule. (Default: cli/src — every *.ts
#                     under it, sorted, deduped, with SRC_EXCLUDE_DIR pruned.)
#                     Same -P symlink posture. Empty string = no source walk.
#   TIER_SRC_EXCLUDE  override the directory NAME pruned from the source walk
#                     (default: __tests__ — see limit #6, which measures why).
#                     Empty string prunes nothing.
#   TIER_ROSTER_MIN   ARM 2's threshold: the minimum number of DISTINCT roster
#                     ids a value grammar must name before it is reported
#                     (default: 4 — see limit #8, which measures why 3 is too
#                     noisy). `0` turns arm 2 off entirely, which is how the
#                     bats twin proves the arm is a CHOICE and not an accident.
#   TIER_DISPLAY_MIN  ARM 3's threshold: the minimum number of DISTINCT harness
#                     DISPLAY NAMES a contiguous prose run must name before it is
#                     reported (default: 5 — see limit #10, which MEASURES it:
#                     N=5 reports 0 over this corpus and N=4 reports 5, all five
#                     of them correct. The ground is EMPIRICAL, not structural.
#                     For a round this line said that 4
#                     "collides with correct per-surface prose by construction",
#                     the claim limit #10 refutes — quoted on ONE line so the
#                     concept sweep finds this site and reads it as a
#                     RETRACTION rather than missing it on a wrap).
#                     `0` turns arm 3 off entirely, same posture as arm 2.
# Exit codes:
#   0 - NO arm reported: no hand-written harness count, no hardcoded roster
#       grammar AND no display-name roster enumeration in the corpus, OR
#       fail-open (no JSON reader available, descriptor absent/unreadable, or no
#       scanned doc exists on disk — each reported LOUDLY, never silently).
#   1 - ANY arm reported. The pre-commit hook block decides WARN vs block —
#       TD-367 ships it as WARN.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

HARNESS_MANIFEST="${HARNESS_MANIFEST:-$REPO_ROOT/harness-manifest.json}"

# The published artifacts that answer "which harnesses does IGRIS support?",
# plus MAINTAINING.md — the contract home, which carries the tier row and is in
# the pre-commit TRIGGER list, so staging it must not run a scanner that
# structurally cannot see it.
# CHANGELOG.md and cli/CHANGELOG.md are excluded BY DESIGN — see the header.
DEFAULT_DOC_SET="README.md cli/README.md docs/multi-cli.md docs/SETUP_GUIDE.md docs/substitution.md MAINTAINING.md"

# The MARKDOWN TREE half. core/ is the OS prose that is TD-096-mirrored into
# ~/.igris/core/ and read by the agent at Boot on every install, so a count in
# it is published text, not a repo-side note. Walked rather than listed because
# a list is exactly what let six of them accumulate unseen.
DEFAULT_DOC_TREE="core"

# The SOURCE TREE half. cli/src is the shipped CLI: its `--help` strings are
# printed to users and its doc comments are carried verbatim into cli/dist
# (`removeComments` is unset), so a count here is shipped text too. Scanning
# *.md ONLY is what let `igris remove --help` ship "UN-PROJECTS from every
# harness" while both of its prose twins were hedged in the same diff.
DEFAULT_SRC_TREE="cli/src"

# Pruned from the SOURCE walk. Measured, not assumed — see limit #6.
#
# THIS COMMENT DELIBERATELY CARRIES NO FIGURES, and the deletion is the fix
# rather than an omission. It hardcoded three of them — a corpus delta, a walk
# delta and a breakdown of the hits the prune drops — and by round 7 all three
# were wrong at once (the corpus and walk deltas because a sibling brief
# committed a test file mid-session; the breakdown because it had been counted
# before two of those hits were fixed). That is the FOURTH hand-maintained tally
# in this file to go stale, after the summary count of the limits in the heading,
# limit #6's list of what the prune drops, and MAINTAINING.md's copy of these
# same numbers. A tally of the guard's own blind spot is a hand-written count
# living inside the guard that exists to catch hand-written counts, and it has
# now been wrong more often than it has been right. RE-DERIVE, NEVER RECALL:
#
#   TIER_SRC_EXCLUDE="" scripts/validate_harness_tier_claims.sh
#
# Its FIRST line is the un-pruned CORPUS size and every dropped hit is listed
# below it with file and line. The cli/src WALK is a DIFFERENT quantity that this
# command does not print — count it with the same two finds the source-walk loop
# below runs, with and without the -prune arm. What is STABLE, and therefore the
# only thing written down here, is the KIND of hit the prune drops: mostly `it()`
# TITLES scoping their own fixture or naming a UNIX FILE MODE ("a 644 harness
# config"), plus a residue of doc comments — never a shipped copy of the
# descriptor. Limit #6 states what that residue costs.
DEFAULT_SRC_EXCLUDE="__tests__"

# An explicit TIER_DOC_SET means "scan precisely this" — BOTH tree halves go
# quiet unless the caller asks for a tree as well. Without that, every
# fixture-list test's asserted hit/scanned counts would move whenever someone
# added a doc under core/ or a module under cli/src, and a test whose expected
# value drifts with unrelated work is a test people re-pin without reading.
if [ -n "${TIER_DOC_SET+set}" ]; then
  TIER_DOC_TREE="${TIER_DOC_TREE-}"
  TIER_SRC_TREE="${TIER_SRC_TREE-}"
else
  TIER_DOC_TREE="${TIER_DOC_TREE-$DEFAULT_DOC_TREE}"
  TIER_SRC_TREE="${TIER_SRC_TREE-$DEFAULT_SRC_TREE}"
fi
TIER_SRC_EXCLUDE="${TIER_SRC_EXCLUDE-$DEFAULT_SRC_EXCLUDE}"
# `-`, not `:-`: an explicitly EMPTY TIER_DOC_SET means "no files", which is what
# the `+set` test above already assumed. Under `:-` an empty value silently
# reverted to the default six and a "scan only this tree" invocation quietly
# scanned the shipped docs too — a corpus larger than the caller asked for is
# the same class of surprise as one smaller.
TIER_DOC_SET="${TIER_DOC_SET-$DEFAULT_DOC_SET}"

# The adjacency pattern. Composed from named halves rather than one opaque line,
# because the DIGIT and WORD halves deliberately take DIFFERENT leading boundary
# classes and that asymmetry is load-bearing (see the header): a digit may not
# follow a hyphen (FR-136 / TD-367 brief ids), a number-word may (the
# "all-four-harness" compound adjective). Both halves live here so the header's
# description of the pattern and the thing that runs cannot drift apart.
COUNT_WORDS='three|four|five|six|seven'
# THE ADJECTIVE SLOT (round 6). One optional word of >=3 letters may sit between
# the numeral and the noun, so "All three AGENT harnesses" and "the 4 DELEGATED
# harnesses" report. The >=3 floor is not cosmetic: a 1-2 letter slot swallows an
# ORDINAL SUFFIX ("a 5th harness"), silently repealing the exemption this header
# states by name, which is the second reason round 4 declined the widening. See
# limit #5 for the measurement that reversed that decline.
COUNT_ADJECTIVE='([a-zA-Z]{3,}[ -])?'
# THE FILENAME EXCLUSION. The noun must not be immediately followed by a DOT and
# an alphanumeric, because "harness." glued to a word is a FILE NAME rather than
# the noun — "3 personal harness.claude.md symlinks" counts SYMLINKS, not
# harnesses, and it is the one hit the adjective slot could not otherwise
# separate from the defect. The `\.$` arm keeps a SENTENCE-FINAL "harnesses."
# reporting; without it the exclusion would eat every count that ends a sentence,
# which is the majority spelling in this corpus.
COUNT_NOT_FILENAME='($|[^.]|\.$|\.[^[:alnum:]])'
COUNT_TAIL="[- ]?(igris )?${COUNT_ADJECTIVE}harness(es)?$COUNT_NOT_FILENAME"
# The third alternative is the DIGIT MIRROR of the compound adjective the word
# half catches: "all-6-harness". It re-admits the hyphen the digit half excludes,
# but ONLY when the tail separator is a hyphen too — a brief id spells a SPACE
# there ("FR-136 Harness"), so the separator is what tells the two apart. Zero
# delta over the real 203-file corpus; see the header.
COUNT_HYPHEN_DIGIT='(^|[^[:alnum:]])[0-9]+-(igris-)?harness(es)?'
COUNT_PATTERN="(^|[^[:alnum:]])($COUNT_WORDS)$COUNT_TAIL|(^|[^[:alnum:]-])[0-9]+$COUNT_TAIL|$COUNT_HYPHEN_DIGIT"

# --- ARM 2: the ROSTER GRAMMAR pattern ----------------------------------------
# A NUMERAL-FREE sub-class no count pattern can ever reach: a value grammar that
# spells the roster out — `--harness <claude|codex|gemini|opencode>` — while the
# validator four lines below it accepts mcpTargetTypes(), which is six. There is
# no number on the line, so arm 1 is structurally blind to it.
#
# The unit is a CLI VALUE-GRAMMAR WRAPPER (`<a|b|c|d>` or `{a,b,c,d}`) and NOT
# "roster ids anywhere on the line" — that broader predicate was measured and
# DECLINED; limit #8 carries the numbers. A grammar wrapper is the notation that
# means "these and only these", so a wrapper enumerating MOST of the roster but
# not all of it is a hardcoded allowlist by construction.
#
# The alternation is DERIVED from harness-manifest.json at run time, never
# hardcoded: onboarding a seventh harness re-arms this arm with no edit here, and
# widens the "omits >= 1" test by itself.
TIER_ROSTER_MIN="${TIER_ROSTER_MIN-4}"

# --- ARM 3: the DISPLAY-NAME ENUMERATION pattern ------------------------------
# The THIRD notation, and the one that survived seven rounds: the roster spelled
# out in PROSE, in DISPLAY names — "Claude Code, OpenCode, Antigravity, Codex, or
# Gemini CLI". Arm 1 needs a numeral and there is none; arm 2's alternation is
# built from lowercase manifest ids and its unit is a CLI value-grammar wrapper,
# so neither arm can see it BY CONSTRUCTION, however either is tuned.
#
# The unit is a CONTIGUOUS DELIMITED RUN of display names, and the threshold is
# 5 rather than arm 2's 4. Both were measured over the real corpus before being
# chosen; limit #10 carries the table and the MEASUREMENT that justifies the
# threshold — N=5 reports 0 hits over this corpus, N=4 reports 5 and all five are
# correct. THE GROUND IS EMPIRICAL. This line asserted for a round that it was
# "a property of the descriptor rather than a number that happened to work",
# which limit #10 retracts: five sits ON a declared subset (`mcp.projected`, the
# roster minus antigravity), not above one.
TIER_DISPLAY_MIN="${TIER_DISPLAY_MIN-5}"

# --- Read the declared ROSTER (fail-open, loudly) -----------------------------
# The IDS, not merely the length: arms 2 and 3 build their alternations from
# them, so both re-arm themselves when a harness is onboarded. The count is
# DERIVED from the id list rather than read separately, so the two can never
# disagree.
#
# READ AS `<id> <agent_id>` PAIRS, in ONE reader call, because arm 3 needs the
# agent_id and a SECOND read is a second thing that can disagree with the first.
# The agent_id is what makes the display name derivable: `claude-code` and
# `gemini-cli` are the spellings prose renders as "Claude Code" and "Gemini
# CLI", and no `display_name` field exists in the descriptor to read instead.
# See limit #10.
declared_pairs=""
if command -v jq >/dev/null 2>&1; then
  declared_pairs="$(jq -r '.harnesses | to_entries[]
    | .key + " " + ((.value.agent_id // .key) | tostring)' \
    "$HARNESS_MANIFEST" 2>/dev/null || true)"
elif command -v python3 >/dev/null 2>&1; then
  declared_pairs="$(python3 -c "
import json, sys
try:
    with open(sys.argv[1]) as fh:
        harnesses = json.load(fh).get('harnesses', {})
    for k in sorted(harnesses):
        block = harnesses[k]
        agent = block.get('agent_id', k) if isinstance(block, dict) else k
        if not isinstance(agent, str):
            agent = k
        print(k + ' ' + agent)
except Exception:
    pass
" "$HARNESS_MANIFEST" 2>/dev/null || true)"
else
  echo "harness tier claims: SKIP — neither jq nor python3 is available to read the descriptor"
  exit 0
fi

# Keep only ids that are safe to interpolate into an ERE alternation. An id that
# carried a metacharacter would otherwise turn arm 2's pattern into something
# other than what this header describes.
#
# THE TWO FILTERS ARE INDEPENDENT ON PURPOSE, and neither uses awk. `declared_ids`
# is derived with the SAME grep class as before the pair read landed, so arms 1
# and 2 behave identically whether or not awk exists — an agent_id that failed
# the safety class must cost arm 3 one SPELLING, never cost arm 2 a whole
# harness, and must never turn an awk-less machine's LOUD arm-2 skip into a
# silent roster SKIP that also takes arm 1 down with it.
declared_ids="$(printf '%s\n' "$declared_pairs" | sed -E 's/ .*$//' \
  | grep -E '^[a-z0-9][a-z0-9_-]*$' || true)"
declared_pairs="$(printf '%s\n' "$declared_pairs" \
  | grep -E '^[a-z0-9][a-z0-9_-]* [a-z0-9][a-z0-9_-]*$' || true)"
declared_count="$(printf '%s\n' "$declared_ids" | grep -c '[^[:space:]]' || true)"
declared_count="$(printf '%s' "$declared_count" | tr -d ' ')"

if [ -z "$declared_count" ] || [ "$declared_count" -eq 0 ] 2>/dev/null; then
  echo "harness tier claims: SKIP — could not read .harnesses from $HARNESS_MANIFEST"
  exit 0
fi

# --- Resolve the corpus, and prove it is non-empty ----------------------------
# A scan over zero files reports "clean" while measuring nothing. The count of
# files actually scanned is printed on every path, so an exit 0 states what it
# checked rather than merely that it finished.
scanned=()
missing=""

# Membership is tracked as a newline-delimited string, not an associative array:
# this repo still runs on bash 3.2 (macOS /bin/bash), which has no `declare -A`.
# The `case` arms quote the interpolated path, so a checkout path containing a
# glob metacharacter is compared literally.
seen=$'\n'
add_doc() {
  case "$seen" in
    *$'\n'"$1"$'\n'*) return 0 ;;  # already in the corpus — never counted twice
  esac
  scanned+=("$1")
  seen="$seen$1"$'\n'
}

for doc in $TIER_DOC_SET; do
  case "$doc" in
    /*) resolved="$doc" ;;
    *)  resolved="$REPO_ROOT/$doc" ;;
  esac
  if [ -f "$resolved" ]; then
    add_doc "$resolved"
  else
    missing+="  not on disk: $doc"$'\n'
  fi
done

# The tree half. `find` runs in its default -P mode and asks for -type f, so a
# symlink is neither followed nor counted: if core/ (or anything under it) were
# ever a symlink to the ~/.igris/core runtime mirror, the walk would decline to
# descend rather than scan the mirror and report every hit twice under two
# paths. Sorted under LC_ALL=C so the corpus order — and therefore the report
# order — is byte-deterministic across machines and locales.
for tree in $TIER_DOC_TREE; do
  case "$tree" in
    /*) resolved_tree="$tree" ;;
    *)  resolved_tree="$REPO_ROOT/$tree" ;;
  esac
  if [ ! -d "$resolved_tree" ]; then
    missing+="  not on disk (tree): $tree"$'\n'
    continue
  fi
  while IFS= read -r walked; do
    [ -n "$walked" ] || continue
    add_doc "$walked"
  done <<EOF
$(find "$resolved_tree" -type f -name '*.md' -print | LC_ALL=C sort)
EOF
done

# The SOURCE tree half. Same -P posture and same LC_ALL=C sort as the markdown
# walk, so the report stays byte-deterministic across machines. The one
# difference is the PRUNE: `-name "$TIER_SRC_EXCLUDE" -prune -o` drops the test
# directory before descending, which is the unit limit #6 measured and chose.
# The prune arm is applied only when the exclude name is non-empty, so
# TIER_SRC_EXCLUDE="" scans everything (what the arm-check test uses to prove
# the exclusion is a CHOICE and not an inability).
for tree in $TIER_SRC_TREE; do
  case "$tree" in
    /*) resolved_tree="$tree" ;;
    *)  resolved_tree="$REPO_ROOT/$tree" ;;
  esac
  if [ ! -d "$resolved_tree" ]; then
    missing+="  not on disk (src tree): $tree"$'\n'
    continue
  fi
  if [ -n "$TIER_SRC_EXCLUDE" ]; then
    walked_src="$(find "$resolved_tree" -type d -name "$TIER_SRC_EXCLUDE" -prune -o \
      -type f -name '*.ts' -print | LC_ALL=C sort)"
  else
    walked_src="$(find "$resolved_tree" -type f -name '*.ts' -print | LC_ALL=C sort)"
  fi
  while IFS= read -r walked; do
    [ -n "$walked" ] || continue
    add_doc "$walked"
  done <<EOF
$walked_src
EOF
done

if [ "${#scanned[@]}" -eq 0 ]; then
  echo "harness tier claims: SKIP — none of the scanned docs exist"
  printf '%s' "$missing"
  exit 0
fi

# --- Scan ---------------------------------------------------------------------
# -H, not bare -n: grep omits the filename when handed exactly ONE file, so a
# single-doc scan would report a bare line number with nothing to open.
hits="$(grep -inHE "$COUNT_PATTERN" "${scanned[@]}" 2>/dev/null || true)"

# ARM 2 — the roster grammar. One awk pass over the same corpus (one fork, not
# one per file). Skipped, loudly, when awk is unavailable or the caller set
# TIER_ROSTER_MIN=0; the count arm still runs, so a missing awk degrades this
# guard rather than disabling it.
roster_hits=""
roster_note=""
if [ "$TIER_ROSTER_MIN" -gt 0 ] 2>/dev/null; then
  if command -v awk >/dev/null 2>&1; then
    roster_hits="$(awk \
      -v roster="$(printf '%s' "$declared_ids" | tr '\n' ' ')" \
      -v minrun="$TIER_ROSTER_MIN" '
BEGIN {
  n = split(roster, ids, " ")
  alt = ""
  for (i = 1; i <= n; i++) alt = alt (alt == "" ? "" : "|") ids[i]
  # An element may be quoted (a TS union type spells "claude" | "gemini") or
  # backticked (markdown). Interval quantifiers are NOT used: the awk that ships
  # with macOS does not implement them, so the repetition is written out.
  el = "[\"`]?(" alt ")[\"`]?"
  dl = " ?[|,] ?"
  body = el
  for (i = 2; i <= minrun; i++) body = body "(" dl el ")"
  body = body "(" dl el ")*"
  rx = "[<{]" body
}
{
  line = tolower($0)
  if (!match(line, rx)) next
  run = substr(line, RSTART, RLENGTH)
  present = 0
  for (i = 1; i <= n; i++)
    if (match(run, "(^|[^a-z0-9])" ids[i] "([^a-z0-9]|$)")) present++
  # >= minrun DISTINCT ids (the regex only guarantees that many ELEMENTS, which
  # a repeat could satisfy) AND at least one omitted. A wrapper naming the WHOLE
  # roster is not a hit: it is exhaustive, which is the thing being asked for.
  if (present >= minrun && present < n) printf "%s:%d:%s\n", FILENAME, FNR, $0
}
' "${scanned[@]}" 2>/dev/null || true)"
  else
    roster_note="  roster arm SKIPPED — awk is not available"
  fi
fi

# ARM 3 — the DISPLAY-NAME enumeration. One more awk pass over the same corpus.
# Kept as its own pass rather than folded into arm 2's: the two arms take
# different alternations (ids only vs ids PLUS agent_ids), different units (a
# grammar wrapper vs a prose run), different delimiters and different
# thresholds, and each must stay independently disableable via its own
# TIER_*_MIN. One extra fork over a 203-file corpus is not the budget; an arm
# nobody can turn off alone to measure it is.
display_hits=""
display_note=""
if [ "$TIER_DISPLAY_MIN" -gt 0 ] 2>/dev/null; then
  if [ -z "$declared_pairs" ]; then
    display_note="  display-name arm SKIPPED — no <id> <agent_id> pair survived the safety filter"
  elif command -v awk >/dev/null 2>&1; then
    display_hits="$(awk \
      -v pairs="$(printf '%s' "$declared_pairs" | tr '\n' ';')" \
      -v minrun="$TIER_DISPLAY_MIN" '
BEGIN {
  # Build ONE pattern per harness that matches EITHER of its two derived
  # spellings — the manifest id ("opencode", "cursor") and the agent_id
  # ("claude-code", "gemini-cli"), which is the token prose renders as a display
  # name. A HYPHEN in either is relaxed to an optional space-or-hyphen, so
  # "Claude Code", "claude-code" and "claudecode" are one spelling of one
  # notation rather than three vocabulary entries. Case is folded on the line,
  # so a sentence-initial "Claude" is the same claim as a mid-sentence one.
  rows = split(pairs, row, ";")
  n = 0
  for (i = 1; i <= rows; i++) {
    if (row[i] ~ /^[ \t]*$/) continue
    split(row[i], f, " ")
    id = f[1]; agent = (f[2] == "" ? f[1] : f[2])
    gsub(/-/, "[- ]?", id)
    gsub(/-/, "[- ]?", agent)
    n++
    # agent_id FIRST: it is the longer spelling, so an engine that is not
    # leftmost-longest still prefers "claude-code" over its "claude" prefix.
    pat[n] = (agent == id) ? id : ("(" agent "|" id ")")
  }
  # No n < 2 bail-out. The bash above already SKIPs, loudly, when no pair
  # survived the safety filter, so n >= 1 here; and `present >= minrun &&
  # present < n` is unsatisfiable for n < minrun anyway. A defensive branch no
  # test can arm is a branch nobody knows is broken.
  el = ""
  for (i = 1; i <= n; i++) el = el (el == "" ? "" : "|") pat[i]
  el = "(" el ")"
  # A PROSE enumeration delimiter set: comma, coordinating conjunction, Oxford
  # comma, and the slash-joined form this repo also writes. Interval quantifiers
  # are NOT used — macOS awk does not implement them — so the run is written out,
  # exactly as arm 2 writes its own.
  dl = "(, | or | and |, or |, and |/)"
  rx = el
  for (i = 2; i <= minrun; i++) rx = rx "(" dl el ")"
  rx = rx "(" dl el ")*"
}
{
  line = tolower($0)
  if (!match(line, rx)) next
  seg = substr(line, RSTART, RLENGTH)
  present = 0
  for (i = 1; i <= n; i++)
    if (match(seg, "(^|[^a-z0-9])" pat[i] "([^a-z0-9]|$)")) present++
  # DISTINCT names, counted inside the RUN and not on the whole line: an id that
  # merely appears elsewhere on the line is the broad predicate limit #10
  # measured and declined. `present < n` keeps an EXHAUSTIVE list quiet — naming
  # the whole roster is the thing being asked for, not the defect.
  if (present >= minrun && present < n) printf "%s:%d:%s\n", FILENAME, FNR, $0
}
' "${scanned[@]}" 2>/dev/null || true)"
  else
    display_note="  display-name arm SKIPPED — awk is not available"
  fi
fi

echo "harness tier claims: ${#scanned[@]} doc(s) scanned, descriptor declares $declared_count harness(es)"
if [ -n "$missing" ]; then
  printf '%s' "$missing"
fi
if [ -n "$roster_note" ]; then
  printf '%s\n' "$roster_note"
fi
if [ -n "$display_note" ]; then
  printf '%s\n' "$display_note"
fi

if [ -z "$hits" ] && [ -z "$roster_hits" ] && [ -z "$display_hits" ]; then
  echo ""
  echo "OK: no hand-written harness count in the scanned docs — every claim names the property"
  exit 0
fi

# Strip the repo-root prefix so the report reads as repo-relative citations.
# Done in bash, not sed: a `s|^$REPO_ROOT/||` breaks on a checkout path
# containing the delimiter, and the quoted `#` expansion also disables glob
# interpretation of a path containing * ? or [.
report_lines() {
  while IFS= read -r hit_line; do
    printf '%s\n' "${hit_line#"$REPO_ROOT/"}"
  done <<< "$1"
}

if [ -n "$hits" ]; then
  hit_count="$(printf '%s\n' "$hits" | wc -l | tr -d ' ')"
  echo ""
  echo "harness tier claims: $hit_count hand-written count(s) found"
  report_lines "$hits"
  echo ""
  echo "  A harness COUNT in prose is a copy of the descriptor that nothing keeps in"
  echo "  sync — the exact drift TD-367 removed. Replace each hit with the PROPERTY"
  echo "  that produces it (\"every harness with an mcp block\", \"every skills-target"
  echo "  harness\"), or with a link to docs/multi-cli.md's Harness tiers section,"
  echo "  which carries the one-line command that re-derives the roster:"
  echo ""
  echo "    jq -r '.harnesses | keys[]' harness-manifest.json"
  echo ""
  echo "  The descriptor currently declares $declared_count harness(es); do not simply"
  echo "  update the numeral to match, or the next onboarding re-opens this report."
fi

if [ -n "$roster_hits" ]; then
  roster_count="$(printf '%s\n' "$roster_hits" | wc -l | tr -d ' ')"
  echo ""
  echo "harness tier claims: $roster_count hardcoded roster grammar(s) found"
  report_lines "$roster_hits"
  echo ""
  echo "  A value grammar (\`<a|b|c>\` / \`{a,b,c}\`) that spells out MOST of the roster"
  echo "  but not all of it is a hand-maintained allowlist with NO numeral in it, so"
  echo "  the count report above is structurally blind to it. Each hit is either a"
  echo "  stale roster or a genuine per-surface subset — say WHICH, by naming the"
  echo "  accessor that produces the set (mcpTargetTypes / agentTargetTypes /"
  echo "  hookTargetTypes / skillAgentIds) instead of the literal ids."
  echo ""
  echo "  The descriptor declares $declared_count harness(es):"
  echo "    $(printf '%s' "$declared_ids" | tr '\n' ' ')"
fi

if [ -n "$display_hits" ]; then
  display_count="$(printf '%s\n' "$display_hits" | wc -l | tr -d ' ')"
  echo ""
  echo "harness tier claims: $display_count display-name roster enumeration(s) found"
  report_lines "$display_hits"
  echo ""
  echo "  A PROSE list of harness display names — \"A, B, C, or D\" — naming at least"
  echo "  $TIER_DISPLAY_MIN of the declared harnesses while omitting at least one. There is no"
  echo "  numeral on the line and no CLI value grammar either, so the two reports"
  echo "  above are both structurally blind to it. This is the spelling that keeps"
  echo "  coming back: the roster is written out when a doc is authored and the next"
  echo "  onboarding lands everywhere EXCEPT the sentence."
  echo ""
  echo "  Replace the list with the property, and link the definition home:"
  echo "  \"any of the CLIs the roster declares — see docs/multi-cli.md#harness-tiers\"."
  echo "  If the line really is a per-surface SUBSET, say which surface and name the"
  echo "  accessor that produces it — the guard reports the NOTATION and cannot tell"
  echo "  a stale roster from a deliberate subset."
  echo ""
  echo "  The descriptor declares $declared_count harness(es):"
  echo "    $(printf '%s' "$declared_ids" | tr '\n' ' ')"
fi

exit 1
