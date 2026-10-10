/**
 * FT-9 export helpers: a standalone copy of the tree's SVG with every style
 * written inline (so it draws the same outside the app), and a PNG made by
 * drawing that SVG on a canvas.
 */
const STYLE_PROPS = [
  'fill',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-dasharray',
  'stroke-opacity',
  'opacity',
  'font-family',
  'font-size',
  'font-weight',
  'text-anchor',
  'dominant-baseline',
];

export function standaloneSvg(
  svg: SVGSVGElement,
  box: { x: number; y: number; width: number; height: number },
  background: string,
): string {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  const src = [svg, ...svg.querySelectorAll('*')];
  const dst = [clone, ...clone.querySelectorAll('*')];
  src.forEach((el, i) => {
    const target = dst[i] as SVGElement | undefined;
    if (!target) return;
    const cs = getComputedStyle(el);
    const style = STYLE_PROPS.map((p) => `${p}:${cs.getPropertyValue(p)}`).join(';');
    target.setAttribute('style', style);
    target.removeAttribute('class');
    target.removeAttribute('tabindex');
  });
  clone.querySelectorAll('[data-export="skip"]').forEach((n) => n.remove());
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('viewBox', `${box.x} ${box.y} ${box.width} ${box.height}`);
  clone.setAttribute('width', String(box.width));
  clone.setAttribute('height', String(box.height));
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(box.x));
  bg.setAttribute('y', String(box.y));
  bg.setAttribute('width', String(box.width));
  bg.setAttribute('height', String(box.height));
  bg.setAttribute('style', `fill:${background}`);
  clone.insertBefore(bg, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

/** Draw standalone SVG markup on a canvas and return a PNG data URL. */
export async function rasterize(markup: string, width: number, height: number, scale = 2) {
  const img = new Image();
  img.decoding = 'sync';
  const loaded = new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error('The tree could not be drawn as an image.'));
  });
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`;
  await loaded;
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('The tree could not be drawn as an image.');
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return canvas.toDataURL('image/png');
}
