import { useCallback } from 'react';
import { useList } from '../data';

/** A status value in the words of the statuses list, such as "Planned" for `planned`. */
export function useStatusLabel(): (status: string) => string {
  const statuses = useList('statuses');
  return useCallback(
    (status: string) => statuses?.items.find((s) => s.id === status)?.label ?? status,
    [statuses],
  );
}
