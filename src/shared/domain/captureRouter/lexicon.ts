/**
 * Capture routing (A48, CR-3, CR-4): every word the router knows that is not
 * in the bible. One typed object, so the Settings screen can show it and the
 * capture box can show the plain label of each cue that scored.
 *
 * Aliases and demonyms are keyed by list item ID, characters by entry ID and
 * places by their lowercase name (the East Winds bible's place IDs are not
 * fixed in code). An item the lexicon lacks matches by its label alone.
 */
import type { CaptureSection } from './types';

/** A computed signal: something the resolver found rather than a word in the text. */
export type CueSignal =
  | 'ageGroup'
  | 'demonymPlusPlace'
  | 'demonymNamed'
  | 'communityNamed'
  | 'placeSubject'
  | 'characterNamed'
  | 'categoryCue'
  | 'yearNoCharacter'
  | 'newPlaceName'
  | 'cjk'
  | 'quotedWord'
  | 'questionMark';

/**
 * One weighted cue of CR-4. A cue fires at most once per fact. It fires on
 * `words` (whole words or phrases, lowercase), on `pattern` (tested on the
 * lowercase sentence) or on a `signal`. `needsNoCharacter` makes it fire only
 * when no character is named.
 */
export interface Cue {
  id: string;
  section: CaptureSection;
  label: string;
  weight: number;
  words?: readonly string[];
  pattern?: RegExp;
  signal?: CueSignal;
  needsNoCharacter?: boolean;
}

/** A score adjustment after the cues: the sections it scales, by how much, and why. */
export interface Adjustment {
  id: 'questionMark' | 'characterSubject' | 'noCharacter' | 'groupSubject';
  label: string;
  factor: number;
}

export interface CommunityWords {
  aliases: readonly string[];
  /** Words for its people ("chinese" for china-national). */
  demonyms?: readonly string[];
}

/**
 * A demonym plus a place inside one of `whenCommunities` also offers
 * `community`, after the place's own community (CR-3).
 */
export interface DiasporaRule {
  demonymOf: string;
  whenCommunities: readonly string[];
  community: string;
  why: string;
}

export interface Lexicon {
  sectionLabels: Record<CaptureSection, string>;
  cues: readonly Cue[];
  adjustments: readonly Adjustment[];
  /** The cue a fact gets when nothing scored. */
  fallback: { section: CaptureSection; label: string; weight: number };
  communities: Record<string, CommunityWords>;
  diaspora: readonly DiasporaRule[];
  /** Cue words per event category ID. */
  categories: Record<string, readonly string[]>;
  /** Words per age group ID. `all` is never matched; it is the default. */
  ageGroups: Record<string, readonly string[]>;
  /** Extra aliases per character entry ID. */
  characters: Record<string, readonly string[]>;
  /** Extra aliases per place, keyed by the place's lowercase name. */
  places: Record<string, readonly string[]>;
  /** Words that make the subject a group, which discounts the moment reading. */
  groupWords: readonly string[];
  /** Verbs of a life event (moment). */
  lifeVerbs: readonly string[];
  /** Verbs of moving house: a moment titled "Lives in <place>". */
  moveVerbs: readonly string[];
  /** Words that may make a moment a role on the character instead. */
  roleWords: readonly string[];
  /** Words beside a quoted word that make it a name the character goes by. */
  nicknameWords: readonly string[];
  /** The year grammar of CR-2. */
  years: {
    startWords: readonly string[];
    openStartWords: readonly string[];
    endWords: readonly string[];
    spanJoiners: readonly string[];
  };
  /** Words that follow a capitalised name and belong to it ("Mission district"). */
  placeTails: readonly string[];
  /** Capitalised words that are never an unknown name, and never a first name alias. */
  stopWords: readonly string[];
  /** Pinyin surnames: a Chinese name that starts with one is surname first ("Li Qin" gives "qin"). */
  chineseSurnames: readonly string[];
  /** Words before a full stop that do not end a sentence. */
  abbreviations: readonly string[];
}

/** Verbs of a life event (moment), shared by the life verb cue and the moment subject rule. */
const LIFE_VERBS: readonly string[] = [
  'move',
  'moves',
  'moved',
  'marry',
  'marries',
  'married',
  'die',
  'dies',
  'died',
  'meet',
  'meets',
  'met',
  'get',
  'gets',
  'got',
  'learn',
  'learns',
  'learned',
  'start',
  'starts',
  'started',
  'quit',
  'quits',
  'graduate',
  'graduates',
  'graduated',
  'born',
  'live in',
  'lives in',
  'lived in',
  'speak',
  'speaks',
  'spoke',
  'voice',
  'take',
  'takes',
  'took',
  'join',
  'joins',
  'joined',
  'argue',
  'argues',
  'argued',
  'fall',
  'falls',
  'fell',
  'break up',
  'breaks up',
  'divorce',
  'divorces',
  'divorced',
  'retire',
  'retires',
  'retired',
  'goes by',
];

export const LEXICON: Lexicon = {
  sectionLabels: {
    culturalEntries: 'Cultural data',
    moments: 'Moment',
    worldEvents: 'World event',
    places: 'Place',
    glossaryTerms: 'Glossary term',
    openQuestions: 'Open question',
    characters: 'Character',
  },
  cues: [
    // Cultural data
    {
      id: 'groupStarts',
      section: 'culturalEntries',
      label: 'a group starts to say or do something',
      weight: 30,
      pattern:
        /\b(?:begins?|began|starts?|started|stops?|stopped)\s+(?:to\s+)?(?:say|call|wear|treat|use|eat|celebrate|send|speak|[a-z]+ing)\b/,
      needsNoCharacter: true,
    },
    {
      id: 'customWords',
      section: 'culturalEntries',
      label: 'custom or expectation words',
      weight: 22,
      words: [
        'ironically',
        'slang',
        'fashionable',
        'unfashionable',
        'custom',
        'customs',
        'tradition',
        'traditions',
        'taboo',
        'polite',
        'rude',
        'expected',
        'expectation',
        'expectations',
        'it becomes',
        'becomes common',
        'commonly',
        'popular',
        'normal',
        'nobody',
        'everyone',
        'people',
        'a joke',
        'prestige',
      ],
    },
    {
      id: 'ageGroup',
      section: 'culturalEntries',
      label: 'an age group',
      weight: 14,
      signal: 'ageGroup',
    },
    {
      id: 'demonymPlusPlace',
      section: 'culturalEntries',
      label: 'a demonym plus a place ("Chinese people in San Francisco")',
      weight: 28,
      signal: 'demonymPlusPlace',
    },
    {
      id: 'demonymNamed',
      section: 'culturalEntries',
      label: 'a demonym names a group ("Chinese parents")',
      weight: 18,
      signal: 'demonymNamed',
    },
    {
      id: 'communityNamed',
      section: 'culturalEntries',
      label: 'a community or its alias is named',
      weight: 16,
      signal: 'communityNamed',
    },
    {
      id: 'cultureWords',
      section: 'culturalEntries',
      label: 'culture or ritual words',
      weight: 18,
      words: [
        'culture',
        'cultural',
        'mannerism',
        'accent',
        'dialect',
        'greeting',
        'etiquette',
        'dress',
        'diet',
        'holiday',
        'hosting',
        'hosts',
        'dinners',
        'gatherings',
        'ceremony',
        'ceremonies',
        'ritual',
        'merit',
      ],
    },
    {
      id: 'placeSubject',
      section: 'culturalEntries',
      label: 'the line starts with a place or community (a group custom, not one person)',
      weight: 14,
      signal: 'placeSubject',
    },
    // Moment
    {
      id: 'characterNamed',
      section: 'moments',
      label: 'a character is named',
      weight: 26,
      signal: 'characterNamed',
    },
    { id: 'lifeVerb', section: 'moments', label: 'a life verb', weight: 22, words: LIFE_VERBS },
    {
      id: 'possessive',
      section: 'moments',
      label: 'a possessive about a person',
      weight: 10,
      pattern:
        /\b(?:his|her|their)\s+(?:job|mother|father|wife|husband|son|daughter|sister|brother|accent|habit)\b/,
    },
    // World event
    {
      id: 'publicEvent',
      section: 'worldEvents',
      label: 'a public event verb or noun',
      weight: 26,
      words: [
        'war',
        'election',
        'president',
        'law',
        'ban',
        'bans',
        'banned',
        'treaty',
        'collapse',
        'collapses',
        'crash',
        'recession',
        'invade',
        'invades',
        'launch',
        'launches',
        'earthquake',
        'pandemic',
        'tariff',
        'tariffs',
        'government',
        'congress',
        'party congress',
        'sign',
        'signs',
        'passes',
        'nationwide',
        'statewide',
        'federal',
        'blockade',
        'standoff',
        'sanction',
        'sanctions',
        'license',
      ],
    },
    {
      id: 'categoryCue',
      section: 'worldEvents',
      label: 'words of an event category',
      weight: 16,
      signal: 'categoryCue',
    },
    {
      id: 'yearNoCharacter',
      section: 'worldEvents',
      label: 'a year with no character named',
      weight: 10,
      signal: 'yearNoCharacter',
    },
    {
      id: 'governmentSubject',
      section: 'worldEvents',
      label: 'a government or bloc as subject',
      weight: 12,
      words: [
        'the compact',
        'pcf',
        'beijing',
        'washington',
        'the party',
        'the state',
        'the government',
      ],
    },
    // Place
    {
      id: 'placeWords',
      section: 'places',
      label: 'place words',
      weight: 28,
      words: [
        'neighborhood',
        'neighbourhood',
        'district',
        'street',
        'avenue',
        'building',
        'is in',
        'located',
        'a town',
        'a city',
        'a village',
        'suburb',
        'campus',
        'is a place',
      ],
    },
    {
      id: 'placeChanges',
      section: 'places',
      label: 'a place changes',
      weight: 10,
      words: ['opens', 'closes', 'is built', 'is demolished', 'burns down', 'floods'],
    },
    {
      id: 'newPlaceName',
      section: 'places',
      label: 'a new name with a place word ("Mission district")',
      weight: 20,
      signal: 'newPlaceName',
    },
    // Glossary term
    {
      id: 'cjk',
      section: 'glossaryTerms',
      label: 'Chinese characters that are not a name in the bible',
      weight: 26,
      signal: 'cjk',
    },
    {
      id: 'wordExplained',
      section: 'glossaryTerms',
      label: 'a word is explained',
      weight: 24,
      words: [
        'means',
        'meaning',
        'word for',
        'slang for',
        'is called',
        'a term',
        'the term',
        'nickname',
        'pronounced',
      ],
    },
    {
      id: 'quotedWord',
      section: 'glossaryTerms',
      label: 'a quoted word',
      weight: 10,
      signal: 'quotedWord',
    },
    // Open question
    {
      id: 'questionMark',
      section: 'openQuestions',
      label: 'a question mark',
      weight: 30,
      signal: 'questionMark',
    },
    {
      id: 'hedging',
      section: 'openQuestions',
      label: 'hedging words',
      weight: 20,
      words: [
        'should',
        'maybe',
        'not sure',
        'decide',
        'what if',
        'or should',
        'unsure',
        'question:',
        'idea:',
      ],
    },
    // Character
    {
      id: 'personIntroduced',
      section: 'characters',
      label: 'a new person is introduced',
      weight: 34,
      pattern:
        /\b(?:new character|an? (?:man|woman|boy|girl|kid|teacher|friend|neighbor|neighbour) (?:named|called)|introduce|introducing)\b/,
    },
  ],
  adjustments: [
    {
      id: 'questionMark',
      label: 'a question mark cuts every other section to a quarter',
      factor: 0.25,
    },
    {
      id: 'characterSubject',
      label: 'a character as subject halves the world event reading',
      factor: 0.5,
    },
    {
      id: 'noCharacter',
      label: 'no character named cuts the moment reading to 40%',
      factor: 0.4,
    },
    { id: 'groupSubject', label: 'a group as subject halves the moment reading', factor: 0.5 },
  ],
  fallback: {
    section: 'openQuestions',
    label: 'nothing matched, so it waits as a question',
    weight: 10,
  },
  communities: {
    'san-francisco': { aliases: ['san francisco', 'sf', 'the city', 'the bay', 'bay area'] },
    'jinan-shandong': { aliases: ['jinan', 'shandong', 'the li family', 'the lis'] },
    'chinese-diaspora-in-california': {
      aliases: [
        'diaspora',
        'chinese-american',
        'chinese american',
        'chinese students in california',
        'abc',
      ],
    },
    'evangelical-church': {
      aliases: [
        'the church',
        'church',
        'evangelical',
        'evangelicals',
        'youth group',
        'congregation',
      ],
    },
    'china-national': {
      aliases: ['china', 'the party', 'beijing', 'mainland', 'chinese government'],
      demonyms: ['chinese'],
    },
    'united-states-national': {
      aliases: [
        'america',
        'the us',
        'united states',
        'americans',
        'washington',
        'congress',
        'federal',
      ],
      demonyms: ['american'],
    },
    'pacific-states-ca-or-wa': {
      aliases: [
        'pacific states',
        'the compact',
        'compact',
        'pcf',
        'california',
        'oregon',
        'washington state',
        'the coast',
        'coastal',
      ],
    },
    'pure-land-buddhism': {
      aliases: ['pure land', 'buddhist', 'buddhists', 'the temple', 'temple', 'sangha', 'merit'],
    },
  },
  diaspora: [
    {
      demonymOf: 'china-national',
      whenCommunities: ['san-francisco', 'pacific-states-ca-or-wa'],
      community: 'chinese-diaspora-in-california',
      why: 'the demonym Chinese with a place in California',
    },
  ],
  categories: {
    geopolitics: ['treaty', 'sanction', 'sanctions', 'alliance', 'summit'],
    technology: ['ai', 'robot', 'robots', 'drone', 'drones', 'chip', 'chips', 'app', 'vr'],
    economy: [
      'crash',
      'recession',
      'market',
      'tariff',
      'tariffs',
      'export',
      'license',
      'unemployment',
      'yuan',
      'dollar',
    ],
    environment: ['drought', 'flood', 'heat', 'wildfire', 'climate', 'water'],
    demographics: ['birth rate', 'fertility', 'ageing', 'aging', 'migration', 'population'],
    culture: ['festival', 'film', 'music', 'fashion', 'celebrity'],
    transportation: ['car', 'cars', 'highway', 'highways', 'rail', 'train', 'flight', 'port'],
    'us-leadership': ['president', 'white house', 'election'],
    'chinese-leadership': ['the party', 'party congress', 'chairman'],
    'pacific-states-compact': ['compact', 'pcf'],
    'china-taiwan': ['taiwan', 'strait'],
    immigration: ['visa', 'immigration', 'border', 'deport'],
    energy: ['grid', 'blackout', 'nuclear', 'solar'],
  },
  ageGroups: {
    '0-18': [
      'kids',
      'children',
      'teenagers',
      'teens',
      'schoolkids',
      'middle schoolers',
      'high schoolers',
      'students',
    ],
    '18-30': ['young people', 'twentysomethings', 'college kids', 'young adults', 'youth'],
    '30-50': ['parents', 'middle-aged', 'professionals', 'working-age'],
    '50-70': ['older people', 'boomers', 'the old guard', 'retirees'],
    '70+': ['elderly', 'the very old', 'grandparents', 'great-grandparents'],
  },
  characters: {
    // Wang'an, typed without the apostrophe.
    '01M4PC5VFY7HMQXWY1470XTTPG': ['wangan'],
    // Frank's father (unnamed).
    '01M4PC5VFY7HMQXWY1470XTTP5': ["frank's dad"],
  },
  places: {
    'sullivan family home': ['sullivan home', 'the sullivan house'],
    "mark's high school": ["mark's school"],
    "the sullivans' church": ["sullivans' church", "frank's church"],
    'shandong province': ['shandong'],
    'li family apartment': ['the apartment'],
    "qin's drone factory": ['the drone factory', 'drone factory'],
    'buddhist shrine by a stream': ['the shrine'],
    'los angeles': ['la'],
    'uc berkeley': ['berkeley'],
    'university of southern california (usc)': ['usc'],
    'tsinghua university': ['tsinghua'],
    'port of los angeles and long beach': ['the port', 'long beach'],
  },
  groupWords: [
    'people',
    'everyone',
    'nobody',
    'families',
    'kids',
    'children',
    'teenagers',
    'teens',
    'parents',
    'students',
    'young people',
    'elderly',
  ],
  lifeVerbs: LIFE_VERBS,
  moveVerbs: ['move', 'moves', 'moved', 'live in', 'lives in', 'lived in', 'relocates'],
  roleWords: ['is a', 'is an', 'works as', 'became a', 'becomes a'],
  nicknameWords: ['goes by', 'calls', 'calling', 'called', 'nickname'],
  years: {
    startWords: [
      'starting around',
      'starting in',
      'starting',
      'beginning',
      'from',
      'after',
      'since',
      'in',
      'around',
    ],
    openStartWords: ['by', 'before'],
    endWords: ['until', 'through', 'up to', 'to'],
    spanJoiners: ['to', '-', '–', 'until', 'through'],
  },
  placeTails: [
    'district',
    'neighborhood',
    'neighbourhood',
    'street',
    'avenue',
    'building',
    'bridge',
    'park',
  ],
  stopWords: [
    'the',
    'a',
    'an',
    'in',
    'on',
    'at',
    'by',
    'to',
    'for',
    'and',
    'or',
    'but',
    'of',
    'from',
    'with',
    'starting',
    'around',
    'i',
    'you',
    'he',
    'she',
    'we',
    'they',
    'it',
    'party',
    'congress',
    'us',
    'mr',
    'mrs',
    'ms',
    'dr',
    'god',
    'american',
    'americans',
    'chinese',
    'japanese',
    'mexican',
    'korean',
    'taiwanese',
    'english',
    'spanish',
    'french',
    'german',
    'russian',
    'indian',
    'vietnamese',
    'filipino',
    'mandarin',
    'cantonese',
    'christian',
    'buddhist',
    'catholic',
    'monday',
    'tuesday',
    'wednesday',
    'thursday',
    'friday',
    'saturday',
    'sunday',
    'january',
    'february',
    'march',
    'april',
    'may',
    'june',
    'july',
    'august',
    'september',
    'october',
    'november',
    'december',
  ],
  chineseSurnames: [
    'li',
    'wang',
    'zhang',
    'liu',
    'chen',
    'yang',
    'zhao',
    'huang',
    'zhou',
    'wu',
    'xu',
    'sun',
    'hu',
    'zhu',
    'gao',
    'lin',
    'he',
    'guo',
    'ma',
    'luo',
    'liang',
    'song',
    'zheng',
    'xie',
    'han',
    'tang',
    'feng',
    'yu',
    'dong',
    'xiao',
    'cheng',
    'cao',
    'yuan',
    'deng',
    'fu',
    'shen',
    'zeng',
    'peng',
    'lu',
    'su',
    'jiang',
    'cai',
    'jia',
    'ding',
    'wei',
    'xue',
    'ye',
    'yan',
    'pan',
    'du',
    'dai',
    'xia',
    'zhong',
    'tian',
    'ren',
    'fan',
    'fang',
    'shi',
    'yao',
    'tan',
    'liao',
    'zou',
    'xiong',
    'jin',
    'kong',
    'bai',
    'cui',
    'kang',
    'mao',
    'qiu',
    'qin',
    'gu',
    'hou',
    'shao',
    'meng',
    'long',
    'duan',
    'qian',
    'yin',
  ],
  abbreviations: [
    'mr',
    'mrs',
    'ms',
    'dr',
    'st',
    'jr',
    'sr',
    'vs',
    'etc',
    'mt',
    'ft',
    'no',
    'e.g',
    'i.e',
    'u.s',
  ],
};
