/**
 * Handlers for the alignment check channels (M8, CC-1 to CC-4). Independent
 * of Electron, so the integration suite drives the same code through the
 * same zod contract. The Claude half is `claude.alignment` in
 * src/main/claude/handlers.ts.
 */
import type { Channel } from '../../shared/ipc';
import type { OpenBible } from '../db/session';
import { checkStructure, listFindings, resolveFinding } from '../continuity';
import type { Handler } from './validate';

export type ContinuityChannel = 'continuity.check' | 'continuity.findings' | 'continuity.resolve';

export function continuityHandlers(current: () => OpenBible | null): {
  [C in ContinuityChannel]: Handler<C & Channel>;
} {
  const session = () => {
    const s = current();
    if (!s) throw new Error('Open a bible first.');
    return s;
  };
  return {
    'continuity.check': ({ chapterId }) => checkStructure(session(), chapterId),
    'continuity.findings': ({ chapterId, states }) => listFindings(session(), chapterId, states),
    'continuity.resolve': ({ id, action }) => resolveFinding(session(), id, action),
  };
}
