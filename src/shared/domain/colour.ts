/**
 * A51 (NF-2): colour contrast by the WCAG 2 formula, for the Lists screen's
 * check of a kind colour against the two chart surfaces.
 */

/** `--chart-surface` in the light theme, as in `theme.css`. */
export const CHART_SURFACE_LIGHT = '#fcfcfb';
/** `--chart-surface` in the dark theme, as in `theme.css`. */
export const CHART_SURFACE_DARK = '#1a1a19';

/** The contrast a marker needs against the chart surface (WCAG 1.4.11, non-text). */
export const MIN_MARKER_CONTRAST = 3;

const HEX = /^#([0-9a-f]{6})$/i;

/** The relative luminance of a `#rrggbb` colour, 0 to 1. Throws on anything else. */
export function relativeLuminance(hex: string): number {
  const m = HEX.exec(hex);
  if (!m) throw new Error(`${hex} is not a colour such as #2a78d6.`);
  const n = parseInt(m[1] as string, 16);
  const channel = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return (
    0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255)
  );
}

/** The WCAG contrast ratio of two `#rrggbb` colours, 1 to 21, in either order. */
export function contrastRatio(hexA: string, hexB: string): number {
  const a = relativeLuminance(hexA);
  const b = relativeLuminance(hexB);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}
