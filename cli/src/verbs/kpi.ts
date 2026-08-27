/**
 * `igris kpi` — the seven OS KPIs, computed on read (FR-268).
 *
 * A REPORTING verb (markdown by default, `--json` for machines), unlike the
 * lifecycle verbs that print JSON always. `--sql` prints the derivations
 * verbatim so `sqlite3` reproduces them on any harness (R2); `--alarm` prints
 * the ONE line `/scan` renders (Q6). `--weeks N` (default 4) counts back from
 * the current UTC week, which is included and marked partial.
 *
 * Every read goes through the READ-ONLY door (`brain-db.ts#readKpiDigest` →
 * `openBrainReadonly`, `query_only = ON`): asking a question must not mutate
 * the brain, and must never boot the write engine (whose init runs the
 * `event_log` purge). Exit 0 ALWAYS — `degraded` + `skipped[]` name what could
 * not be computed (no brain, a brain older than v3 / v4).
 */

import { basenameOfCwd } from "../lib/sync/util.js";
import { readKpiDigest } from "../lib/brain-db.js";
import { kpiSqlListing } from "../lib/kpi-read.js";
import type { KpiDigest } from "../types.js";

export interface KpiOptions {
  project?: string;
  weeks?: number;
  json?: boolean;
  sql?: boolean;
  alarm?: boolean;
}

const DEFAULT_WEEKS = 4;

function n(v: number | null | undefined, digits = 1): string {
  return v === null || v === undefined ? "—" : v.toFixed(digits);
}

function pct(v: number | null | undefined): string {
  return v === null || v === undefined ? "—" : `${Math.round(v * 100)}%`;
}

function table(header: string[], rows: string[][]): string[] {
  if (rows.length === 0) return ["_no rows in the window_", ""];
  return [
    `| ${header.join(" | ")} |`,
    `|${header.map(() => "---").join("|")}|`,
    ...rows.map((r) => `| ${r.join(" | ")} |`),
    "",
  ];
}

/** Markdown for the whole digest — what `/ops` renders. */
export function renderKpiMarkdown(d: KpiDigest): string {
  const out: string[] = [];
  const last = d.weeks.length > 0 ? d.weeks[d.weeks.length - 1] : null;
  out.push(
    `## OS KPIs (FR-268) — tz: ${d.tz}, weeks ${d.since ?? "—"} → ${last?.week_end ?? "—"}` +
      `${last?.partial ? ` (current week ${last.week_start} partial)` : ""}, project: ${d.project ?? "all"}, generated ${d.generated_at ?? "—"} UTC`,
  );
  out.push("");
  if (d.degraded) {
    out.push(`**Degraded:** ${d.skipped.join("; ")}`, "");
  }
  out.push("### 1. Capacity — brain-bracket agent minutes per project per week");
  out.push(...table(["project", "week", "agent_min", "invocations", "briefs"],
    d.capacity.map((r) => [r.project, r.week_start, String(r.agent_minutes), String(r.invocations), String(r.briefs)])));
  out.push("### 2. Throughput — Done per week / per active day");
  out.push(...table(["project", "week", "done", "active_days", "done/active_day"],
    d.throughput.map((r) => [r.project, r.week_start, String(r.done), String(r.active_days), n(r.done_per_active_day, 2)])));
  out.push("### 3. Effort mix of Done (XS+S share per project-week)");
  out.push(...table(["project", "week", "effort", "done", "xs_s_share"],
    d.effort_mix.map((r) => [r.project, r.week_start, r.effort, String(r.done), pct(r.xs_s_share)])));
  out.push("### 4. Minutes per hunt — median / p75, phase shares (week of the hunt's last row)");
  out.push(...table(["project", "week", "hunts", "median", "p75", "architect", "forger", "sentinel", "warden", "mender", "document"],
    d.hunt_minutes.map((r) => [r.project, r.week_start, String(r.hunts), n(r.median_min), n(r.p75_min),
      pct(r.architect_share), pct(r.forger_share), pct(r.sentinel_share), pct(r.warden_share), pct(r.mender_share), pct(r.document_share)])));
  out.push("### 5. Rounds per hunt — resumed / retry rounds");
  out.push(...table(["project", "week", "hunts", "resumed", "resumed_share", "avg_extra_rounds"],
    d.hunt_rounds.map((r) => [r.project, r.week_start, String(r.hunts), String(r.hunts_resumed), pct(r.resumed_share), n(r.avg_extra_rounds, 2)])));
  out.push("### 6. Model per role — per-invocation minutes (window), tool calls when reported");
  out.push(...table(["agent", "model_requested", "n", "median", "p75", "tool_calls_median", "tool_calls_n"],
    d.model_per_role.map((r) => [r.agent, r.model_requested ?? "(null)", String(r.n), n(r.median_min), n(r.p75_min),
      r.tool_calls_median === null ? "—" : String(r.tool_calls_median), String(r.tool_calls_n)])));
  out.push("### 7. Ceremony cost — runs, median / p75 minutes; coverage (unpaired goes red)");
  out.push(...table(["project", "ceremony", "week", "runs", "median", "p75"],
    d.ceremony_cost.map((r) => [r.project, r.ceremony, r.week_start, String(r.runs), n(r.median_min), n(r.p75_min)])));
  out.push(...table(["project", "ceremony", "week", "starts", "stops", "unpaired", "unpaired_stops"],
    d.ceremony_coverage.map((r) => [r.project, r.ceremony, r.week_start, String(r.starts), String(r.stops),
      r.unpaired === 0 ? "0" : `**${r.unpaired}**`, String(r.unpaired_stops)])));
  if (d.alarm) {
    out.push("### Alarm", "", d.alarm.line, "");
  }
  out.push("### Notes");
  out.push(...d.notes.map((s) => `- ${s}`), "");
  return out.join("\n");
}

export function runKpi(opts: KpiOptions): number {
  if (opts.sql) {
    process.stdout.write(kpiSqlListing() + "\n");
    return 0;
  }
  const weeks = opts.weeks !== undefined && Number.isFinite(opts.weeks) && opts.weeks >= 1 ? Math.floor(opts.weeks) : DEFAULT_WEEKS;
  // The alarm is per project: default the slug the way the lifecycle verbs do.
  const project = opts.project ?? (opts.alarm ? basenameOfCwd() : null);
  const digest = readKpiDigest({ project, weeks, alarm: opts.alarm === true });

  if (opts.alarm) {
    if (opts.json) {
      process.stdout.write(
        JSON.stringify({ degraded: digest.degraded, project: digest.project, tz: digest.tz, generated_at: digest.generated_at, alarm: digest.alarm, skipped: digest.skipped }) + "\n",
      );
    } else if (digest.alarm) {
      process.stdout.write(digest.alarm.line + "\n");
    } else {
      process.stdout.write(`KPI: unavailable (${digest.skipped.join("; ")})\n`);
    }
    return 0;
  }
  if (opts.json) {
    process.stdout.write(JSON.stringify(digest) + "\n");
    return 0;
  }
  process.stdout.write(renderKpiMarkdown(digest));
  return 0;
}
