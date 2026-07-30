# Dashboard design-language port — provenance

**Brief:** FR-238
**Source repo:** `fifty_dev`
**Source commit:** `dc9da4a33018d516ced132db80db45b646b60915` (2026-07-28)
**Ported:** 2026-07-28

This file exists because R6 says so. The dashboard is a **port**, not an
original design, and this repo has no `design_system` context doc to anchor it
against (see "Missing doc" below). Six months from now nobody will be able to
tell which divergences from fifty.dev were deliberate and which were drift —
unless the deliberate ones are written down. That is this file's whole job.

**Discipline that makes drift greppable:** exported names, prop names and CSS
class names are kept **byte-aligned with fifty.dev**. A future divergence is one
`git grep` away in either repo. Do not rename a ported symbol without recording
it here.

---

## 1. File map

| Igris path (relative to `cli/dashboard/`) | fifty_dev origin | Fidelity |
|---|---|---|
| `src/styles/tokens.css` | `src/app/globals.css:23-149` | Token values **verbatim**; font plumbing diverges (D1 below) |
| `src/styles/base.css` | `src/app/globals.css` — the subset listed per-block in the file's own comments (`:163-181`, `:189-214`, `:216-226`, `:228-300`, `:332-340`, `:585-600`, `:1088-1115`, `:1167-1236`, `:1238-1288`, `:1289-1333`, `:1334-1376`, `:1377-1423`, `:1425-1458`, `:1559-1596`, `:6287-6430`, `:6461-6465`) | Class bodies **verbatim**; new `.shell-*` block is original (D3) |
| `src/lib/cn.ts` | `src/lib/utils.ts#cn` | Signature identical; implementation diverges (D6) |
| `src/components/ui/Card.tsx` | `src/components/ui/Card.tsx` | **Verbatim** except the `cn` import path |
| `src/components/ui/Badge.tsx` | `src/components/ui/Badge.tsx` | **Verbatim** except the `cn` import path |
| `src/components/ui/Button.tsx` | `src/components/ui/Button.tsx` | **Verbatim** except the `cn` import path |
| `src/components/ui/Input.tsx` | `src/components/ui/Input.tsx` | **Verbatim** except the `cn` import path |
| `src/components/ui/StatusPill.tsx` | `src/components/ui/StatusPill.tsx` | **Verbatim** except the `cn` import path |
| `src/components/ui/Chip.tsx` | `src/components/ui/Chip.tsx` | `filter` variant dropped (D7) |
| `src/components/ui/StatePage.tsx` | `src/components/ui/StatePage.tsx` | `next/link` → `<a>`; new `inset` prop (D4, D5) |
| `src/components/ui/EmptyState.tsx` | `src/components/ui/EmptyState.tsx` | Default CTA dropped; `inset` defaults true (D8) |
| `src/components/chrome/Grain.tsx` | `src/components/chrome/Grain` | Behaviourally identical (a single `<div class="grain">`) |
| `src/components/chrome/Cursor.tsx` | `src/components/chrome/Cursor` | Ring+dot only; PRM gate added (D9) |
| `index.html` inline script | `src/app/layout.tsx` `TWEAKS_INIT_SCRIPT` | Same mechanism; namespaced storage key + reduced key set (D10) |
| `src/lib/usePalette.ts` | `src/components/chrome/TweaksPanel.tsx` `PALETTES` | Palette list **verbatim** (`blood`/`cyber`/`acid`/`mono`) |
| `src/components/chrome/PaletteSwitcher.tsx` | `src/components/chrome/TweaksPanel.tsx` (palette radiogroup only) | Palette control only — the rest of TweaksPanel is not ported (D11) |

Original to FR-238, with no fifty.dev counterpart: `src/App.tsx`,
`src/router.tsx`, `src/main.tsx`, `src/pages/Overview.tsx`,
`src/components/chrome/Nav.tsx`, `src/components/chrome/LiveIndicator.tsx`,
`src/lib/api.ts`, `src/lib/useLive.ts`, and the `.shell-*` CSS block.

---

## 2. Deliberate divergences

Each is a decision, not an accident. If you are reconciling the two codebases,
these are the diffs you should expect to find.

**D1 — font plumbing.** fifty.dev loads Anton / Space Grotesk / JetBrains Mono
through `next/font/google`, a Next **build-time** mechanism with no Vite
equivalent, and AC #4 forbids a runtime CDN fetch. The three families are
therefore vendored as latin-subset woff2 under `public/fonts/` and declared with
`@font-face` in `tokens.css`. Token names (`--display` / `--ui` / `--mono`) and
their fallback stacks are unchanged.

Sources — all SIL OFL 1.1, notice at `public/fonts/OFL.txt`:

| Family | Package | File | Bytes |
|---|---|---|---|
| Anton 400 | `@fontsource/anton@5.3.0` | `anton-latin-400-normal.woff2` | 18,612 |
| Space Grotesk 300–700 (variable) | `@fontsource-variable/space-grotesk@5.3.0` | `space-grotesk-latin-wght-normal.woff2` | 22,288 |
| JetBrains Mono 400 | `@fontsource/jetbrains-mono@5.3.0` | `jetbrains-mono-latin-400-normal.woff2` | 21,168 |

The packages are **not** dependencies — the three files were extracted once and
committed. Refreshing a font means re-extracting from the named package version
and updating this table.

**D2 — no `data-display` swaps.** fifty.dev's Bebas Neue / Archivo Black /
Instrument Serif display swaps (`globals.css:151-160`) are **not** ported. The
AC names four *palettes*, not display swaps, and three more families is ~60 KB
of tarball for a control the dashboard has no room for. Consequence: `--serif`
resolves to `Georgia, serif` rather than Instrument Serif, which is visible on
`StatePage`'s italic message line.

**D3 — `.shell-*` is new.** fifty.dev is a scroll-driven marketing site; its
`--section-pad-*` / `--hero-pad-*` responsive ladder and `.top` bar model a page,
not an application shell. The dashboard has a fixed nav and a routed main, so
the shell geometry (`--nav-h`, `--shell-pad-*`, `.shell-nav`, `.shell-grid`,
`.shell-metric`, `.shell-kv`, `.shell-skel`, `.shell-live`, `.shell-banner`) is
original — but built **entirely from the ported tokens**, so BRAND_RULES #2
(sharp corners), #3 (3-tier type) and #6 (palette switching) hold by
construction rather than by review.

**D4 — `StatePage` uses `<a>`, not `next/link`.** There is no Next router here.

**D5 — `StatePage` gains an `inset` prop.** Upstream is a full-page `<section>`
with a `min-height: 100vh` floor. The dashboard renders these inside a routed
panel; `inset` swaps in the `[data-inset="true"]` block (shorter floor, hairline
border, smaller headline) instead of pretending a panel is a page.

**D6 — `cn` does not wrap `clsx`.** Hand-rolled over the exact subset the seven
ported components use (`string | false | null | undefined`), so the bundle
carries no third-party runtime code for a five-line join. The signature is
unchanged, so swapping back is a one-file edit.

**D7 — `Chip` drops the `filter` variant.** Upstream's third variant composes
`.out-pill` (the Gallery filter strip). No consumer here; its CSS is not ported.

**D8 — `EmptyState` drops the default CTA.** Upstream defaults to
`{label: "RETURN HOME", href: "/"}`. In a single-page lens with a permanent nav
there is nowhere to return to. Headline and message defaults are upstream's,
verbatim. `inset` defaults to `true` since every consumer renders in a panel.

**D9 — `Cursor` ports the `dot` mode only, and gates GSAP on PRM.** Upstream's
`crosshair` and `blob` cursor modes are TweaksPanel surface area with no consumer
here. The PRM gate is an addition: under `prefers-reduced-motion` **no GSAP
timeline is created at all** (the ring is positioned directly), because the CSS
PRM block can zero a duration but cannot reach a JS timeline. It also bails to
`data-cursor="default"` on a coarse pointer.

**D10 — the palette-stamp script.** Same mechanism and same placement intent as
`TWEAKS_INIT_SCRIPT` (run before hydration so a reload never flashes the default
palette), but: the storage key is namespaced `igris.dashboard.tweaks` so it can
never collide with fifty.dev's `fifty.tweaks`; it reads only `palette`, `cursor`,
`motion` and `grain`; and it sits as the first child of `<body>` rather than in
`<head>`, because it stamps attributes **on** `<body>`, which must exist. Both it
and `usePalette.ts` read the same key — keep them in sync.

**D11 — only the palette control is ported from `TweaksPanel`.** Density,
motion, pose, grain-slider and display-swap controls are not.

---

## 3. What is NOT a divergence

- **`StatusPill` colours do not respond to `data-palette`.** That is upstream's
  rule (FR-110c): lifecycle status is semantic, so LIVE is green in every
  palette. A "palette switching must work across all components" review must not
  read these five as a miss.
- **`.chip` has `border-radius: 9999px`** while everything else is sharp. Also
  upstream, and deliberate there: it is a circle for a tag, not a rounded
  rectangle. BRAND_RULES #2 names cards and buttons.

---

## 4. FR-239 — the data-viz consumption

**Brief:** FR-239 · **Source spec:** `fifty_dev/docs/brand/dataviz.md` +
`motion.md` (commit `dc9da4a`) · **Ported:** 2026-07-29

FR-238 ported a design *language*. FR-239 is the first surface built against
`dataviz.md`, whose §08 worked example is literally this view. Three things it
added to the token layer, all in `styles/tokens.css`:

| Added | Source | Note |
|---|---|---|
| `--t-instant` / `--t-quick` / `--t-std` / `--t-slow` / `--t-cine` | `motion.md` "Six durations" | **Five, not six.** `// LOOP` is the one duration `dataviz.md` forbids on a canvas, so it has no alias. Its absence is the guardrail. |
| `--e-linear` / `--e-std` / `--e-spring` / `--e-step` | `motion.md` "Four easings" | Values verbatim. Resolved at runtime and evaluated as curves so the canvas and the CSS cannot disagree about what `// STD` means. |
| `--s-1` … `--s-8` | `space.md` 8-pt scale | Node size floors are expressed against this, never as bare pixels. |
| `--dataviz-bone/-accent/-muted/-grid/-edge-dim` | `dataviz.md` §02 | The complete sanctioned list — "and no others". |

**D12 — the `--dataviz-*` aliases are declared on `body`, not `:root`.**
Upstream has no data-viz consumer, so this has no counterpart to diverge from —
but it is the single most important line in the block. A `var()` inside a custom
property is substituted using the computed values **of the element it is
declared on**. The palette overrides live on `body[data-palette=…]`, so a
`:root` declaration substitutes against `html`'s values — the default `blood`
palette — and freezes there. Every palette then renders identically. That is not
a hypothetical: it was the first version, and it took a real browser to catch
(the unit tests drive the *reader* over an injected style source and never touch
the cascade). Guarded now by a mechanical assertion in `graph/__tests__/palette.test.ts`.

**D13 — `force-graph` is vendored, and the paint layer is still ours.** The
library owns force integration, the pan/zoom camera, drag, resize and
hit-testing. Every painted pixel — five shapes, four edge roles, the density
ladder, labels — is ours, drawn through `nodeCanvasObject`. No library can
express the spec's silhouettes without approximating them.

### The three findings, recorded

**F1 · Why not cytoscape.** At ~3,400 elements cytoscape's usual remedies are
`textureOnViewport` and `hideEdgesOnViewport`. Both are visual degradations —
but they are *cytoscape's* ladder, fired by a trigger (viewport motion) the spec
does not recognise, and `hideEdgesOnViewport` drops every edge at once, skipping
ladder rungs 3, 4 and 5 to land past rung 5. Under `force-graph` the degradation
is entirely ours, expressed through accessors, so the ladder is the spec's.
`graph/__tests__/tier.test.ts` asserts no tier skips a rung.

**F2 · The library's camera easing fights the tokens, in exactly two places.**
`centerAt(x, y, ms)` and `zoom(k, ms)` accept a duration but apply the library's
own easing, which is not one of `motion.md`'s four. **We never call their timed
form.** Every camera move is a GSAP tween on a token duration and token easing
whose `onUpdate` calls the instantaneous variants. Pinned by a source scan in
`dashboard-graph-source.test.ts`, and structurally by the `Camera` interface,
which has no duration parameter to pass one through.

**F3 · The library deletes less code than it looks like it will.** What it
genuinely takes off us is the risky ~40%. The paint layer is brand
implementation and stays. Stated so the expectation is right before anyone reads
the file list and wonders why there is so much of it.

### Two integration hazards this cost real time to find

Both were invisible to unit tests and were caught by driving a real browser.
They are written down because the next person to wire a canvas library will meet
at least one of them.

1. **`autoPauseRedraw` must be OFF.** It skips a redraw when the library judges
   nothing changed — but it can only judge *its own* props. Every visual state
   here (hover emphasis, filter progress, selection ring, active palette) lives
   in a mutable object the accessors read and the library knows nothing about.
   With it on, a `data-palette` swap resolved all five tokens correctly in CSS
   and the canvas kept painting the old palette, byte for byte.

2. **`pauseAnimation()` cannot be called inline from `onEngineStop`.** The
   library fires that callback from *inside* its frame callback, which re-arms
   the next frame after the callback returns. An inline pause cancels a frame
   that already fired and is immediately undone — the loop never stops. Measured:
   state reported `still`, the pixel hash was stable, and a painted-frame counter
   climbed 68 → 501 over 17 seconds. **The AC #5 pixel diff passes in that
   state**, which is exactly the weakness the plan named when the library path
   was chosen. The halt is now deferred by one macrotask, and the checkpoint in
   `docs/dashboard.md` gained a frame-count reading so the two cases can be told
   apart.

---

## 5. Missing doc

There is no `design_system` context doc in
`~/.igris/projects/igris-ai/context/`. It is **applicable but absent**, and more
salient after FR-239 than it was after FR-238.

FR-238's reason still stands: this repo ported an entire design language into a
codebase that had never had a UI. FR-239 sharpens it. The project now carries
four palettes, a 3-tier type stack, five durations, four easings, an 8-pt scale,
**a five-shape / four-edge data-viz vocabulary, and a documented mapping of that
vocabulary onto a specific third-party engine's accessors** — plus a
settle-then-still contract whose verification is empirical and whose two failure
modes are recorded above.

That last part exists nowhere upstream and cannot: `fifty_dev`'s brand book has
no reason to know `force-graph` exists. FR-240 and FR-241 would re-derive it from
scratch.

Authoring it is a follow-up (`/ground design_system`), now with a shipped
consumer to write it from. This file remains the interim provenance record and
the natural seed.
