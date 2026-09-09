/**
 * PORTED from fifty_dev/src/components/ui/EmptyState.tsx — a thin wrapper over
 * `<StatePage variant="empty">` carrying the brand-canonical defaults.
 *
 * DIVERGENCES (PORTING.md): the default CTA is dropped (there is no "RETURN
 * HOME" in a single-page lens — the shell nav is always visible), and `inset`
 * defaults to true since every consumer here renders inside a routed panel.
 * The headline/message defaults are upstream's, verbatim.
 */
import { forwardRef } from "react";
import { StatePage, type StatePageProps } from "./StatePage";

export type EmptyStateProps = Partial<
  Omit<StatePageProps, "variant" | "meta">
> & {
  meta: string;
};

const DEFAULT_HEADLINE = (
  <>
    <em>nothing here yet.</em>
  </>
);

const DEFAULT_MESSAGE =
  "You're early. The first entry lands when the work does.";

export const EmptyState = forwardRef<HTMLElement, EmptyStateProps>(
  function EmptyState({ headline, message, meta, inset, ...props }, ref) {
    return (
      <StatePage
        ref={ref}
        variant="empty"
        headline={headline ?? DEFAULT_HEADLINE}
        message={message ?? DEFAULT_MESSAGE}
        meta={meta}
        inset={inset ?? true}
        {...props}
      />
    );
  },
);
