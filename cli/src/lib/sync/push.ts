/**
 * `igris sync push [--dry-run]` (TD-350): push the local brain delta to
 * `remote_brain`. Reads url + api_key from config itself and takes NO key
 * argument; the key lives only in this process's memory. Dispatches the
 * vendored `igris_brain_push` handler in process (the FR-241 write bridge), so
 * the BR-097 stamp rule and the delta SQL stay in the brain. Exit 0 only on the
 * handler's success or "No changes" headline; a partial push (held tables) is 1.
 * It boots that engine on the LIVE local brain (`brainDbPath()`), as the stdio
 * MCP and the dashboard write door do: the same bundle, but any migration that
 * bundle carries applies on this boot (TD-350 risk R2); `schedules` stays off.
 */

import { readRemoteBrainConfig } from "../mcp-client.js";
import { assertSyncTransportAllowed } from "../sync-transport.js";
import { DryRunCollector } from "../dry-run.js";
import { brainDbPath } from "../paths.js";
import { bootWriteEngine, shutdownWriteEngine } from "../brain-write-bridge.js";
import { EGRESS_DISCLOSURE_LINES } from "./egress-manifest.generated.js";
import { info, error as logError } from "../log.js";

export async function runSyncPush(opts: { dryRun?: boolean } = {}): Promise<number> {
  const remote = readRemoteBrainConfig();
  if (remote === null) {
    logError("remote_brain config not found in ~/.igris/config.json. Add a 'remote_brain' block with url + api_key.");
    return 1;
  }
  const gate = assertSyncTransportAllowed(remote.url);
  if (!gate.ok) {
    logError(gate.reason);
    return 1;
  }
  if (opts.dryRun === true) {
    for (const line of EGRESS_DISCLOSURE_LINES) info(line);
    const dry = new DryRunCollector();
    dry.wouldFetchUrl(`${remote.url.replace(/\/+$/, "")}/sync/push`);
    dry.print();
    info(`sync push (dry-run): would send rows newer than sync_state.last_push_at (every row for a table with no stamp) from ${brainDbPath()}`);
    return 0;
  }
  // A remote's 4xx body reaches the handler text verbatim; never echo the key.
  const safe = (t: string): string => t.split(remote.apiKey).join("[redacted]");
  const booted = await bootWriteEngine();
  if (!booted.ok) {
    logError(`sync push: ${booted.reason}`);
    return 1;
  }
  try {
    const res = await booted.engine.gateway.dispatch("igris_brain_push", {
      remote_url: remote.url,
      api_key: remote.apiKey,
    });
    const text = res.content?.[0]?.text ?? "";
    const ok = res.isError !== true && /^(Brain push completed successfully\.|No changes to push\.)/.test(text);
    (ok ? info : logError)(safe(text));
    return ok ? 0 : 1;
  } catch (err) {
    logError(safe(`sync push: ${err instanceof Error ? err.message : String(err)}`));
    return 1;
  } finally {
    shutdownWriteEngine();
  }
}
