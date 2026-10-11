import type { BibleHandle } from '../bibles';
import type { Migration } from './types';

type Chapter = { _id: string; themeIds?: string[] };
type Theme = { _id: string; appearances?: { chapterId: string; note: string }[] };

/**
 * A theme's appearances are the one place a chapter-theme link is stored
 * (TH-1). Every theme a chapter listed becomes an appearance with an empty
 * note unless the theme already has one, then the chapter's own list is dropped.
 */
export const themeAppearances: Migration = {
  version: 5,
  name: 'chapter themes live in theme appearances',
  async up(bible: BibleHandle) {
    const chapters = bible.collection<Chapter>('chapters');
    const themes = bible.collection<Theme>('themes');
    for (const c of await chapters.find({ themeIds: { $exists: true } }).toArray()) {
      for (const themeId of c.themeIds ?? []) {
        const theme = await themes.findOne({ _id: themeId });
        if (!theme) continue;
        const appearances = theme.appearances ?? [];
        if (appearances.some((a) => a.chapterId === c._id)) continue;
        await themes.updateOne(
          { _id: themeId },
          { $set: { appearances: [...appearances, { chapterId: c._id, note: '' }] } },
        );
      }
      await chapters.updateOne({ _id: c._id }, { $unset: { themeIds: '' } });
    }
  },
};
