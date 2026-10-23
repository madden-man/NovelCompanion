import type { CSSProperties } from 'react';
import { kindColorCss } from '../../../../shared/domain/lists';
import type { BackstoryKind } from '../../../../shared/domain/backstoryGrid';

/**
 * A51: the colour a marker draws in, through `--bs-kind`: the kind's colour, `--fg-2` for a
 * kind with no colour (Voice), and nothing for no kind, so the CSS falls back to the ink.
 */
export function kindStyle(kind: BackstoryKind | undefined): CSSProperties | undefined {
  if (!kind) return undefined;
  return { ['--bs-kind' as string]: kindColorCss(kind) ?? 'var(--fg-2)' } as CSSProperties;
}

/** A51: a kind's swatch, its colour beside the text that names it (the text never takes it). */
export function KindSwatch(props: { kind: BackstoryKind | undefined; className?: string }) {
  return (
    <span
      className={`bs-kind-sw${props.className ? ` ${props.className}` : ''}`}
      style={kindStyle(props.kind)}
      aria-hidden="true"
    />
  );
}
