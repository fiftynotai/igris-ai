/** PORTED VERBATIM from fifty_dev/src/components/ui/Badge.tsx (only the `cn` import path differs). */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

type BadgeVariant = "default" | "muted" | "live" | "alarm";

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
        className,
      )}
      {...props}
    />
  );
});
