/**
 * Shared dry-run reporter.
 *
 * Every state-changing verb (init, refresh, install, update, sync)
 * accepts a `--dry-run` flag that should:
 *
 *   1. Skip every actual filesystem write, network call, and external
 *      command invocation.
 *   2. Collect the would-be side effects as structured records.
 *   3. Print the records in a human-readable plan AND an exit-code-0
 *      contract (no errors are emitted by dry-run; the user is
 *      previewing).
 *
 * This module is the data structure + printer. Verbs hold a
 * `DryRunCollector` and call its methods at every would-be side-effect
 * site. When `dryRun=false`, the collector is null and the verb
 * calls real fs/network APIs as usual.
 *
 * Output format (per AC bullets):
 *
 *   Dry-run plan:
 *     mkdir -p:
 *       /path/to/dir1
 *       /path/to/dir2
 *     write file:
 *       /path/to/file (reason)
 *     fetch URL:
 *       https://example.com/foo.tar.gz
 *     invoke command:
 *       bash /path/to/script.sh arg1 arg2 (reason)
 *     remove dir:
 *       /path/to/old
 *     rename:
 *       /from/path -> /to/path (reason)
 *     copy:
 *       /from/path -> /to/path (reason)
 *
 *   No filesystem writes were performed.
 *
 * `copy:` is distinct from `rename:` (TD-142): the non-dry path uses
 * recursive copy semantics (source tree preserved), whereas `rename:`
 * is a single fs.renameSync (atomic move on the same filesystem).
 */

import { info } from "./log.js";
import type { DryRunPlan } from "../types.js";

export class DryRunCollector {
  private plan: DryRunPlan = {
    would_create_dir: [],
    would_write_file: [],
    would_fetch_url: [],
    would_invoke_command: [],
    would_remove_dir: [],
    would_rename: [],
    would_copy: [],
  };

  wouldCreateDir(path: string): void {
    if (!this.plan.would_create_dir.includes(path)) {
      this.plan.would_create_dir.push(path);
    }
  }
  wouldWriteFile(path: string, reason: string): void {
    this.plan.would_write_file.push({ path, reason });
  }
  wouldFetchUrl(url: string): void {
    if (!this.plan.would_fetch_url.includes(url)) {
      this.plan.would_fetch_url.push(url);
    }
  }
  wouldInvokeCommand(command: string, args: string[], reason: string): void {
    this.plan.would_invoke_command.push({ command, args, reason });
  }
  wouldRemoveDir(path: string): void {
    if (!this.plan.would_remove_dir.includes(path)) {
      this.plan.would_remove_dir.push(path);
    }
  }
  wouldRename(from: string, to: string, reason: string): void {
    this.plan.would_rename.push({ from, to, reason });
  }
  /**
   * Recursive directory copy (TD-142). Distinct from wouldRename — the
   * actual non-dry path uses copyFromSource(...) (preserves source) vs
   * fs.renameSync (atomic move that removes source).
   */
  wouldCopy(from: string, to: string, reason: string): void {
    this.plan.would_copy.push({ from, to, reason });
  }

  /** Snapshot the current plan (used by tests). */
  snapshot(): DryRunPlan {
    // Deep copy via JSON round-trip — plan items are plain data.
    return JSON.parse(JSON.stringify(this.plan)) as DryRunPlan;
  }

  /** Pretty-print the plan to stdout via lib/log. */
  print(): void {
    info("");
    info("Dry-run plan:");
    if (this.plan.would_create_dir.length > 0) {
      info("  mkdir -p:");
      for (const p of this.plan.would_create_dir) info(`    ${p}`);
    }
    if (this.plan.would_write_file.length > 0) {
      info("  write file:");
      for (const p of this.plan.would_write_file) {
        info(`    ${p.path} (${p.reason})`);
      }
    }
    if (this.plan.would_fetch_url.length > 0) {
      info("  fetch URL:");
      for (const u of this.plan.would_fetch_url) info(`    ${u}`);
    }
    if (this.plan.would_invoke_command.length > 0) {
      info("  invoke command:");
      for (const c of this.plan.would_invoke_command) {
        info(`    ${c.command} ${c.args.join(" ")} (${c.reason})`);
      }
    }
    if (this.plan.would_remove_dir.length > 0) {
      info("  remove dir:");
      for (const p of this.plan.would_remove_dir) info(`    ${p}`);
    }
    if (this.plan.would_rename.length > 0) {
      info("  rename:");
      for (const r of this.plan.would_rename) {
        info(`    ${r.from} -> ${r.to} (${r.reason})`);
      }
    }
    if (this.plan.would_copy.length > 0) {
      info("  copy:");
      for (const c of this.plan.would_copy) {
        info(`    ${c.from} -> ${c.to} (${c.reason})`);
      }
    }
    if (this.isEmpty()) {
      info("  (no changes)");
    }
    info("");
    info("No filesystem writes were performed.");
  }

  /** True when no items have been recorded. */
  isEmpty(): boolean {
    return (
      this.plan.would_create_dir.length === 0 &&
      this.plan.would_write_file.length === 0 &&
      this.plan.would_fetch_url.length === 0 &&
      this.plan.would_invoke_command.length === 0 &&
      this.plan.would_remove_dir.length === 0 &&
      this.plan.would_rename.length === 0 &&
      this.plan.would_copy.length === 0
    );
  }
}
