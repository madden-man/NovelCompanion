import type { Channel } from './ipc';

/**
 * A58 (PH-3): where each channel of the contract works. `phone` channels are
 * served by the hosted function as well as by the desktop; `desk` channels only
 * by the desktop, and the function refuses them in plain words (PH-4). A new
 * channel is not done until it is marked here: the `satisfies` below fails the
 * build on a missing or unknown channel, and tests/unit/ipc-phone.test.ts walks
 * the contract at run time.
 */
export type Reach = 'phone' | 'desk';

export const CHANNEL_REACH = {
  'app.ping': 'phone',
  // The function has no system browser; the phone opens a link itself.
  'app.openExternal': 'desk',
  // Electron's close flow (`app.closeRequested`); the phone flushes on hide instead (PH-13).
  'app.flushed': 'desk',
  'bible.list': 'phone',
  'bible.create': 'desk',
  'bible.open': 'phone',
  'bible.current': 'phone',
  'entry.list': 'phone',
  'entry.get': 'phone',
  'entry.create': 'phone',
  'entry.createMany': 'phone',
  'entry.update': 'phone',
  'entry.delete': 'phone',
  'entry.restore': 'phone',
  'entry.lookup': 'phone',
  'entry.purge': 'phone',
  'trash.list': 'phone',
  'trash.empty': 'phone',
  'lists.get': 'phone',
  'lists.rename': 'phone',
  'lists.addItem': 'phone',
  'lists.removeItem': 'phone',
  'lists.move': 'phone',
  'lists.setParent': 'phone',
  'lists.setItem': 'phone',
  'search.query': 'phone',
  // The review queue of proposals is Claude's, so it stays on the desk (PH-26).
  'proposal.list': 'desk',
  'proposal.diff': 'desk',
  'proposal.approve': 'desk',
  'proposal.edit': 'desk',
  'proposal.reject': 'desk',
  'proposal.refresh': 'desk',
  // Never registered on the server at all (PH-3).
  'test.propose': 'desk',
  'test.seed': 'desk',
  'tree.get': 'phone',
  'tree.savePositions': 'phone',
  'tree.lineage': 'phone',
  'tree.export': 'desk',
  'character.page': 'phone',
  'storyTime.get': 'phone',
  'storyTime.set': 'phone',
  'storyTime.anchorAge': 'phone',
  'storyTime.promotePreview': 'phone',
  'storyTime.promote': 'phone',
  'timeline.year': 'phone',
  'timeline.livedThrough': 'phone',
  'timeline.compare': 'phone',
  'timeline.chart': 'phone',
  'timeline.eraCoverage': 'phone',
  'sceneOutline.get': 'phone',
  'sceneOutline.set': 'phone',
  'sceneOutline.versions': 'phone',
  'sceneOutline.version': 'phone',
  'sceneOutline.restore': 'phone',
  'outline.get': 'phone',
  'outline.newChapter': 'phone',
  'chapter.page': 'phone',
  'plot.reorder': 'phone',
  'culture.entriesFor': 'phone',
  'place.describe': 'phone',
  'romanization.get': 'phone',
  'romanization.set': 'phone',
  'romanization.check': 'phone',
  'community.notes.get': 'phone',
  'community.notes.set': 'phone',
  // Snapshots live in the Mac's data folder; the function keeps its own (PH-23).
  'snapshot.list': 'desk',
  'snapshot.take': 'desk',
  'snapshot.restore': 'desk',
  'snapshot.keep': 'desk',
  'backup.export': 'desk',
  'backup.import': 'desk',
  'connection.status': 'desk',
  'connection.retry': 'desk',
  'connection.openSnapshot': 'desk',
  'mongo.status': 'desk',
  'mongo.test': 'desk',
  'mongo.replace': 'desk',
  'appearance.get': 'phone',
  // The function keeps settings only while an instance lives; the phone follows its own.
  'appearance.set': 'desk',
  'words.lookup': 'phone',
  'notebook.list': 'phone',
  'notebook.get': 'phone',
  'notebook.voice': 'phone',
  'notebook.relevant': 'phone',
  'notebook.offered': 'phone',
  // The bridge runs on the desk only, so its undo steps are the desk's.
  'notebook.claimSteps': 'desk',
  // The From the notebook tray is on the Mac (PH-28).
  'tray.state': 'desk',
  'tray.mark': 'desk',
  'session.relevant': 'phone',
  'brief.settings.get': 'phone',
  'brief.settings.set': 'phone',
  // The Word import.
  'manuscript.sources': 'desk',
  'manuscript.read': 'desk',
  'manuscript.apply': 'desk',
  'manuscript.reimport': 'desk',
  // Claude writes the summary.
  'chapter.summarize': 'desk',
  'claude.status': 'desk',
  'claude.setKey': 'desk',
  'claude.clearKey': 'desk',
  'claude.models': 'desk',
  'claude.setModel': 'desk',
  'claude.acknowledge': 'desk',
  'claude.ask': 'desk',
  'claude.stop': 'desk',
  'claude.runs': 'desk',
  'claude.run': 'desk',
  'claude.capture': 'desk',
  'claude.alignment': 'desk',
  'claude.instructions.get': 'desk',
  'claude.instructions.set': 'desk',
  'claude.conversation.rename': 'desk',
  'claude.conversation.clear': 'desk',
  'claude.conversation.delete': 'desk',
  // The alignment check (PH-26).
  'continuity.check': 'desk',
  'continuity.findings': 'desk',
  'continuity.resolve': 'desk',
  'settings.get': 'phone',
  'settings.set': 'phone',
  'eraDefaults.get': 'phone',
  'eraDefaults.set': 'phone',
  // A58 P4: what this client may use (PH-5) and what changed elsewhere (PH-9).
  'app.capabilities': 'phone',
  'bible.changes': 'phone',
  // The phone key lives in the Mac's keychain (PH-15); the function reads its own from the site.
  'phoneKey.status': 'desk',
  'phoneKey.make': 'desk',
  'phoneKey.copy': 'desk',
} as const satisfies Record<Channel, Reach>;

/** Every channel the phone may use, in the contract's marking order. */
export const PHONE_CHANNELS = (Object.keys(CHANNEL_REACH) as Channel[]).filter(
  (c) => CHANNEL_REACH[c] === 'phone',
);

/** Every channel that works only on the desk. */
export const DESK_CHANNELS = (Object.keys(CHANNEL_REACH) as Channel[]).filter(
  (c) => CHANNEL_REACH[c] === 'desk',
);

/** True when the hosted function serves this channel. */
export function isPhoneChannel(channel: string): channel is Channel {
  return Object.hasOwn(CHANNEL_REACH, channel) && CHANNEL_REACH[channel as Channel] === 'phone';
}

/** PH-4: what the function answers on a desk channel. */
export const DESK_ONLY_MESSAGE = 'This works in the desktop app on the Mac.';
