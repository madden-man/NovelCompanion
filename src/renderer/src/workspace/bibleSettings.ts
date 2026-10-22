import { useEffect, useState } from 'react';
import { DEFAULT_BIBLE_SETTINGS } from '../../../shared/schema/settings';
import type { BibleSettings } from '../../../shared/schema/settings';
import { call } from '../api';

/**
 * A47 (IP-10, IP-11, IP-14): the open bible's settings, the defaults until
 * they arrive, kept fresh when they change. The numbers, the culture unit
 * and the templates every screen reads.
 */
export function useBibleSettings(): BibleSettings {
  const [settings, setSettings] = useState<BibleSettings>(DEFAULT_BIBLE_SETTINGS);
  useEffect(() => {
    let live = true;
    const load = () =>
      void call('settings.get', {})
        .then((s) => live && setSettings(s))
        .catch(() => undefined);
    load();
    const offs = [
      window.api.on('settings.changed', load),
      window.api.on('bible.reloaded', load),
      window.api.on('bibles.changed', load),
    ];
    return () => {
      live = false;
      for (const off of offs) off();
    };
  }, []);
  return settings;
}
