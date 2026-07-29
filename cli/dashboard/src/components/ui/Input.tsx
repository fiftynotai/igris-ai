/** PORTED VERBATIM from fifty_dev/src/components/ui/Input.tsx (only the `cn` import path differs). */
import { forwardRef, useId } from "react";
import { cn } from "../../lib/cn";

export type InputProps = React.InputHTMLAttributes<HTMLInputElement> & {
  label?: string;
  help?: string;
  invalid?: boolean;
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { label, help, invalid, className, id, ...props },
  ref,
) {
  const reactId = useId();
  const inputId = id ?? reactId;
  return (
    <div className={cn("field", invalid && "invalid")}>
      {label && (
        <label htmlFor={inputId} className="field-label">
          {label}
        </label>
      )}
      <input
        ref={ref}
        id={inputId}
        className={cn("input", className)}
        aria-invalid={invalid || undefined}
        {...props}
      />
      {help && <span className="field-help">{help}</span>}
    </div>
  );
});
