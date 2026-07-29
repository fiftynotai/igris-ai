/**
 * PORTED VERBATIM from fifty_dev/src/components/ui/StatusPill.tsx (only the
 * `cn` import path differs).
 *
 * Status colours are semantic and deliberately do NOT swap with
 * `data-palette` — LIVE is green in every palette. That is upstream's rule
 * (FR-110c) and it is preserved here, so a "palette switching must work across
 * all components" review must not read these five as a miss.
 */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

export type StatusPillState =
  | "in-lab"
  | "wip"
  | "coming-soon"
  | "live"
  | "dormant";

export type StatusPillProps = React.HTMLAttributes<HTMLSpanElement> & {
  state: StatusPillState;
  /** Optional override for the visible text. Defaults to the brand-spec label per state. */
  label?: string;
};

const DEFAULT_LABELS: Record<StatusPillState, string> = {
  "in-lab": "IN LAB",
  wip: "WIP",
  "coming-soon": "SOON",
  live: "LIVE",
  dormant: "DORMANT",
};

export const StatusPill = forwardRef<HTMLSpanElement, StatusPillProps>(
  function StatusPill({ state, label, className, children, ...props }, ref) {
    return (
      <span
        ref={ref}
        className={cn("status-pill", `status-pill-${state}`, className)}
        {...props}
      >
        {children ?? label ?? DEFAULT_LABELS[state]}
      </span>
    );
  },
);
