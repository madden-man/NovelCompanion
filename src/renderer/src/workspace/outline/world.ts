import { useEffect, useState } from 'react';
import type { Response } from '../../../../shared/ipc';
import { call } from '../../api';
import { useStore } from '../data';

type Chart = Response<'timeline.chart'>;

/** A37: the eras and world events the outline sets its chapters against. */
export interface World {
  eras: Chart['eras'];
  events: Chart['events'];
}

/** The eras and world events of the bible, unfiltered, reloaded after every change. */
export function useWorld(): World | null {
  const { version } = useStore();
  const [world, setWorld] = useState<World | null>(null);
  useEffect(() => {
    let live = true;
    void call('timeline.chart', { filters: {} })
      .then((r) => {
        if (live) setWorld({ eras: r.eras, events: r.events });
      })
      .catch(() => {
        // The outline reads fine without the world around it.
      });
    return () => {
      live = false;
    };
  }, [version]);
  return world;
}
