/**
 * FR-239 — the canvas container.
 *
 * EXEMPTION 01, and its obligation. dataviz.md exempts a data-viz surface from
 * *"background grid is 24px, nodes snap to it"* — positions come from a layout
 * algorithm, and snapping thousands of nodes to a lattice produces collisions,
 * not order. **The obligation is that the grid stays**, as background texture
 * at the GRID role token: *"A canvas on a blank field is off-brand."*
 *
 * It is a CSS background on this element rather than something the renderer
 * paints per frame, and that is a real decision with two consequences worth
 * stating:
 *
 *  1. It stays palette-reactive for free. `--dataviz-grid` dereferences
 *     `var(--line)`, so a `data-palette` swap moves the texture with everything
 *     else and no code runs.
 *  2. It cannot pollute the AC-#5 capture. The probe reads the CANVAS backing
 *     store; the grid lives on the div behind it. force-graph's canvas is
 *     configured transparent (`instance.ts`) so the texture shows through.
 */

import { forwardRef } from "react";

export interface GraphSurfaceProps {
  /** Announced to assistive tech — the canvas itself carries no semantics. */
  label: string;
  children?: React.ReactNode;
}

export const GraphSurface = forwardRef<HTMLDivElement, GraphSurfaceProps>(
  function GraphSurface({ label, children }, ref) {
    return (
      <div className="graph-surface">
        {/*
          The canvas is the interactive element at Tier C (dataviz §04), which
          is what satisfies the 44x44 tap-target rule at this density. Node
          selection inside it is MEDIATED by the pointer-capture radius painted
          in `shapes.ts` — never by the node's own 8 px silhouette.
        */}
        <div
          ref={ref}
          className="graph-canvas-host"
          role="application"
          aria-label={label}
          tabIndex={0}
        />
        {children}
      </div>
    );
  },
);
