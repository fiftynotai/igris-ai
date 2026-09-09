/**
 * FR-238 — the live-data indicator.
 *
 * `docs/brand/dataviz.md` permits `// LOOP` motion in CHROME (a live dot, a
 * ticker) and forbids it on the canvas. This is the shell's one looping
 * element, and it is deliberately here rather than in the future canvas so
 * FR-239 inherits a compliant home for it.
 *
 * The timestamp is mono, per the 3-tier rule: every counter, id and timestamp
 * in this shell is JetBrains Mono.
 */
import type { Live } from "../../lib/useLive";

function clock(d: Date): string {
  return d.toTimeString().slice(0, 8);
}

const LABELS: Record<Live["state"], string> = {
  live: "LIVE",
  degraded: "DEGRADED",
  offline: "OFFLINE",
  connecting: "CONNECTING",
};

export function LiveIndicator({ live }: { live: Live }) {
  const suffix =
    live.state === "offline"
      ? "server unreachable"
      : live.lastRefresh
        ? clock(live.lastRefresh)
        : "—";

  return (
    <span
      className="shell-live"
      data-state={live.state === "connecting" ? "degraded" : live.state}
      title={live.error ?? live.health?.degraded?.reason ?? "brain reachable"}
    >
      {LABELS[live.state]} · {suffix}
    </span>
  );
}
