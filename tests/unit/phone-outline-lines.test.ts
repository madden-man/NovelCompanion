import { describe, expect, it } from 'vitest';
import { LEAD, section } from '../../src/shared/domain/sceneOutline';
import type { Flow } from '../../src/shared/domain/sceneOutline';
import {
  blockLength,
  deleteLine,
  indentLine,
  insertLine,
  moveLines,
  setLineBody,
  splitLine,
  splitLineAt,
  stepLine,
} from '../../src/renderer/src/workspace/outline/phoneLines';

/** A58 U2 (PH-35): the phone outline's line actions, each by tap, in page order. */
const flow = (): Flow => ({
  lead: section(),
  bodies: {
    C1: section(['- Arrival', '  - the dock', '- Letter'], { 0: 1850, 2: 1851 }),
    C2: section(['- Storm'], { 0: 1860 }),
    C3: section([]),
  },
});
const keys = ['C1', 'C2', 'C3'];
const lines = (f: Flow, k: string) => (k === LEAD ? f.lead : f.bodies[k])?.lines;

describe('phone outline lines (PH-35)', () => {
  it('splits a line into its bullet and its words', () => {
    expect(splitLine('  - the dock')).toEqual({ prefix: '  - ', body: 'the dock' });
    expect(splitLine('Heading')).toEqual({ prefix: '', body: 'Heading' });
    expect(splitLine('-')).toEqual({ prefix: '-', body: '' });
  });

  it('edits the words and keeps the bullet and the year', () => {
    const f = setLineBody(flow(), { key: 'C1', line: 0 }, 'Arrival at night');
    expect(lines(f, 'C1')?.[0]).toBe('- Arrival at night');
    expect(f.bodies.C1?.years[0]).toBe(1850);
  });

  it('splits a line at the caret, with the same bullet under it', () => {
    const f = splitLineAt(flow(), { key: 'C1', line: 1 }, 4);
    expect(lines(f, 'C1')).toEqual(['- Arrival', '  - the ', '  - dock', '- Letter']);
    expect(f.bodies.C1?.years).toEqual({ 0: 1850, 3: 1851 });
  });

  it('puts a line in and takes one out, years moving with their lines', () => {
    const added = insertLine(flow(), { key: 'C1', line: 0 }, '- Prologue');
    expect(lines(added, 'C1')?.[0]).toBe('- Prologue');
    expect(added.bodies.C1?.years).toEqual({ 1: 1850, 3: 1851 });
    const gone = deleteLine(flow(), { key: 'C1', line: 0 });
    expect(lines(gone, 'C1')).toEqual(['  - the dock', '- Letter']);
    expect(gone.bodies.C1?.years).toEqual({ 1: 1851 });
  });

  it('indents no deeper than one level past the line above, across chapters too', () => {
    const f = indentLine(flow(), keys, { key: 'C2', line: 0 }, false);
    expect(lines(f as Flow, 'C2')).toEqual(['  - Storm']);
    expect(indentLine(f as Flow, keys, { key: 'C2', line: 0 }, false)).toBeNull();
    const back = indentLine(f as Flow, keys, { key: 'C2', line: 0 }, true);
    expect(lines(back as Flow, 'C2')).toEqual(['- Storm']);
    expect(indentLine(flow(), keys, { key: 'C1', line: 0 }, false)).toBeNull();
  });

  it('moves a scene with the lines under it', () => {
    expect(blockLength(lines(flow(), 'C1') as string[], 0)).toBe(2);
    const down = stepLine(flow(), keys, { key: 'C1', line: 0 }, 1);
    expect(lines(down!.flow, 'C1')).toEqual(['- Letter', '- Arrival', '  - the dock']);
    expect(down!.at).toEqual({ key: 'C1', line: 1 });
    expect(down!.flow.bodies.C1?.years).toEqual({ 0: 1851, 1: 1850 });
    const up = stepLine(down!.flow, keys, down!.at, -1);
    expect(lines(up!.flow, 'C1')).toEqual(lines(flow(), 'C1'));
  });

  it('crosses into the chapter above or below at a chapter edge, and stops at the ends', () => {
    const into = stepLine(flow(), keys, { key: 'C1', line: 2 }, 1);
    expect(lines(into!.flow, 'C1')).toEqual(['- Arrival', '  - the dock']);
    expect(lines(into!.flow, 'C2')).toEqual(['- Letter', '- Storm']);
    expect(into!.at).toEqual({ key: 'C2', line: 0 });
    expect(into!.flow.bodies.C2?.years).toEqual({ 0: 1851, 1: 1860 });
    const back = stepLine(flow(), keys, { key: 'C2', line: 0 }, -1);
    expect(lines(back!.flow, 'C1')).toEqual(['- Arrival', '  - the dock', '- Letter', '- Storm']);
    expect(back!.at).toEqual({ key: 'C1', line: 3 });
    expect(stepLine(flow(), keys, { key: 'C1', line: 0 }, -1)).toBeNull();
    const last = stepLine(flow(), keys, { key: 'C2', line: 0 }, 1);
    expect(lines(last!.flow, 'C3')).toEqual(['- Storm']);
    expect(stepLine(last!.flow, keys, last!.at, 1)).toBeNull();
  });

  it('drops lines anywhere, and a drop onto itself changes nothing', () => {
    const f = moveLines(flow(), { key: 'C1', line: 0 }, 2, { key: 'C3', line: 0 });
    expect(lines(f!, 'C1')).toEqual(['- Letter']);
    expect(lines(f!, 'C3')).toEqual(['- Arrival', '  - the dock']);
    expect(f!.bodies.C3?.years).toEqual({ 0: 1850 });
    expect(moveLines(flow(), { key: 'C1', line: 0 }, 2, { key: 'C1', line: 1 })).toBeNull();
    expect(moveLines(flow(), { key: 'C1', line: 0 }, 2, { key: 'C1', line: 2 })).toBeNull();
    const end = moveLines(flow(), { key: 'C1', line: 0 }, 1, { key: 'C1', line: 3 });
    expect(lines(end!, 'C1')).toEqual(['  - the dock', '- Letter', '- Arrival']);
  });
});
