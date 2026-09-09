/**
 * FR-238 — the four-palette switcher.
 *
 * BRAND_RULES #6: palette switching must work across all components. It does,
 * structurally: every ported rule reads `--bg / --fg / --accent / --line /
 * --muted`, and this control only ever changes `body[data-palette]`. There is
 * no per-component palette code to forget.
 *
 * Uses the `tweak` Chip variant — the sharp-cornered one upstream uses inside
 * its own TweaksPanel radiogroup — so the control reads as fifty.dev chrome
 * rather than as a generic segmented button.
 */
import { Chip } from "../ui/Chip";
import { PALETTES, type Palette } from "../../lib/usePalette";

export interface PaletteSwitcherProps {
  palette: Palette;
  onChange: (next: Palette) => void;
}

export function PaletteSwitcher({ palette, onChange }: PaletteSwitcherProps) {
  return (
    <div
      className="tweaks-chips"
      role="radiogroup"
      aria-label="Colour palette"
    >
      {PALETTES.map((p) => (
        <Chip
          key={p}
          variant="tweak"
          role="radio"
          active={p === palette}
          onClick={() => onChange(p)}
          title={`${p} palette`}
        >
          {p}
        </Chip>
      ))}
    </div>
  );
}
