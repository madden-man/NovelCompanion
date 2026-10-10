/**
 * Ages and alive-or-dead (TL-1 to TL-4, CH-4). Plain arithmetic over story
 * dates, never a model. Every screen that shows an age or a state uses these
 * functions: the character page, the tree year control, and later the year
 * view and the story time dialog.
 *
 * - TL-3: with year-only birth data, age in year Y is Y minus the birth year.
 *   For a full date asked about a full birth date, the age is exact.
 * - TL-4: in the year of death a character is alive and flagged as dying that
 *   year. Asked about a full date after a full death date, they are dead.
 * - CH-4: an unknown birth gives "age unknown", never an estimate.
 */
import type { StoryDate } from '../schema/common';
import { compareStoryDates, isKnown, yearOf } from './dates';
import type { KnownDate } from './dates';

export type LifeState =
  | { state: 'alive'; age: number; dyingThisYear: boolean }
  | { state: 'dead'; deathYear: number }
  | { state: 'unborn'; birthYear: number }
  | { state: 'unknown' };

export interface Lifespan {
  birth: StoryDate | null | undefined;
  death: StoryDate | null | undefined;
}

/** A moment in story time: a year, or a full date. */
export type StoryMoment = number | KnownDate;

function momentDate(at: StoryMoment): KnownDate {
  return typeof at === 'number' ? { year: at } : at;
}

function isFull(d: KnownDate): d is Required<KnownDate> {
  return d.month !== undefined && d.day !== undefined;
}

/** Exact age on a full date from a full birth date. */
function exactAge(birth: Required<KnownDate>, on: Required<KnownDate>): number {
  let age = on.year - birth.year;
  if (on.month < birth.month || (on.month === birth.month && on.day < birth.day)) age -= 1;
  return age;
}

/**
 * The state of one character at a year or date. Year-only questions use
 * year arithmetic (TL-3); a full date with a full birth date is exact.
 */
export function lifeState(person: Lifespan, at: StoryMoment): LifeState {
  const on = momentDate(at);
  const birth = person.birth;
  const death = isKnown(person.death) ? person.death : null;
  if (death) {
    const after =
      on.year > death.year ||
      (on.year === death.year &&
        isFull(on) &&
        isFull(death) &&
        (compareStoryDates(on, death) ?? 0) > 0);
    if (after) return { state: 'dead', deathYear: death.year };
  }
  if (!isKnown(birth)) return { state: 'unknown' };
  if (on.year < birth.year) return { state: 'unborn', birthYear: birth.year };
  if (isFull(on) && isFull(birth) && (compareStoryDates(on, birth) ?? 0) < 0) {
    return { state: 'unborn', birthYear: birth.year };
  }
  const age = isFull(on) && isFull(birth) ? exactAge(birth, on) : on.year - birth.year;
  return { state: 'alive', age, dyingThisYear: death !== null && death.year === on.year };
}

/** The age at a year or date, or null when unborn, dead, or unknown (CH-4). */
export function ageAt(person: Lifespan, at: StoryMoment): number | null {
  const s = lifeState(person, at);
  return s.state === 'alive' ? s.age : null;
}

/** Plain words for a state, as nodes, pages, and tables show it. */
export function describeState(s: LifeState): string {
  switch (s.state) {
    case 'alive':
      return s.dyingThisYear ? `alive, age ${s.age}, dies this year` : `alive, age ${s.age}`;
    case 'dead':
      return `dead since ${s.deathYear}`;
    case 'unborn':
      return `not yet born (born ${s.birthYear})`;
    case 'unknown':
      return 'age unknown';
  }
}

export interface YearStates {
  year: number;
  alive: { id: string; age: number; dyingThisYear: boolean }[];
  dead: { id: string; deathYear: number }[];
  unborn: string[];
  unknown: string[];
}

/** TL-2: every character in a year as alive with age, dead, not yet born, or unknown. */
export function statesInYear(
  people: readonly (Lifespan & { _id: string })[],
  year: number,
): YearStates {
  const out: YearStates = { year, alive: [], dead: [], unborn: [], unknown: [] };
  for (const p of people) {
    const s = lifeState(p, year);
    if (s.state === 'alive')
      out.alive.push({ id: p._id, age: s.age, dyingThisYear: s.dyingThisYear });
    else if (s.state === 'dead') out.dead.push({ id: p._id, deathYear: s.deathYear });
    else if (s.state === 'unborn') out.unborn.push(p._id);
    else out.unknown.push(p._id);
  }
  return out;
}

/** "1958 to 2041", "2031", or "unknown": the years a node or page shows. */
export function lifeYears(person: Lifespan): string {
  const b = yearOf(person.birth);
  const d = yearOf(person.death);
  const born = b === null ? 'unknown' : String(b);
  return d === null ? born : `${born} to ${d}`;
}
