import { initial } from './001-initial';
import { allEntities } from './002-all-entities';
import { eraDefaults } from './003-era-defaults';
import { beatArcOrders } from './004-beat-arc-orders';
import { themeAppearances } from './005-theme-appearances';
import { importSources } from './006-import-sources';
import { conversations } from './007-conversations';
import { findingKeys } from './008-finding-keys';
import { simplifiedModel } from './009-simplified-model';
import { markdownText } from './010-markdown-text';
import { vocabulary } from './011-vocabulary';
import { momentKinds } from './012-moment-kinds';
import type { Migration } from './types';

export type { Migration } from './types';

/** Every migration, in order. Add new ones at the end with the next version number. */
export const migrations: readonly Migration[] = [
  initial,
  allEntities,
  eraDefaults,
  beatArcOrders,
  themeAppearances,
  importSources,
  conversations,
  findingKeys,
  simplifiedModel,
  markdownText,
  vocabulary,
  momentKinds,
];

export const LATEST_SCHEMA_VERSION = migrations.length;
