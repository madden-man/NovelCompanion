import { initial } from './001-initial';
import type { Migration } from './types';

export type { Migration } from './types';

/** Every migration, in order. Add new ones at the end with the next version number. */
export const migrations: readonly Migration[] = [initial];

export const LATEST_SCHEMA_VERSION = migrations.length;
