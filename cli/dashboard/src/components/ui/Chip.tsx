/**
 * PORTED from fifty_dev/src/components/ui/Chip.tsx.
 *
 * DIVERGENCE: the `filter` variant (upstream `.out-pill`, the Gallery filter
 * strip) is dropped — it has no consumer here and its CSS is not ported. The
 * `pill` and `tweak` variants are byte-aligned with upstream. Recorded in
 * PORTING.md.
 */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

type ChipVariant = "pill" | "tweak";
type ChipRole = "radio" | "button";

export type ChipProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  active?: boolean;
  variant?: ChipVariant;
  role?: ChipRole;
};

export const Chip = forwardRef<HTMLButtonElement, ChipProps>(function Chip(
  { active, className, type, variant = "pill", role = "button", ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type ?? "button"}
      role={role}
      aria-pressed={role === "button" ? active : undefined}
      aria-checked={role === "radio" ? active : undefined}
      className={cn(
        variant === "pill" && "chip",
        variant === "tweak" && "tweaks-chip",
        active && "on",
        className,
      )}
      {...props}
    />
  );
});
