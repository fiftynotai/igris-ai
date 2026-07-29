/** PORTED VERBATIM from fifty_dev/src/components/ui/Button.tsx (only the `cn` import path differs). */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

type Variant = "primary" | "secondary" | "ghost";
type Size = "sm" | "md" | "lg";

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: Size;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    { variant = "secondary", size = "md", className, type, ...props },
    ref,
  ) {
    return (
      <button
        ref={ref}
        type={type ?? "button"}
        className={cn(
          "btn",
          variant === "primary" && "btn-primary",
          variant === "secondary" && "btn-secondary",
          variant === "ghost" && "btn-ghost",
          size === "sm" && "btn-sm",
          size === "lg" && "btn-lg",
          className,
        )}
        {...props}
      />
    );
  },
);
