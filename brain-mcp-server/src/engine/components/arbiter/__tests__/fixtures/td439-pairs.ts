/**
 * TD-439 — the dated known-answer world for the arbiter `evolved_merge` guard.
 *
 * HARVESTED 2026-09-04 from the live brain, READ-ONLY (`sqlite3 -readonly`;
 * the Python twin used `file:…?mode=ro`). Nothing under `__tests__` opens
 * `~/.igris/memory/knowledge.db` — every case seeds `:memory:` from THIS file.
 * The three queries, verbatim:
 *
 *   sqlite3 -readonly ~/.igris/memory/knowledge.db \
 *     "SELECT id, length(content), content FROM learnings
 *       WHERE id IN (258,941,257,1081,27,907,131,343,218)"
 *   sqlite3 -readonly ~/.igris/memory/knowledge.db \
 *     "SELECT id, suggested_action FROM suggestions WHERE id IN (1279,1353,1372,1373,1374)"
 *   sqlite3 -readonly ~/.igris/memory/knowledge.db \
 *     "SELECT id, learning_id, length(prior_content), prior_content FROM brain_maintenance_undo
 *       WHERE learning_id IN (258,941,257,1081) AND action_kind='resolve_contradiction' ORDER BY id"
 *
 * PROVENANCE IS ASSERTED, NOT TRUSTED. The brief's own table (loser 554 / 2347 /
 * 1144 / 1155, winner-after 447 / 595 / 457 / 513) is carried in `brief_lengths`
 * and the first `describe` of `td439-merge-guard.test.ts` checks every embedded
 * text against it. Those figures are sqlite `length()` — CHARACTERS, not bytes
 * (learning 27 is 554 chars / 560 bytes); JS `.length` agrees with sqlite on
 * this corpus (no astral code points). A hand-edited fixture goes red.
 *
 * THE MODELLING CHOICE. Each pair carries the winner at TWO points in time:
 *   `content_prior`    — the winner as it stood BEFORE the 2026-09-01 apply
 *                        (`brain_maintenance_undo.prior_content`, entries
 *                        20 / 26 / 28 / 24), i.e. the text the synthesis was
 *                        computed against;
 *   `content_repaired` — the winner as it stands NOW, after the operator's
 *                        hand repair under TD-437 restored what the synthesis
 *                        dropped (for 1081 the two coincide with the synthesis:
 *                        no repair was made — the brief's "merged cleanly").
 * Tests seed the losers as `approved` (the PRE-apply world) because
 * `applyResolveContradiction` is a no-op once the loser is `superseded`
 * (`kinds.ts` "IDEMPOTENT" guard) — against the live state every case would be
 * vacuous. AC-1 / AC-2 use `content_prior`; AC-4 uses `content_repaired`.
 *
 * `named_identifiers` are the brief's own list (all loser-borne). The two
 * `*_winner_only` lists were MEASURED with `extractSpecifics` on 2026-09-04:
 * specifics present in that winner text and absent from BOTH the loser and the
 * synthesis — the set that proves the carry-forward reads the winner side too
 * (a loser-only extractor keeps every `named_identifiers` entry green and drops
 * every one of these). `TD-437` is the repair trailer the operator appended to
 * 258 / 941 / 257 on 2026-09-01.
 *
 * THE 1374 SCENARIO. Suggestion 1374 (258 <- 218) was generated 2026-08-14
 * against 258's THEN text — modelled here as undo entry 20's `prior_content`,
 * the last text 258 held before 1372's apply; the brain keeps no earlier
 * snapshot — and marked `acted` under TD-437 on 2026-09-01 without its
 * executor running (218 is still `approved`, 258 is 971 chars, not the 383-char
 * synthesis). Had `applyAction` run it, 258's later merge + hand repair would
 * have been overwritten (the lost update the brief names). Its `action` is the
 * live `suggested_action` verbatim — it carries NO `synthesized_from_hash`.
 *
 * @module engine/components/arbiter/__tests__/fixtures/td439-pairs
 */

/** One harvested contradiction pair at both points in the winner's history. */
export interface Td439Pair {
  name: string;
  /** The live `suggestions.id` whose `synthesized_content` is embedded. */
  suggestion_id: number;
  winner: { id: number; content_prior: string; content_repaired: string };
  loser: { id: number; content: string };
  synthesized_content: string;
  /** The brief's table — sqlite `length()` (chars). Asserted by T0. */
  brief_lengths: { loser: number; synthesized: number };
  /** Harvest-time char counts of the two winner texts. Asserted by T0. */
  winner_lengths: { prior: number; repaired: number };
  /** The brief's named identifiers (loser-borne). */
  named_identifiers: string[];
  /** Measured: in `content_prior`, absent from the loser AND the synthesis. */
  prior_winner_only: string[];
  /** Measured: in `content_repaired`, absent from the loser AND the synthesis. */
  repaired_winner_only: string[];
}

export const WORLD_2026_09_04 = {
  harvested_at: '2026-09-04',
  pairs: [
    {
      name: "258<-27",
      suggestion_id: 1372,
      winner: {
        id: 258,
        // brain_maintenance_undo #20 prior_content
        content_prior: [
          "When pushing flat metric files via the brain sync mechanism, dispatch on file size:",
          "- **<200 KB**: use `igris_file_push` MCP tool (file content travels through context window as `content` param)",
          "- **>=200 KB**: shell out directly to curl against `/sync/file-push` HTTP endpoint",
          "",
          "Why the dual path: Read tool caps at 256 KB per call AND ~25,000 tokens per chunk. A 341 KB events.jsonl is ~85K tokens — requires 6+ Read chunks, string concatenation, and re-emission as the tool arg. That burns ~85-100K tokens per sync for what amounts to a binary upload. The HTTP endpoint accepts up to 50 MB JSON; curl bypasses the context-window round-trip cleanly.",
          "",
          "Dispatch logic:",
          "```bash",
          "if wc -c reports < 204800 → MCP tool path",
          "elif wc -c reports >= 204800 → curl direct path",
          "else (wc -c unavailable) → default to MCP tool path",
          "```",
          "",
          "Curl invocation:",
          "```bash",
          "python3 -c \"import json,sys; ...\" | curl -sS -X POST \\",
          "  -H \"X-API-Key: $API_KEY\" -H \"Content-Type: application/json\" \\",
          "  --data-binary @- \"$REMOTE_URL/sync/file-push\"",
          "```",
        ].join('\n'),
        // learnings.content as of 2026-09-04
        content_repaired: [
          "Dispatch brain-sync file pushes on payload size: use the `igris_file_push` MCP tool for files under 200KB, and a direct HTTP curl push to the `/sync/file-push` endpoint for files >=200KB.",
          "",
          "Mechanism: MCP tool `content` parameters travel through the model's context window — a 341KB events.jsonl burns ~85-100K tokens per sync, and the Read tool caps at 256KB / ~25K tokens per chunk (6+ chunks plus string concatenation). The curl path exists purely to avoid that round-trip; below the threshold the MCP path is simpler and cheap enough.",
          "",
          "Decision rule: `wc -c <file>` < 204800 → MCP tool; >= 204800 → curl. The HTTP endpoint accepts up to 50MB JSON.",
          "",
          "Verified: a 387KB events.jsonl pushed via curl returned `{\"ok\":true,\"bytes_written\":387893}` without consuming context.",
          "",
          "(Merged from learning 27 by arbiter 2026-09-01 under TD-437; the endpoint path, 50MB limit, byte-exact decision rule and the verification measurement were restored after the synthesis dropped them.)",
        ].join('\n'),
      },
      loser: {
        id: 27,
        content: [
          "Files passed through MCP tool `content` parameters travel through the model's context window — a 341KB events.jsonl burns ~85K-100K tokens per sync. Read tool also caps at 256KB and ~25K tokens per chunk, requiring 6+ chunks and string concatenation. For files >=200KB, shell out to curl against `/sync/file-push` HTTP endpoint instead, which accepts up to 50MB JSON. Decision rule: `wc -c <file>` < 204800 → MCP tool; >=204800 → curl. Confirmed: 387KB events.jsonl pushed via curl returned `{\"ok\":true,\"bytes_written\":387893}` without consuming context.",
        ].join('\n'),
      },
      synthesized_content: [
        "Dispatch brain-sync file pushes on payload size: use the `igris_file_push` MCP tool for files under 200KB, and a direct HTTP curl push for files >=200KB. MCP tool `content` parameters travel through the model's context window (a 341KB events.jsonl burns ~85-100K tokens, and the Read tool caps at 256KB / ~25K tokens per chunk), so the curl path exists purely to avoid that round-trip; below the threshold the MCP path is simpler and cheap enough.",
      ].join('\n'),
      brief_lengths: { loser: 554, synthesized: 447 },
      winner_lengths: { prior: 1019, repaired: 971 },
      named_identifiers: ["/sync/file-push", "50MB", "wc -c", "{\"ok\":true,\"bytes_written\":387893}"],
      prior_winner_only: ["50 MB", "200 KB", "256 KB", "341 KB"],
      repaired_winner_only: ["TD-437"],
    },
    {
      name: "941<-907",
      suggestion_id: 1353,
      winner: {
        id: 941,
        // brain_maintenance_undo #26 prior_content
        content_prior: [
          "TD-043 root-analysis of the recurring silent prefork worker stall (follow-on to L-907). Two non-obvious facts that reshape how you fix this class:",
          "",
          "1. The hard `task_time_limit` (finite 300s here) does NOT save you. The prefork hard-limit is enforced by a MainProcess monitor thread that only ARMS once a child BEGINS executing a task. The wedge is PRE-dispatch — the pool stops pulling/dispatching work while the control plane stays up — so the monitor has nothing to SIGKILL. That is exactly why 20h of logs showed zero TimeLimitExceeded. Corollary: `worker_max_tasks_per_child` (TD-037) also can't help — it recycles a child only AFTER N completions; a child that stalls mid-life before completing never recycles.",
          "",
          "2. `celery inspect ping` → pong is a FALSE-NEGATIVE for this failure. Ping answers from the MainProcess control channel, which stays alive while the pool is dead. The only reliable liveness probe ROUND-TRIPS A REAL TASK THROUGH THE POOL. TD-043 ships a `worker_heartbeat` task on a dedicated `heartbeat` queue + `scripts/worker_healthcheck.py` that enqueues it and awaits the result; a container healthcheck (compose + Coolify) restarts the worker when the probe times out. The dedicated queue is load-bearing: a freed child drains the trivial heartbeat ahead of the summarize backlog, so a healthy-but-busy worker resets its failure count and is NOT false-restarted. Restart-window math: interval×retries must clear the 300s hard limit (used 30s×10=300s; real margin comes from realistic task duration + the queue-drain reset, tune on staging).",
          "",
          "3. Root-cause hardening: the one genuinely UN-bounded external call in an asyncio Celery task was the asyncpg DB layer — `create_async_engine` with no `connect_args` has no connect/command timeout, so a wedged DB socket blocks a child forever. Add `connect_args={\"timeout\":..., \"command_timeout\":...}` (both below the hard limit). The LLM httpx client was already bounded (30s) — verify per-seam, don't assume. Also lower Redis `visibility_timeout` (3600→600) so a stranded task redelivers in ~10min not ~1h. Capture the next live stall with stdlib `faulthandler.enable()` + `faulthandler.register(SIGUSR1)` (works in a slim image) and/or procps+py-spy in the image. Gate any prefork→threads/solo pool switch behind captured evidence — threads/solo FORFEIT the hard-time-limit SIGKILL, trading one safety net for an unproven one.",
          "",
          "Shipped commit 1f6ff38 (mbrgea-ai). Supersedes TD-037.",
        ].join('\n'),
        // learnings.content as of 2026-09-04
        content_repaired: [
          "The silent Celery prefork worker wedge happens PRE-dispatch: the child never receives a task, so neither the hard `task_time_limit` nor `max_tasks_per_child` recycling reliably fires — the mitigation recorded in the original 2026-06-29 `/summaries` incident (max-tasks-per-child \"prevents\" it) does not actually cover this failure mode. The hard `task_time_limit` is enforced by a MainProcess monitor thread that only starts counting once a child picks the task up; pre-dispatch, there is nothing to time out.",
          "",
          "DETECT with an end-to-end pool round-trip, not a control-plane ping — a wedged-but-responsive worker still answers `inspect ping` with pong:",
          "",
          "    app.send_task('mbrgea_ai.tasks.ping').get()   # → pong only if the POOL executes",
          "",
          "REMEDIATE by restarting the worker, which clears the stall (runtime state, not code).",
          "",
          "Incident fingerprint (2026-06-29, staging worker `527b9983`, up 6 weeks without restart): `/summaries/{submission_id}` stuck on `Pending`; 16 tasks received / 0 succeeded in 48h; `celery inspect active` empty; `inspect ping` → pong; RestartCount=0; OOMKilled=false; no traceback. With default `task_acks_late=False` the worker ACKs on receipt then never runs → every submission silently dropped, `summary` row left `pending` forever (created_at == updated_at). 25 pending + 2 processing stranded, oldest May-14. Broker `LLEN celery`=0, so dropped tasks are LOST, not replayable from the queue.",
          "",
          "Deployment gotchas from that incident: Coolify \"Redeploy/Restart\" restarts the SAME image — a Force Rebuild is required to update worker code; a stale worker image predating the orphan sweep (TD-016) shows only `ping` + `summarize_submission` under `inspect registered`, with no `summarize_orphan_sweep`; `beat` was not deployed at all, so nothing flips stuck rows to `failed`; and the backlog cannot be re-enqueued locally because `summarize_submission(summary_id, report_content)` needs the raw report the main-app pushes inline and does not store — the main-app must re-submit with `force=true`.",
          "",
          "Monitor for \"0 succeeded while backlog > 0\", and keep worker code in lockstep with the api. Tracked: TD-037.",
          "",
          "(Merged from learning 907 by arbiter 2026-09-01 under TD-437; the probe command, incident fingerprint, deployment gotchas and brief references were restored after the synthesis dropped them.)",
        ].join('\n'),
      },
      loser: {
        id: 907,
        content: [
          "2026-06-29 incident. Main-app reported `/summaries/{submission_id}` stuck returning `Pending`. The endpoint just reads the summary row's status — the row genuinely never progressed.",
          "",
          "ROOT CAUSE: the Celery prefork worker (staging, `527b9983`, **up 6 weeks without restart**) had WEDGED. It accepted tasks off the broker (\"Task ... received\") but its pool no longer EXECUTED any: 16 received / 0 succeeded in 48h, `celery inspect active` empty, `inspect ping`→pong (control plane alive), RestartCount=0, OOMKilled=false, no crash/traceback in logs. With default `task_acks_late=False` the worker ACKED each task on receipt then never ran it → every submission silently dropped, its `summary` row left `pending` forever (created_at==updated_at). 25 pending + 2 processing stranded (oldest May-14). Broker `LLEN celery`=0 → the dropped tasks are LOST, not recoverable from the queue.",
          "",
          "CONFIRMED FIX: a restart cleared the wedge — proven by round-tripping the registered `ping` task through the pool (`app.send_task('mbrgea_ai.tasks.ping').get()` → pong). New tasks execute again.",
          "",
          "GOTCHAS (all real this incident):",
          "1. Coolify \"Redeploy/Restart\" only RESTARTED the worker to the SAME old image (`527b9983`); it did NOT rebuild to current `main`. A **Force Rebuild** is needed to update worker code. (The restart still cleared the wedge — runtime state, not code.)",
          "2. The stale worker image PREDATES the orphan-sweep (TD-016) — `inspect registered` showed only `ping` + `summarize_submission`, no `summarize_orphan_sweep`. So you can't sweep the backlog on old worker code.",
          "3. `beat` (orphan-sweep scheduler) wasn't deployed at all → nothing flips stuck rows to `failed`; they linger as `pending`.",
          "4. Backlog can't be re-enqueued by us: `summarize_submission(summary_id, report_content)` needs the raw report which the main-app PUSHES inline (D10) and isn't stored — so the main-app must re-submit (`force=true`).",
          "",
          "LESSONS: (a) long-uptime Celery prefork workers wedge silently — set `worker_max_tasks_per_child` to recycle children + `task_time_limit` so a hung task can't pin a child. (b) \"received but 0 succeeded, no crash\" == wedged pool; restart clears it. (c) monitor worker liveness (0 succeeded while backlog>0), same P1 posture as beat. (d) keep worker code in lockstep with the api — a stale worker silently lacks new tasks. Tracked: TD-037.",
        ].join('\n'),
      },
      synthesized_content: [
        "The silent Celery prefork worker wedge happens PRE-dispatch: the child never receives a task, so neither the hard `task_time_limit` nor `max_tasks_per_child` recycling reliably fires — the mitigation recorded in the original 2026-06-29 `/summaries` incident (max-tasks-per-child 'prevents' it) does not actually cover this failure mode. Correct handling: detect with an end-to-end pool round-trip probe (enqueue a trivial task and assert completion) rather than a control-plane ping, which a wedged-but-responsive worker still answers; remediate by restarting the worker, which clears the stall.",
      ].join('\n'),
      brief_lengths: { loser: 2347, synthesized: 595 },
      winner_lengths: { prior: 2450, repaired: 2322 },
      named_identifiers: ["app.send_task('mbrgea_ai.tasks.ping').get()", "LLEN celery", "527b9983", "TD-016", "TD-037"],
      prior_winner_only: ["TD-043", "1f6ff38", "scripts/worker_healthcheck.py", "faulthandler.enable()"],
      repaired_winner_only: ["TD-437"],
    },
    {
      name: "257<-131",
      suggestion_id: 1373,
      winner: {
        id: 257,
        // brain_maintenance_undo #28 prior_content
        content_prior: [
          "Short-lived Node CLIs that load native extensions (e.g., @huggingface/transformers ONNX runtime, sqlite-vec) must NOT call `process.exit(code)` synchronously to terminate. The synchronous exit race-kills native worker pools mid-shutdown, producing SIGABRT and stderr noise that masks the real exit reason.",
          "",
          "Canonical template (from BR-060, applied through FR-120):",
          "```typescript",
          "async function main(): Promise<number> {",
          "  try {",
          "    // ... work ...",
          "    await handleBrainPush(...)        // sync work",
          "    await disposeEmbeddingPipeline()  // release ONNX workers BEFORE shutdown",
          "    await engine.shutdown()           // close DB",
          "    return 0;",
          "  } catch (err) { return 1; }",
          "}",
          "main().then(rc => { process.exitCode = rc; });",
          "```",
          "",
          "Key points:",
          "- Use `process.exitCode = N` (not `process.exit(N)`) — lets the event loop drain naturally",
          "- Dispose native pipelines BEFORE engine.shutdown",
          "- Wrap teardown in try/finally so it runs even on error paths",
          "- Order: work → dispose native → close DB → set exitCode",
          "",
          "Original BR-060 misdiagnosis blamed sqlite-vec; `IGRIS_DISABLE_VEC=1` did NOT stop the abort, falsifying that hypothesis. Real cause: ONNX worker pool race.",
        ].join('\n'),
        // learnings.content as of 2026-09-04
        content_repaired: [
          "Short-lived Node CLIs that load native extensions (sqlite-vec, better-sqlite3, @huggingface/transformers ONNX) must never call `process.exit(code)` synchronously — it race-kills in-flight native teardown, produces SIGABRT and stderr noise that masks the real error, and can leave stale schemas. Use this lifecycle template instead:",
          "",
          "1. `bootEngine({ dbPath, components: {} })` at startup — runs per-component migrations on the connection so handlers don't hit \"no such table\".",
          "2. Wrap the work in `try { ... } finally { await disposeNativeResources(); engine.shutdown(); }` so cleanup runs even when the handler throws.",
          "3. Race a 5s timeout around shutdown — if it hangs, force-exit with the success code already logged. Work is persisted by then.",
          "4. At the entry point set `process.exitCode = code` rather than `process.exit(code)`, letting the event loop drain — critical when ONNX/transformers worker pools tear down asynchronously.",
          "5. Catch shutdown errors, log non-fatal, do not propagate or change the return code.",
          "",
          "Canonical references: `brain-mcp-server/scripts/brain_push_cli.ts` lines 289-326 (BR-064) and `perception_extract_cli.ts` (BR-060). The template is documented in `docs/operations/cli_lifecycle.md` with an adopters list.",
          "",
          "(Merged from learning 131 by arbiter 2026-09-01 under TD-437; the numbered template, code snippets, file/line references and brief IDs were restored after the synthesis dropped them.)",
        ].join('\n'),
      },
      loser: {
        id: 131,
        content: [
          "For any short-lived Node CLI that loads native extensions (sqlite-vec, better-sqlite3, transformers/ONNX workers), use this lifecycle template to avoid teardown races and stale schemas:",
          "",
          "1. `bootEngine({ dbPath, components: {} })` at startup — runs per-component migrations on the connection so handlers don't hit \"no such table\" errors.",
          "2. Wrap the work in `try { ... } finally { await disposeNativeResources(); engine.shutdown(); }` so cleanup runs even on handler throw.",
          "3. Add a 5s timeout race around shutdown — if it hangs, force-exit with the success code already logged. Work is persisted by then.",
          "4. At the entry point, use `process.exitCode = code` instead of `process.exit(code)`. This lets the event loop drain — critical when transformers/ONNX worker pools need to tear down asynchronously.",
          "5. Defensive: catch shutdown errors, log non-fatal, do not propagate or change return code.",
          "",
          "Canonical reference: `brain-mcp-server/scripts/brain_push_cli.ts` lines 289-326 (BR-064) and `perception_extract_cli.ts` (BR-060). Document the template in `docs/operations/cli_lifecycle.md` with adopters list so future short-lived CLIs follow it.",
        ].join('\n'),
      },
      synthesized_content: [
        "Short-lived Node CLIs that load native extensions (sqlite-vec, better-sqlite3, @huggingface/transformers ONNX) must never call `process.exit(code)` synchronously — it race-kills in-flight native teardown and can leave stale schemas. Use the lifecycle template instead: bootEngine at start, wrap the work in try/finally, run explicit teardown in the finally block, and set `process.exitCode` to signal the exit status, letting the event loop drain naturally.",
      ].join('\n'),
      brief_lengths: { loser: 1144, synthesized: 457 },
      winner_lengths: { prior: 1154, repaired: 1426 },
      named_identifiers: ["disposeNativeResources()", "engine.shutdown()", "brain_push_cli.ts", "289-326", "BR-060", "BR-064"],
      prior_winner_only: ["IGRIS_DISABLE_VEC=1", "FR-120"],
      repaired_winner_only: ["TD-437"],
    },
    {
      name: "1081<-343",
      suggestion_id: 1279,
      winner: {
        id: 1081,
        // brain_maintenance_undo #24 prior_content
        content_prior: [
          "Both hadir apps carry `tools:node=\"remove\"` entries in android/app/src/main/AndroidManifest.xml stripping READ_MEDIA_IMAGES and READ_MEDIA_VIDEO. A comment attributed them to image_picker. That attribution was WRONG.",
          "",
          "When TD-002 removed file_picker and image_picker, the plan concluded the strip entries were now dead config and deleted them. The merged-manifest report showed both permissions immediately returning. The real injector is `open_filex`, which the app keeps for opening exported PDF attendance reports.",
          "",
          "Evidence: build/app/outputs/logs/manifest-merger-debug-report.txt shows",
          "`uses-permission#android.permission.READ_MEDIA_IMAGES ADDED from [:open_filex]`.",
          "",
          "Had the deletion shipped, a commit whose stated purpose was REDUCING privacy surface would have added two sensitive media permissions to an app already rejected twice on store policy.",
          "",
          "Lesson: never infer which plugin injects a permission from a code comment or from which package \"looks\" related. Verify against build/app/outputs/logs/manifest-merger-debug-report.txt, or diff `aapt dump permissions` on APKs built before and after. The merger report names the injecting module explicitly.",
          "",
          "Related: open_filex declares FOUR permissions (READ_EXTERNAL_STORAGE maxSdkVersion=32, READ_MEDIA_IMAGES, READ_MEDIA_VIDEO, READ_MEDIA_AUDIO). Only two are stripped; READ_MEDIA_AUDIO still reaches the merged manifest. Tracked as TD-007.",
        ].join('\n'),
        // learnings.content as of 2026-09-04
        content_repaired: [
          "Android manifest-merger overrides (tools:node=\"remove\") are still the correct way to strip READ_MEDIA_IMAGES/READ_MEDIA_VIDEO for one-time-picker use cases that Play Store would otherwise reject — but the plugin actually injecting those permissions in the hadir apps is open_filex, NOT image_picker. The original attribution to image_picker was wrong; verify the injecting plugin via the merged manifest before removing or swapping a dependency, since removing image_picker would not have cleared the permissions.",
        ].join('\n'),
      },
      loser: {
        id: 343,
        content: [
          "image_picker (and similar Flutter plugins) auto-inject READ_MEDIA_IMAGES and READ_MEDIA_VIDEO into the merged Android manifest. Play Store rejects apps that use these permissions if the use case is \"one-time or infrequent\" (e.g. profile photo, attachment upload, SOS report) — Google's Photo and Video Permissions policy demands persistent need. Fix: add to AndroidManifest.xml inside the manifest tag (with xmlns:tools=\"http://schemas.android.com/tools\" already declared):",
          "",
          "  <uses-permission android:name=\"android.permission.READ_MEDIA_IMAGES\" tools:node=\"remove\" />",
          "  <uses-permission android:name=\"android.permission.READ_MEDIA_VIDEO\" tools:node=\"remove\" />",
          "",
          "image_picker_android v0.8.9+ automatically falls back to the system Photo Picker (Android 13+, no permission needed) and MediaStore (older Android, also no permission). SOS/picker flows keep working. Verify after rebuild by grepping the merged manifest at build/app/intermediates/merged_manifests/release/processReleaseManifest/AndroidManifest.xml. READ_MEDIA_AUDIO injected by Firebase Messaging (legacy IID tokens) is unrelated and Google does NOT flag it; same trick works if they ever do.",
        ].join('\n'),
      },
      synthesized_content: [
        "Android manifest-merger overrides (tools:node=\"remove\") are still the correct way to strip READ_MEDIA_IMAGES/READ_MEDIA_VIDEO for one-time-picker use cases that Play Store would otherwise reject — but the plugin actually injecting those permissions in the hadir apps is open_filex, NOT image_picker. The original attribution to image_picker was wrong; verify the injecting plugin via the merged manifest before removing or swapping a dependency, since removing image_picker would not have cleared the permissions.",
      ].join('\n'),
      brief_lengths: { loser: 1155, synthesized: 513 },
      winner_lengths: { prior: 1401, repaired: 513 },
      named_identifiers: [],
      prior_winner_only: ["TD-002", "TD-007", "build/app/outputs/logs/manifest-merger-debug-report.txt", "aapt dump permissions"],
      repaired_winner_only: [],
    },
  ] as Td439Pair[],
  scenario_1374: {
    suggestion_id: 1374,
    /** The live `suggested_action`, verbatim — note: no `synthesized_from_hash`. */
    action: {
      kind: 'resolve_contradiction',
      resolution: 'evolved_merge',
      winner_id: 258,
      loser_id: 218,
      synthesized_content: [
        "MCP tools that accept file content as a string parameter force that content through the model's context window (Read it, then re-emit it as the tool arg), which is prohibitively expensive for large payloads. Dispatch on size when pushing files to the brain: <200KB via the `igris_file_push` MCP tool, >=200KB via a direct HTTP curl push that bypasses the context round-trip entirely.",
      ].join('\n'),
      justification: "The older learning states the general context-round-trip hazard and the newer one encodes it as a concrete size-dispatch rule; one merged statement carries both the mechanism and the threshold.",
    } as Record<string, unknown>,
    /** 258 at generation (undo #20 prior_content) — what the synthesis was computed from. */
    winner_content_at_generation: [
      "When pushing flat metric files via the brain sync mechanism, dispatch on file size:",
      "- **<200 KB**: use `igris_file_push` MCP tool (file content travels through context window as `content` param)",
      "- **>=200 KB**: shell out directly to curl against `/sync/file-push` HTTP endpoint",
      "",
      "Why the dual path: Read tool caps at 256 KB per call AND ~25,000 tokens per chunk. A 341 KB events.jsonl is ~85K tokens — requires 6+ Read chunks, string concatenation, and re-emission as the tool arg. That burns ~85-100K tokens per sync for what amounts to a binary upload. The HTTP endpoint accepts up to 50 MB JSON; curl bypasses the context-window round-trip cleanly.",
      "",
      "Dispatch logic:",
      "```bash",
      "if wc -c reports < 204800 → MCP tool path",
      "elif wc -c reports >= 204800 → curl direct path",
      "else (wc -c unavailable) → default to MCP tool path",
      "```",
      "",
      "Curl invocation:",
      "```bash",
      "python3 -c \"import json,sys; ...\" | curl -sS -X POST \\",
      "  -H \"X-API-Key: $API_KEY\" -H \"Content-Type: application/json\" \\",
      "  --data-binary @- \"$REMOTE_URL/sync/file-push\"",
      "```",
    ].join('\n'),
    /** 258 now (repaired) — the text a stale apply would overwrite. */
    winner_content_now: [
      "Dispatch brain-sync file pushes on payload size: use the `igris_file_push` MCP tool for files under 200KB, and a direct HTTP curl push to the `/sync/file-push` endpoint for files >=200KB.",
      "",
      "Mechanism: MCP tool `content` parameters travel through the model's context window — a 341KB events.jsonl burns ~85-100K tokens per sync, and the Read tool caps at 256KB / ~25K tokens per chunk (6+ chunks plus string concatenation). The curl path exists purely to avoid that round-trip; below the threshold the MCP path is simpler and cheap enough.",
      "",
      "Decision rule: `wc -c <file>` < 204800 → MCP tool; >= 204800 → curl. The HTTP endpoint accepts up to 50MB JSON.",
      "",
      "Verified: a 387KB events.jsonl pushed via curl returned `{\"ok\":true,\"bytes_written\":387893}` without consuming context.",
      "",
      "(Merged from learning 27 by arbiter 2026-09-01 under TD-437; the endpoint path, 50MB limit, byte-exact decision rule and the verification measurement were restored after the synthesis dropped them.)",
    ].join('\n'),
    loser_content: [
      "When an MCP tool takes file content as a string parameter, the content has to flow through the model's context window — Read it, then re-emit it as the tool arg. For large files (>200KB) this hits multiple ceilings:",
      "- Read tool's 256KB-per-call cap",
      "- Read tool's 25k-token-per-chunk cap (forcing multi-chunk reads + concatenation)",
      "- Burns ~85-100k tokens of context per push for a single ~340KB file",
      "",
      "The cleanest workaround: shell out to curl directly, bypassing MCP. Construct the JSON payload via `python3 -c \"import json; print(json.dumps({...}))\"` and pipe to `curl --data-binary @-`. Stays out of model context entirely.",
      "",
      "```bash",
      "python3 -c \"",
      "import json, sys",
      "with open('PATH') as f:",
      "    print(json.dumps({'file_type': 'events', 'content': f.read()}))",
      "\" | curl -sS -X POST -H \"X-API-Key: $API_KEY\" -H \"Content-Type: application/json\" \\",
      "  --data-binary @- \"$REMOTE_URL/sync/file-push\"",
      "```",
      "",
      "When to use:",
      "- Files over ~200KB that need to be pushed verbatim",
      "- Periodic uploads (logs, metrics) where the content is opaque-to-the-model",
      "- Any case where the MCP tool's content param has been the bottleneck more than once",
      "",
      "When NOT to use:",
      "- Small files (<100KB) — MCP tool path is cleaner and stays consistent",
      "- Cases where you actually need to inspect the content before pushing",
      "",
      "Observed: `/sync` skill on 2026-04-29 with 349KB events.jsonl. TD-056 captures the skill update.",
    ].join('\n'),
    lengths: { at_generation: 1019, now: 971, loser: 1377, synthesized: 383 },
  },
};
