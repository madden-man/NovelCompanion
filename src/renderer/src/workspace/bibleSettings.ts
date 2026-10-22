import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_BIBLE_SETTINGS } from '../../../shared/schema/settings';
import type { BibleSettings } from '../../../shared/schema/settings';
import { call } from '../api';
import { defaultStatus } from '../../../shared/domain/lists';
import type { StatusKind } from '../../../shared/schema/lists';
import { useStore } from './data';

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

/**
 * A47 (IP-9): the status a new entry of a kind is written with: the first
 * status item of that kind in the open bible (`defaultStatus`).
 */
export function useDefaultStatus(): (kind: StatusKind) => string {
  const { lists } = useStore();
  return useCallback((kind: StatusKind) => defaultStatus(lists, kind), [lists]);
}
