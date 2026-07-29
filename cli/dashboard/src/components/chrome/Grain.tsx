/**
 * PORTED from fifty_dev's `<Grain />` chrome component. BRAND_RULES #4 — grain
 * overlay on all pages.
 *
 * The texture is an SVG-turbulence data-URI in `.grain` (base.css), NOT a
 * raster asset: zero extra tarball bytes and zero extra requests, which is what
 * lets AC #4 hold without a weight cost.
 */
export function Grain() {
  return <div className="grain" aria-hidden />;
}
