export { DATABASE_NAME, connect } from './connection';
export type { Store } from './connection';
export {
  BibleError,
  REGISTRY,
  assertBibleSlug,
  createBible,
  dropBible,
  listBibles,
  migrate,
  openBible,
  schemaVersion,
} from './bibles';
export type { BibleHandle, BibleRecord } from './bibles';
export { Repository, RepositoryError, ValidationError } from './repository';
export type { ChangeEvent, ChangeOp } from './repository';
