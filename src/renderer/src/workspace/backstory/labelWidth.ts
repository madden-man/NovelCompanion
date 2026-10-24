import { roughLabelWidth } from '../../../../shared/domain/worldGrid';

/**
 * A54: the width a marker's title draws at, measured with a canvas in the font a `.wg-mlabel`
 * computes to, plus a small margin, so the lane it reserves holds the real text. Each title is
 * measured once per font. Without a canvas (a test DOM) it falls back to the rough width.
 */
const MARGIN = 3;
const cache = new Map<string, number>();
let ctx: CanvasRenderingContext2D | null | undefined;

/** The font a marker title draws in, read from a hidden label in the page. */
function labelFont(): string | null {
  if (typeof document === 'undefined' || !document.body) return null;
  const probe = document.createElement('span');
  probe.className = 'wg-mlabel';
  probe.style.visibility = 'hidden';
  probe.textContent = 'M';
  document.body.appendChild(probe);
  const cs = getComputedStyle(probe);
  const font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
  probe.remove();
  return cs.fontSize ? font : null;
}

let font: string | null = null;

export function measureLabel(label: string): number {
  if (ctx === undefined) {
    try {
      ctx = document.createElement('canvas').getContext('2d');
    } catch {
      ctx = null;
    }
  }
  if (!ctx) return roughLabelWidth(label);
  font ??= labelFont();
  if (!font) return roughLabelWidth(label);
  const key = `${font}\n${label}`;
  const known = cache.get(key);
  if (known !== undefined) return known;
  ctx.font = font;
  const w = Math.ceil(ctx.measureText(label).width * 1.02) + MARGIN;
  cache.set(key, w);
  return w;
}
