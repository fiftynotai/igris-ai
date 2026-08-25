/**
 * PORTED from fifty_dev/src/components/ui/Badge.tsx.
 *
 * ONE DIVERGENCE, recorded in PORTING.md as D16: the `warn` variant is NEW
 * (FR-266). The three ported variants are byte-aligned with upstream and the
 * only other change is the `cn` import path.
 *
 * WHY A FOURTH VARIANT RATHER THAN REUSING `default`: the diagnostics panel
 * needs four distinguishable status tones, and `default` paints
 * `background: var(--accent)` — which on the `blood` palette reads as red. An
 * ATTENTION badge would then look like an ALARM one, so AC-4's "a failing
 * instance is visually distinct" would hold on some palettes and not others.
 */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

type BadgeVariant = "default" | "muted" | "live" | "alarm" | "warn";

export type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  variant?: BadgeVariant;
};

export const Badge = forwardRef<HTMLSpanElement, BadgeProps>(function Badge(
  { variant = "default", className, ...props },
  ref,
) {
  return (
    <span
      ref={ref}
      className={cn(
        "badge",
        variant === "muted" && "badge-muted",
        variant === "live" && "badge-live",
        variant === "alarm" && "badge-alarm",
        variant === "warn" && "badge-warn",
        className,
      )}
      {...props}
    />
  );
});
