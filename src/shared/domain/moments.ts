/**
 * Migration 9 (SM-3) as pure functions: the moment each plot beat, voice note,
 * and place lived becomes. The migration in `src/main/db/migrations/` runs
 * them over every document; the fixture novel's `moments.json` holds exactly
 * what they make of the old fixture.
 *
 * IDs are stable so a migration run twice, or a restore that runs it again,
 * makes the same moments: a beat's moment keeps the beat's ID (links to the
 * beat still land), a voice note's is `<character>-voice-<n>`, a place's is
 * `<character>-lives-<n>`.
 */
import { LIVES_IN_PREFIX, VOICE_MOMENT_TITLE } from '../schema/moment';
import { isPlainObject } from './paths';
import type { Doc } from './paths';

const str = (v: unknown) => (typeof v === 'string' ? v : '');
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** The most an ID may hold (the `Id` schema). */
const MAX_ID = 64;

/** A moment as migration 9 writes it, before any validation. */
export type MomentDoc = Doc & { _id: string; characterId: string; year: number };

/** Why a source made no moment, for the migration's summary. */
export interface Skip {
  source: 'plotBeat' | 'voiceNote' | 'placeLived';
  id: string;
  reason: string;
}

export type MomentOrSkip = { moment: MomentDoc } | { skip: Skip };

/** A stable ID for a moment made from a character's list item, cut to the ID limit. */
function listId(characterId: string, kind: 'voice' | 'lives', index: number): string {
  const suffix = `-${kind}-${index}`;
  return `${characterId.slice(0, MAX_ID - suffix.length)}${suffix}`;
}

/** The common fields a moment made from a character's list item takes from the character. */
function fromCharacter(c: Doc): Doc {
  return {
    createdAt: c.createdAt,
    modifiedAt: c.modifiedAt,
    ...(c.deletedAt ? { deletedAt: c.deletedAt } : {}),
  };
}

/**
 * A plot beat becomes a moment of its point of view character: the year, the
 * title, the experience note as the body (with the description first, when
 * there is one), the world context, and its times. Its arcs, arc
 * positions, and chapter go. A beat with no point of view or no year is skipped.
 */
export function beatToMoment(beat: Doc): MomentOrSkip {
  const id = str(beat._id);
  const characterId = str(beat.povCharacterId);
  const year = num(beat.year);
  if (!characterId) {
    return { skip: { source: 'plotBeat', id, reason: 'it has no point of view character' } };
  }
  if (year === null) return { skip: { source: 'plotBeat', id, reason: 'it has no year' } };
  const body = [str(beat.description).trim(), str(beat.experienceNote).trim()]
    .filter(Boolean)
    .join('\n\n');
  return {
    moment: {
      _id: id,
      title: str(beat.title),
      body,
      createdAt: beat.createdAt,
      modifiedAt: beat.modifiedAt,
      ...(beat.deletedAt ? { deletedAt: beat.deletedAt } : {}),
      characterId,
      year,
      endYear: null,
      worldContext: str(beat.worldContext),
    },
  };
}

/**
 * A voice note becomes a moment titled "Voice" with the note as its body, at
 * the note's year, or at the birth year plus the note's age. An age with no
 * known birth year cannot be placed, so it is skipped.
 */
export function voiceNoteToMoment(character: Doc, note: unknown, index: number): MomentOrSkip {
  const characterId = str(character._id);
  const id = listId(characterId, 'voice', index);
  const at = isPlainObject(note) && isPlainObject(note.at) ? note.at : {};
  const text = isPlainObject(note) ? str(note.text) : '';
  const born = isPlainObject(character.birth) ? num(character.birth.year) : null;
  const age = num(at.age);
  const year = num(at.year) ?? (age !== null && born !== null ? born + age : null);
  if (year === null) {
    return {
      skip: {
        source: 'voiceNote',
        id,
        reason:
          age !== null
            ? `it is set at age ${age} and the birth year is unknown`
            : 'it has no year or age',
      },
    };
  }
  return {
    moment: {
      _id: id,
      title: VOICE_MOMENT_TITLE,
      body: text,
      ...fromCharacter(character),
      characterId,
      year,
      endYear: null,
      worldContext: '',
    },
  };
}

/**
 * A place lived becomes a moment titled "Lives in <place>" from its start year
 * to its end year (an open end stays open: the moment runs on until a later
 * "Lives in" moment). The first place with no start year is where the
 * character was born (the audit's birthplace row), so it starts at the birth
 * year when that is known. Any other place with no start year is skipped.
 */
export function placeToMoment(character: Doc, place: unknown, index: number): MomentOrSkip {
  const characterId = str(character._id);
  const id = listId(characterId, 'lives', index);
  const name = isPlainObject(place) ? str(place.place).trim() : '';
  const born = isPlainObject(character.birth) ? num(character.birth.year) : null;
  const start = isPlainObject(place) ? num(place.startYear) : null;
  const year = start ?? (index === 0 ? born : null);
  const end = isPlainObject(place) ? num(place.endYear) : null;
  if (year === null) {
    return {
      skip: { source: 'placeLived', id, reason: `${name || 'the place'} has no start year` },
    };
  }
  return {
    moment: {
      _id: id,
      title: `${LIVES_IN_PREFIX}${name}`,
      body: '',
      ...fromCharacter(character),
      characterId,
      year,
      endYear: end,
      worldContext: '',
    },
  };
}

/** Every moment a character's voice notes and places lived make, and what was skipped. */
export function characterMoments(character: Doc): { moments: MomentDoc[]; skipped: Skip[] } {
  const moments: MomentDoc[] = [];
  const skipped: Skip[] = [];
  const take = (r: MomentOrSkip) => {
    if ('moment' in r) moments.push(r.moment);
    else skipped.push(r.skip);
  };
  (Array.isArray(character.voiceNotes) ? character.voiceNotes : []).forEach((n, i) =>
    take(voiceNoteToMoment(character, n, i)),
  );
  (Array.isArray(character.placesLived) ? character.placesLived : []).forEach((p, i) =>
    take(placeToMoment(character, p, i)),
  );
  return { moments, skipped };
}

/**
 * SM-4: a cultural entry's generation notes are folded into its body, and an
 * era's five prose fields are added under their headings, so nothing written
 * there is lost when the fields go. Returns the new body, or null when
 * nothing changes.
 */
export function foldedBody(
  body: unknown,
  parts: readonly (readonly [string, unknown])[],
): string | null {
  const extra = parts
    .map(([label, v]) => [label, str(v).trim()] as const)
    .filter(([, v]) => v !== '');
  if (!extra.length) return null;
  const text = extra.map(([label, v]) => `${label}: ${v}`).join('\n\n');
  const base = str(body).trimEnd();
  return base.trim() ? `${base}\n\n${text}` : text;
}

/** The glossary language a character's name is in: Mandarin, or what the bible's languages list calls it. */
export function nameLanguage(languages: unknown): string {
  const items =
    isPlainObject(languages) && Array.isArray(languages.items)
      ? languages.items.filter(isPlainObject)
      : [];
  if (!items.length || items.some((i) => i.id === 'mandarin')) return 'mandarin';
  const byLabel = items.find((i) => /mandarin/i.test(str(i.label)));
  return str(byLabel?.id) || str(items[0]?.id) || 'mandarin';
}

/** What SM-1 does with the romanizations of character names. */
export interface NameTerms {
  /** New glossary terms, one per Chinese name no term holds yet. */
  made: Doc[];
  /** Existing terms with the same characters and no romanization, filled from the character. */
  filled: { _id: string; romanization: string }[];
}

/**
 * SM-1: a character's romanization moves to the glossary term for the name.
 * For each character with `names.chinese` and a romanization, a term is made
 * (the characters, the romanization, the language, the full name as the
 * meaning) unless a live term with the same characters exists; then its
 * romanization is filled if it is empty and left as it is otherwise. A term's
 * ID is stable (`<character>-name`), so running this again makes nothing new.
 */
export function nameGlossaryTerms(characters: Doc[], glossary: Doc[], language: string): NameTerms {
  const made: Doc[] = [];
  const filled: NameTerms['filled'] = [];
  const byChars = new Map<string, Doc>();
  for (const g of glossary) {
    const key = str(g.characters).trim();
    if (key && !g.deletedAt && !byChars.has(key)) byChars.set(key, g);
  }
  for (const c of characters) {
    const names = isPlainObject(c.names) ? c.names : {};
    const chinese = str(names.chinese).trim();
    const romanization = str(names.romanization).trim();
    if (!chinese || !romanization) continue;
    const existing = byChars.get(chinese);
    if (existing) {
      if (!str(existing.romanization).trim() && !filled.some((f) => f._id === existing._id)) {
        filled.push({ _id: str(existing._id), romanization });
        existing.romanization = romanization;
      }
      continue;
    }
    const full = str(names.full).trim() || str(c.title);
    const characterId = str(c._id);
    const suffix = '-name';
    const term: Doc = {
      _id: `${characterId.slice(0, MAX_ID - suffix.length)}${suffix}`,
      title: chinese,
      body: '',
      createdAt: c.createdAt,
      modifiedAt: c.modifiedAt,
      ...(c.deletedAt ? { deletedAt: c.deletedAt } : {}),
      characters: chinese,
      romanization,
      language,
      meaning: full,
      usageNote: `The name of ${full}`,
    };
    made.push(term);
    byChars.set(chinese, term);
  }
  return { made, filled };
}
