/**
 * Capture routing (A48, CR-1 to CR-5): the pure router. Build the index once
 * per capture with `buildIndex`, then `routeCapture` splits the text into
 * facts and gives each its section, community, years, drafts and route. No
 * Electron, MongoDB or React (ARCHITECTURE rule 1).
 */
export * from './types';
export { LEXICON } from './lexicon';
export type { Adjustment, CommunityWords, Cue, CueSignal, DiasporaRule, Lexicon } from './lexicon';
export { buildIndex, characterAliases } from './buildIndex';
export {
  YEAR_SOURCES,
  parse,
  parseSentence,
  parseYears,
  quotedWords,
  splitSentences,
} from './parse';
export type { OwnYears, ParsedSentence } from './parse';
export { WRITING_STRAND, candidatesOf, pickCommunity, resolve } from './resolve';
export type { CommunityChoice, Match, Resolved } from './resolve';
export { rank, score, signals } from './score';
export type { Scored } from './score';
export {
  ASKABLE,
  REQUIRED,
  draftsFor,
  firstCommunity,
  momentSubjects,
  leadingUnknown,
  secondClause,
  singleCategory,
  titleFrom,
} from './drafts';
export type { DraftContext, DraftResult } from './drafts';
export { decide, routeCapture, routeFact } from './route';
export type { DecideInput } from './route';
