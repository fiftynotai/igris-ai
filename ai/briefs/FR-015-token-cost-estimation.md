# FR-015: Token Cost Estimation Dashboard

**Type:** Feature Request
**Priority:** P2-Medium
**Effort:** M-Medium (1-2d)
**Assignee:** Igris AI
**Commanded By:** Fifty.ai
**Status:** Done
**Created:** 2026-02-09
**Completed:** 2026-02-10

---

## Feature Description

**What is the proposed feature?**

Add estimated USD cost calculations to the Token Breakdown card based on Anthropic API pricing per token type and model. The dashboard already tracks all 4 token buckets (input, output, cache_read, cache_create) and the active model_id — this feature multiplies those counts by their per-token rates to show real money spent.

**Why is this valuable?**

Users currently see raw token counts but have no intuition for what those numbers cost. 44M cached tokens sounds alarming but costs ~$66 on Opus. 172K direct tokens sounds tiny but could be $13+ (input) or $12+ (output) on Opus. Showing actual dollar estimates turns abstract numbers into actionable budget awareness.

---

## User Value

### Who Benefits?
- [x] End users (people using the product)
- [x] Developers (building with Igris AI)

### Pain Point Solved
**Current situation:**
Dashboard shows token counts but users must manually calculate cost. Different token types have wildly different rates (cache_read is 10x cheaper than input on Opus), making mental math unreliable.

**With this feature:**
Users see estimated cost at a glance, broken down by token type. They can immediately tell if a session was expensive or cheap, and which token type is driving cost.

---

## Use Cases

### Use Case 1: Daily Cost Check
**Actor:** Developer using Igris AI
**Goal:** Know how much today's AI usage costs
**Steps:**
1. Open Crimson Arena dashboard
2. Look at Token Breakdown card
3. See estimated cost next to "Direct Tokens" headline

**Expected Outcome:** Sees something like "~$25.40 est." with per-type breakdown

### Use Case 2: Cost-Aware Model Selection
**Actor:** Developer choosing between Opus/Sonnet/Haiku
**Goal:** Understand cost impact of model choice
**Steps:**
1. Work a session on Opus, check cost
2. Compare with Sonnet session cost
3. Make informed model choice for different task types

**Expected Outcome:** Clear cost visibility per model tier

---

## Technical Approach

### Live Pricing Source: LiteLLM Community Registry

Instead of hardcoding prices (which go stale when Anthropic updates rates), fetch from the **LiteLLM model pricing registry** — a community-maintained JSON with pricing for all major AI models:

```
https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json
```

**Why LiteLLM?**
- Covers all Claude models with all 4 cost fields we need
- Updated frequently by the community when providers change pricing
- Structured JSON — easy to parse, no scraping needed
- ~500KB file but we only need Claude entries

**Relevant fields per model entry:**
```json
{
  "claude-opus-4-6": {
    "input_cost_per_token": 5e-06,
    "output_cost_per_token": 2.5e-05,
    "cache_read_input_token_cost": 5e-07,
    "cache_creation_input_token_cost": 6.25e-06
  }
}
```

### Architecture: Server-Side Fetch + Cache

The ~500KB JSON is too large to fetch client-side on every page load. Use the existing Python dashboard server:

```
LiteLLM GitHub (JSON)
    │
    ▼
server.py: fetch on startup + every 24h
    │ Filter to claude-* entries only
    │ Cache in memory
    ▼
/api/pricing endpoint (tiny JSON, claude models only)
    │
    ▼
app.js: fetch once on init, use for cost calculations
```

**Server changes (server.py):**
1. Add `fetch_pricing()` function — HTTP GET to LiteLLM URL
2. Filter entries where key starts with `claude-` (no vendor prefix)
3. Normalize keys to match our `model_id` format (e.g., `claude-opus-4-6`)
4. Cache result in memory with TTL of 24 hours
5. Add `/api/pricing` GET endpoint returning the filtered pricing map
6. Hardcoded fallback pricing if fetch fails (network down, GitHub rate limited)

**Frontend changes (app.js):**
1. Fetch `/api/pricing` on init, store as `this.pricing`
2. `estimateCost(input, output, cacheRead, cacheCreate, modelId)` function
3. Render cost in `renderTokenBreakdown` using stored pricing

### Cost Calculation (Frontend)

```javascript
ArenaClient.prototype.estimateCost = function (input, output, cacheRead, cacheCreate) {
    var modelId = this.contextWindow ? this.contextWindow.model_id : '';
    var rates = (this.pricing || {})[modelId] || this.pricing['claude-opus-4-6'] || null;
    if (!rates) return null;

    var inputCost = input * rates.input_cost_per_token;
    var outputCost = output * rates.output_cost_per_token;
    var cacheReadCost = cacheRead * rates.cache_read_input_token_cost;
    var cacheCreateCost = cacheCreate * rates.cache_creation_input_token_cost;

    return {
        input: inputCost,
        output: outputCost,
        cache_read: cacheReadCost,
        cache_create: cacheCreateCost,
        total: inputCost + outputCost + cacheReadCost + cacheCreateCost
    };
};
```

### Display: Separate Cost Estimate Card

A dedicated panel below Token Breakdown showing itemized cost per token type with rate × count = cost, plus a total footer.

```
+---------------------------------------+
| COST ESTIMATE — Today (Opus)          |
|                                       |
| Input      38.6K × $5.00/M     $0.19 |
| Output     10.4K × $25.00/M    $0.26 |
| · · · · · · · · · · · · · · · · · ·  |
| Cache Rd   40.4M × $0.50/M    $20.20 |
| Cache Wr    4.0M × $6.25/M    $25.00 |
| ───────────────────────────────────── |
| Estimated Total               $45.65 |
+---------------------------------------+
```

#### Layout Details

- **Title:** `COST ESTIMATE` section-title + range label + model name in muted text
- **Each row:** 3 columns — token count (left), rate per MTok (center, muted), cost (right, colored)
- **Dotted separator** between direct rows (Input/Output) and cache rows (same pattern as Token Breakdown)
- **Total footer:** bold, border-top separated, gold-colored total

#### Color Scheme

- Token counts: `--text-secondary` (matches Token Breakdown counts)
- Rate column (`× $5.00/M`): `--text-muted` (de-emphasized — the rate is context, not primary data)
- Per-row cost: each in its token-type color (`--token-input` for Input cost, `--token-output` for Output cost, `--token-cache-r` for Cache Rd cost, `--token-cache-c` for Cache Wr cost)
- Total cost: `--hp-warning` (#F7A100, gold) at 18px bold — the hero number
- "Estimated" label: `--text-muted` at 12px

#### CSS Classes (BEM)

```css
.cost-card { }                       /* panel block */
.cost-card__row { }                  /* each token type row */
.cost-card__count { }                /* token count (left) */
.cost-card__rate { }                 /* × $X/M (center, muted) */
.cost-card__amount { }               /* per-row cost (right) */
.cost-card__amount--input { }        /* colored per token type */
.cost-card__amount--output { }
.cost-card__amount--cache-read { }
.cost-card__amount--cache-create { }
.cost-card__separator { }            /* dotted line */
.cost-card__total { }                /* total footer row */
.cost-card__total-label { }          /* "Estimated Total" */
.cost-card__total-value { }          /* $45.65 in gold */
.cost-card--no-pricing { }           /* hide card when no data */
```

#### Row Grid

```css
.cost-card__row {
  display: grid;
  grid-template-columns: 90px 1fr auto;
  align-items: baseline;
  gap: var(--space-sm);
}
```

- Col 1 (90px): Token type label — matches Token Breakdown label width
- Col 2 (1fr): Rate text `× $5.00/M` — fills available space, right-aligned or centered
- Col 3 (auto): Cost amount `$0.19` — right-aligned

#### Sidebar Stacking Order

```
sidebar (360px)
├── Token Breakdown panel (existing)
├── Cost Estimate panel (NEW)
└── Battle Log panel (flex: 1, takes remaining space)
```

Battle Log already has `flex: 1` and `min-height: 200px` with overflow scroll, so it handles being pushed down gracefully.

### Components Affected

- `dashboard/server.py` — Add pricing fetch, cache, `/api/pricing` endpoint, fallback
- `dashboard/static/app.js` — Fetch pricing on init, cost calculation, new `renderCostCard` method
- `dashboard/static/index.html` — Add new `.cost-card` panel between Token Breakdown and Battle Log
- `dashboard/static/style.css` — Add `.cost-card` block with all element classes

### Model ID Matching

The `contextWindow.model_id` from orchestrator events (e.g., `claude-opus-4-6`) must match the LiteLLM registry keys. LiteLLM uses various key formats:
- `claude-opus-4-6` (direct match)
- `anthropic.claude-opus-4-6-v1` (vendor-prefixed)

Strategy: try exact match first, then prefix search. The server normalizes keys during filtering.

### Model Short Name Helper

```javascript
ArenaClient.prototype._getModelShortName = function () {
    var modelId = this.contextWindow ? this.contextWindow.model_id : '';
    if (!modelId) return '';
    if (modelId.indexOf('opus') !== -1) return 'Opus';
    if (modelId.indexOf('sonnet') !== -1) return 'Sonnet';
    if (modelId.indexOf('haiku') !== -1) return 'Haiku';
    return modelId;
};
```

### Rate Formatting

Rates from LiteLLM are per-token (e.g., `5e-06`). Display as per-MTok for readability:
- `5e-06` → `$5.00/M`
- `2.5e-05` → `$25.00/M`
- `5e-07` → `$0.50/M`

```javascript
function formatRate(costPerToken) {
    var perMTok = costPerToken * 1000000;
    return '$' + perMTok.toFixed(2) + '/M';
}
```

---

## Constraints

### Technical Constraints
- Server + frontend change (server fetches pricing, frontend renders)
- Pricing auto-updates from LiteLLM registry (no manual maintenance)
- Hardcoded fallback pricing if LiteLLM fetch fails (offline resilience)
- Must handle missing model_id gracefully (default to Opus)
- LiteLLM JSON is ~500KB — must filter server-side, not send to client

### UX Constraints
- Cost must be clearly labeled as "estimated" (actual billing may differ due to batch pricing, commitments, etc.)
- Must not clutter the Token Breakdown card — keep it compact
- Per-bar costs should be optional/subtle (don't overwhelm with numbers)

### Out of Scope
- Real-time API billing integration (just estimates from published rates)
- Historical cost tracking / cost over time charts
- Budget alerts / spending limits
- Multi-model sessions (use the most recent model_id for all calculations)
- Custom/enterprise pricing tiers

---

## Acceptance Criteria

1. [ ] Server fetches LiteLLM pricing on startup and caches it (24h TTL)
2. [ ] `/api/pricing` endpoint returns Claude-only pricing map
3. [ ] Hardcoded fallback pricing works when LiteLLM fetch fails
4. [ ] Separate Cost Estimate card renders below Token Breakdown
5. [ ] Each row shows: token count, rate per MTok, and cost in token-type color
6. [ ] Dotted separator between direct rows and cache rows
7. [ ] Total footer shows estimated total in gold (#F7A100)
8. [ ] Model name shown in card title (e.g., "COST ESTIMATE — Today (Opus)")
9. [ ] Falls back to Opus pricing when model_id unknown
10. [ ] Cost updates in real-time as new events arrive via WebSocket
11. [ ] Respects time range filter (Today/Week/All Time)
12. [ ] Card hidden gracefully when no pricing data available
13. [ ] No visual regression on existing Token Breakdown or Battle Log

---

## Test Plan

### Manual Test Cases

**Test Case 1: Pricing fetch**
1. Start dashboard server with internet access
2. Verify `/api/pricing` returns JSON with claude model entries
3. Verify prices match current LiteLLM registry values

**Test Case 2: Fallback pricing**
1. Start dashboard server without internet (or block GitHub)
2. Verify `/api/pricing` still returns hardcoded fallback rates
3. Verify cost calculations still work

**Test Case 3: Cost accuracy**
1. Note token counts from dashboard
2. Manually calculate expected cost using published Anthropic rates
3. Verify dashboard estimate matches within rounding

**Test Case 4: Model detection**
1. Run a session on Opus, verify "(Opus)" label
2. Run subagent on Haiku, verify cost uses lower rates for those tokens

**Test Case 5: Zero state**
1. Load dashboard with no data
2. Verify cost shows "$0.00" or is hidden gracefully

---

## Notes

**Pricing source:** LiteLLM community registry
- URL: `https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json`
- Maintained by the LiteLLM open-source community
- Updated when providers change pricing
- Contains all 4 cost fields: `input_cost_per_token`, `output_cost_per_token`, `cache_read_input_token_cost`, `cache_creation_input_token_cost`

**Hardcoded fallback rates (for offline resilience):**

| Model | Input | Output | Cache Read | Cache Write |
|-------|-------|--------|------------|-------------|
| Opus 4.6 | $5/MTok | $25/MTok | $0.50/MTok | $6.25/MTok |
| Sonnet 4.5 | $3/MTok | $15/MTok | $0.30/MTok | $3.75/MTok |
| Haiku 4.5 | $1/MTok | $5/MTok | $0.10/MTok | $1.25/MTok |

**Key insight from BR-015:** Cache reads are 10x cheaper than direct input. Showing cost makes this concrete — 40M cache_read tokens on Opus costs ~$20, while 40K input tokens costs only ~$0.20. The volume is misleading without cost context.

**Future Enhancements:**
- Cost-per-session tracking over time
- Daily/weekly cost trend chart
- Budget threshold warnings in the HP bar
- Per-agent cost breakdown in RPG Party Stats

---

**Created:** 2026-02-09
**Last Updated:** 2026-02-09
**Brief Owner:** Fifty.ai
