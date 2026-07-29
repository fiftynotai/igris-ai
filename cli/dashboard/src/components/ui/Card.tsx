/** PORTED VERBATIM from fifty_dev/src/components/ui/Card.tsx (only the `cn` import path differs). */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

export type CardProps = React.HTMLAttributes<HTMLDivElement>;

export const Card = forwardRef<HTMLDivElement, CardProps>(function Card(
  { className, ...props },
  ref,
) {
  return <div ref={ref} className={cn("card", className)} {...props} />;
});

export const CardEye = forwardRef<
  HTMLSpanElement,
  React.HTMLAttributes<HTMLSpanElement>
>(function CardEye({ className, ...props }, ref) {
  return <span ref={ref} className={cn("card-eye", className)} {...props} />;
});

export const CardTitle = forwardRef<
  HTMLHeadingElement,
  React.HTMLAttributes<HTMLHeadingElement>
>(function CardTitle({ className, ...props }, ref) {
  return <h3 ref={ref} className={cn("card-title", className)} {...props} />;
});

export const CardBody = forwardRef<
  HTMLParagraphElement,
  React.HTMLAttributes<HTMLParagraphElement>
>(function CardBody({ className, ...props }, ref) {
  return <p ref={ref} className={cn("card-body", className)} {...props} />;
});

export const CardFooter = forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(function CardFooter({ className, ...props }, ref) {
  return <div ref={ref} className={cn("card-footer", className)} {...props} />;
});
