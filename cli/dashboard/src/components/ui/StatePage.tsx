/**
 * PORTED from fifty_dev/src/components/ui/StatePage.tsx.
 *
 * The plan (Phase 3.3) requires porting StatePage rather than inventing a
 * different empty-state shape, because `EmptyState` wraps it upstream.
 *
 * TWO DIVERGENCES, both recorded in PORTING.md:
 *  1. `next/link` -> a plain `<a>`. There is no Next router here, and the CTA
 *     always points at an in-app hash route or an external doc.
 *  2. NEW `inset` prop. Upstream StatePage is a full-page `<section>` with a
 *     100vh floor. The dashboard renders these INSIDE a routed panel, so
 *     `inset` swaps in the `[data-inset="true"]` CSS block (a shorter floor and
 *     a hairline border) instead of pretending a panel is a page.
 */
import { forwardRef } from "react";
import { cn } from "../../lib/cn";

export type StatePageVariant = "404" | "loading" | "empty" | "offline" | "error";

type StatePageCTA = { label: string; href: string };

export type StatePageProps = Omit<
  React.HTMLAttributes<HTMLElement>,
  "children"
> & {
  variant: StatePageVariant;
  /** Headline. Required. ReactNode so `<em>` accents work inline. */
  headline: React.ReactNode;
  /** Italic context line. Required. ReactNode for inline emphasis. */
  message: React.ReactNode;
  /** Optional CTA. `loading` variant ignores this prop (loading has no exit). */
  cta?: StatePageCTA;
  /** Mono meta footer line. Required. */
  meta: string;
  /** FR-238 addition — render at panel scale rather than page scale. */
  inset?: boolean;
};

const VARIANT_DEFAULTS: Record<StatePageVariant, { scanline: boolean }> = {
  "404": { scanline: true },
  loading: { scanline: true },
  empty: { scanline: false },
  offline: { scanline: true },
  error: { scanline: true },
};

export const StatePage = forwardRef<HTMLElement, StatePageProps>(
  function StatePage(
    { variant, headline, message, cta, meta, inset, className, ...props },
    ref,
  ) {
    const defaults = VARIANT_DEFAULTS[variant];
    const showCta = cta && variant !== "loading";

    return (
      <section
        ref={ref}
        className={cn("state-page", className)}
        data-variant={variant}
        data-inset={inset ? "true" : undefined}
        {...props}
      >
        {variant === "loading" && (
          <span className="state-page-spinner" aria-hidden />
        )}

        <h1 className="state-page-headline">{headline}</h1>

        <p className="state-page-message">{message}</p>

        {showCta && (
          <a href={cta.href} className="state-page-cta" data-cursor="hover">
            {cta.label}
          </a>
        )}

        <span className="state-page-meta">{meta}</span>

        {defaults.scanline && (
          <span className="state-page-scanline" aria-hidden />
        )}
      </section>
    );
  },
);
