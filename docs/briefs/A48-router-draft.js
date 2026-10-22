// A48: the browser draft of the capture router from the design page (2026-10-22).
// Reference only: the a48-router builder ports the rules to TypeScript under src/shared/domain/captureRouter/.
// The seed data at the top is the real East Winds bible; the TypeScript builds its index from lists and entries instead.
/* eslint-disable */

// ---------- Seed data: real lists from the East Winds bible snapshot (2026-10-22) ----------
const COMMUNITIES = [
  { id: 'san-francisco', label: 'San Francisco', aliases: ['san francisco', 'sf', 'the city', 'the bay', 'bay area'] },
  { id: 'jinan-shandong', label: 'Jinan / Shandong', aliases: ['jinan', 'shandong', 'the li family', 'the lis'] },
  { id: 'chinese-diaspora-in-california', label: 'Chinese diaspora in California', aliases: ['diaspora', 'chinese-american', 'chinese american', 'chinese students in california', 'abc'] },
  { id: 'evangelical-church', label: 'Evangelical church', aliases: ['the church', 'church', 'evangelical', 'evangelicals', 'youth group', 'congregation'] },
  { id: 'china-national', label: 'China (national)', aliases: ['china', 'the party', 'beijing', 'mainland', 'chinese government'], demonyms: ['chinese'] },
  { id: 'united-states-national', label: 'United States (national)', aliases: ['america', 'the us', 'united states', 'americans', 'washington', 'congress', 'federal'], demonyms: ['american'] },
  { id: 'pacific-states-ca-or-wa', label: 'Pacific States (CA / OR / WA)', parentId: 'united-states-national', aliases: ['pacific states', 'the compact', 'compact', 'pcf', 'california', 'oregon', 'washington state', 'the coast', 'coastal'] },
  { id: 'pure-land-buddhism', label: 'Pure Land Buddhism', parentId: 'jinan-shandong', aliases: ['pure land', 'buddhist', 'buddhists', 'the temple', 'temple', 'sangha', 'merit'] },
];
const CHARACTERS = [
  ['01M4MG30PAAB68PRXSHM5EN4YH', 'Frank Sullivan', ['frank']], ['01M4PC5VFXMQE73DVKE03Y4GWX', 'Laura Sullivan', ['laura']],
  ['01M4MG30PCH00CCJPNZT7M1H2Q', 'Sydney Sullivan', ['sydney']], ['01M4MG30PDPAK8SJ5CQF1Y04RT', 'Mark Sullivan', ['mark']],
  ['01M4MG30PDPAK8SJ5CQF1Y04RK', 'Emilie Sullivan', ['emilie']], ['01M4MG30PDPAK8SJ5CQF1Y04RR', 'Shannon Sullivan', ['shannon']],
  ['01M4MG30PEDP5Q3MP84FAR7BYJ', 'HaoYu Sullivan', ['haoyu']], ['01M4MG30PEDP5Q3MP84FAR7BYC', 'LiNa Sullivan', ['lina']],
  ['01M4MG30PDPAK8SJ5CQF1Y04SP', 'Darnell Shaw', ['darnell']], ['01M4PC5VFXMQE73DVKE03Y4GWZ', 'Matthew Sullivan', ['matthew']],
  ['01M4PC5VFY7HMQXWY1470XTTP7', 'Brock Sullivan', ['brock']], ['01M4PC5VFXMQE73DVKE03Y4GWY', 'Samantha Sullivan', ['samantha']],
  ['01M4MG379QE60CNG2GM5A7VQMY', 'Li Qin', ['qin', '李勤']], ['01M4MG379QE60CNG2GM5A7VQND', 'Li Xuan', ['xuan', '李煊']],
  ['01M4MG379P82F2K84YPS1SWJCJ', 'Li Siyuan', ['siyuan', '李思源', '思源']], ['01M4MG379QE60CNG2GM5A7VQNB', 'Dawn Li', ['dawn', '李晓曦', '晓曦']],
  ['01M4PC5VFY7HMQXWY1470XTTPF', 'Li Sichao', ['sichao', '李思潮']], ['01M4PC5VFY7HMQXWY1470XTTPG', "Wang'an", ["wang'an", 'wangan', '望安']],
  ['01M4PC5VFY7HMQXWY1470XTTPH', 'Nian You', ['nian you', '念忧']], ['01M4PC5VFY7HMQXWY1470XTTPJ', 'Gu Chu', ['gu chu', '固伫']],
  ['01M4MG30PEDP5Q3MP84FAR7BYT', 'Neveah', ['neveah']], ['01M4PC5VFXMQE73DVKE03Y4GX0', 'Leon', ['leon']],
  ['01M4PC5VFY7HMQXWY1470XTTPD', 'Jenn', ['jenn']], ['01M4PC5VFY7HMQXWY1470XTTPC', 'Linh', ['linh']],
  ['01M4PC5VFY7HMQXWY1470XTTP9', "Sydney's husband (unnamed)", ["sydney's husband"]],
  ['01M4PC5VFY7HMQXWY1470XTTP5', "Frank's father (unnamed)", ["frank's father", "frank's dad"]],
].map(([id, name, aliases]) => ({ id, name, aliases: [name.toLowerCase(), ...aliases] }));
const PLACES = [
  ['San Francisco', 'san-francisco', ['san francisco']], ['Sullivan family home', 'san-francisco', ['sullivan home', 'the sullivan house']],
  ["Mark's high school", 'san-francisco', ["mark's high school", "mark's school"]], ["The Sullivans' church", 'evangelical-church', ["sullivans' church", "frank's church"]],
  ['Jinan', 'jinan-shandong', ['jinan']], ['Shandong province', 'jinan-shandong', ['shandong']], ['Li family apartment', 'jinan-shandong', ['li family apartment', 'the apartment']],
  ["Qin's drone factory", 'jinan-shandong', ["qin's drone factory", 'the drone factory', 'drone factory']],
  ["Siyuan's temple", 'pure-land-buddhism', ["siyuan's temple"]], ['Buddhist shrine by a stream', 'pure-land-buddhism', ['the shrine']],
  ['California', 'pacific-states-ca-or-wa', ['california']], ['Oregon', 'pacific-states-ca-or-wa', ['oregon']], ['Washington State', 'pacific-states-ca-or-wa', ['washington state']],
  ['Beijing', 'china-national', ['beijing']], ['Shanghai', 'china-national', ['shanghai']], ['Shenzhen', 'china-national', ['shenzhen']], ['China', 'china-national', ['china']],
  ['United States', 'united-states-national', ['united states']],
  ['Seattle', null, ['seattle']], ['Los Angeles', null, ['los angeles', 'la']], ['San Jose', null, ['san jose']], ['UC Berkeley', null, ['berkeley']],
  ['University of Southern California (USC)', null, ['usc']], ['Tsinghua University', null, ['tsinghua']], ['Reno', null, ['reno']], ['Nevada', null, ['nevada']],
  ['Taiwan', null, ['taiwan']], ['Japan', null, ['japan']], ['Mexico', null, ['mexico']], ['Tijuana', null, ['tijuana']], ['Atlanta', null, ['atlanta']],
  ['Port of Los Angeles and Long Beach', null, ['the port', 'long beach']],
].map(([name, communityId, aliases]) => ({ name, communityId, aliases }));
const CATEGORIES = [
  ['geopolitics', 'Geopolitics', ['treaty', 'sanction', 'alliance', 'summit']], ['technology', 'Technology', ['ai', 'robot', 'drone', 'chip', 'app', 'vr']],
  ['economy', 'Economy', ['crash', 'recession', 'market', 'tariff', 'export', 'license', 'unemployment', 'yuan', 'dollar']],
  ['environment', 'Environment', ['drought', 'flood', 'heat', 'wildfire', 'climate', 'water']], ['demographics', 'Demographics', ['birth rate', 'fertility', 'ageing', 'migration', 'population']],
  ['culture', 'Culture', ['festival', 'film', 'music', 'fashion', 'celebrity']], ['transportation', 'Transportation', ['car', 'cars', 'highway', 'rail', 'train', 'flight', 'port']],
  ['us-leadership', 'US Leadership', ['president', 'white house', 'election']], ['chinese-leadership', 'Chinese Leadership', ['the party', 'party congress', 'chairman']],
  ['pacific-states-compact', 'Pacific States Compact', ['compact', 'pcf']], ['china-taiwan', 'China/Taiwan', ['taiwan', 'strait']],
  ['immigration', 'Immigration', ['visa', 'immigration', 'border', 'deport']], ['energy', 'Energy', ['grid', 'blackout', 'nuclear', 'solar']],
].map(([id, label, cues]) => ({ id, label, cues }));
const GLOSSARY = ['李', '思源', '晓曦', '思潮', '念忧', 'Pure Land Buddhism', 'I take refuge', 'Pacific Coordination Framework (PCF)'];
const AGE_GROUPS = [
  ['0-18', 'Ages 0 to 18', ['kids', 'children', 'teenagers', 'teens', 'schoolkids', 'middle schoolers', 'high schoolers', 'students']],
  ['18-30', 'Ages 18 to 30', ['young people', 'twentysomethings', 'college kids', 'young adults', 'youth']],
  ['30-50', 'Ages 30 to 50', ['parents', 'middle-aged', 'professionals', 'working-age']],
  ['50-70', 'Ages 50 to 70', ['older people', 'boomers', 'the old guard', 'retirees']],
  ['70+', 'Ages 70 and over', ['elderly', 'the very old', 'grandparents', 'great-grandparents']],
].map(([id, label, words]) => ({ id, label, words }));
const CULTURE_LINES = [
  ['san-francisco', 2046, 2050, 'Learning Chinese in San Francisco'],
  ['jinan-shandong', 2055, 2065, 'Sending children to America for prestige'], ['jinan-shandong', 2044, 2066, 'Status through lavish parties'], ['jinan-shandong', 2037, 2057, "Women's housework and 'uncles'"],
  ['chinese-diaspora-in-california', 2056, 2066, 'Studying in English as a Chinese student at USC'],
  ['evangelical-church', 2040, 2066, 'Church life: bright shirts, platitudes, youth group'],
  ['china-national', 2044, 2100, 'Individual initiative within collective purpose'], ['china-national', 2037, 2100, 'Immersive VR schooling'], ['china-national', 2052, 2100, 'Welfare instead of jobs'],
  ['pacific-states-ca-or-wa', 2073, 2100, 'Growing up inside the Compact'],
  ['united-states-national', 2065, 2100, 'Trusting the state over Washington'], ['united-states-national', 2078, 2080, 'Viral fame for kids'],
  ['pure-land-buddhism', 2016, 2086, "Siyuan's Pure Land practice"],
].map(([communityId, startYear, endYear, title]) => ({ communityId, startYear, endYear, title }));
const SECTION_LABELS = { culturalEntries: 'Cultural data', moments: 'Moment', worldEvents: 'World event', places: 'Place', glossaryTerms: 'Glossary term', openQuestions: 'Open question', characters: 'Character' };

// ---------- Lexicon: cue -> weight, per section ----------
const LEX = {
  culturalEntries: [
    [/\b(begin|begins|start|starts|started) (to )?(say|saying|call|calling|wear|wearing|treat|treating|use|using)\b/, 'a group starts to say or do something', 30],
    [/\b(ironically|slang|fashionable|unfashionable|custom|tradition|taboo|polite|rude|expected|expectation|it becomes|becomes common|commonly|popular|normal|nobody|everyone|people)\b/, 'custom or expectation words', 22],
    [/\b(kids|children|teenagers|teens|young people|parents|elderly|boomers|students|retirees)\b/, 'an age group', 14],
    ['DEMONYM_PLUS_PLACE', 'a demonym plus a place ("Chinese people in San Francisco")', 28],
    ['DEMONYM_NAMED', 'a demonym names a group ("Chinese parents")', 18],
    ['COMMUNITY_NAMED', 'a community or its alias is named', 16],
    [/\b(culture|cultural|mannerism|accent|dialect|greeting|etiquette|dress|diet|holiday|hosting|hosts|dinners|gatherings|ceremony|ceremonies|ritual|merit)\b/, 'culture or ritual words', 18],
    ['PLACE_SUBJECT', 'the line starts with a place or community (a group custom, not one person)', 14],
  ],
  moments: [
    ['CHARACTER_SUBJECT', 'a character is named', 26],
    [/\b(moves?|moved|marries|married|dies|died|meets|met|gets?|learns?|starts?|quits?|graduates?|born|lives? in|speaks?|voice|takes a job|joins|argues?|falls|breaks up|divorces?|retires?|goes by)\b/, 'a life verb', 22],
    [/\b(his|her|their) (job|mother|father|wife|husband|son|daughter|sister|brother|accent|habit)\b/, 'a possessive about a person', 10],
  ],
  worldEvents: [
    [/\b(war|election|president|law|bans?|banned|treaty|collapse|collapses|crash|recession|invades?|launches?|earthquake|pandemic|tariffs?|government|congress|party congress|signs?|passes|nationwide|statewide|federal|blockade|standoff|sanctions?|license)\b/, 'a public event verb or noun', 26],
    ['CATEGORY_CUE', 'words of an event category', 16],
    ['YEAR_NO_CHARACTER', 'a year with no character named', 10],
    [/\b(the compact|pcf|beijing|washington|the party|the state)\b/, 'a government or bloc as subject', 12],
  ],
  places: [
    [/\b(neighborhood|neighbourhood|district|street|avenue|building|is in|located|a town|a city|a village|suburb|campus|is a place)\b/, 'place words', 28],
    [/\b(opens|closes|is built|is demolished|burns down|floods)\b/, 'a place changes', 10],
  ],
  glossaryTerms: [
    ['CJK', 'Chinese characters present', 26],
    [/\b(means|meaning|word for|slang for|is called|a term|the term|nickname|pronounced)\b/, 'a word is explained', 24],
    ['QUOTED_WORD', 'a quoted word', 10],
  ],
  openQuestions: [
    [/\?/, 'a question mark', 30],
    [/\b(should|maybe|not sure|decide|what if|or should|unsure|question:|idea:)\b/, 'hedging words', 20],
  ],
  characters: [
    [/\b(new character|a (man|woman|boy|girl|kid) (named|called)|introduce|introducing)\b/, 'a new person is introduced', 34],
  ],
};
const REQUIRED = { culturalEntries: ['communityId', 'startYear'], moments: ['characterId', 'year'], worldEvents: ['start', 'categoryId'], places: ['name'], glossaryTerms: ['characters'], openQuestions: [], characters: ['name'] };

// ---------- Stage 1: parse ----------
function parse(text, storyYear) {
  const t = text.trim();
  const lower = t.toLowerCase();
  const out = { years: [], start: null, end: null, source: 'story year', sentences: 0, question: /\?/.test(t), cjk: /\p{Script=Han}/u.test(t), quoted: [] };
  const sentences = t.split(/(?<=[.!?])\s+(?=[A-Z\p{Script=Han}])/u).filter((s) => s.trim());
  out.sentences = Math.max(1, sentences.length);
  const q = t.match(/[‘’'"“”]([^‘’'"“”]{2,30})[‘’'"“”]/g);
  if (q) out.quoted = q.map((s) => s.slice(1, -1));
  const span = lower.match(/\b(20\d\d)\s*(?:to|-|–|until|through)\s*(20\d\d)\b/);
  const decade = lower.match(/\b(?:the\s+)?(20\d)0s\b/);
  const by = lower.match(/\b(?:by|before)\s+(?:the\s+)?(20\d\d|20\d0s)\b/);
  const until = lower.match(/\b(?:until|through|up to)\s+(20\d\d)\b/);
  const years = [...lower.matchAll(/\b(20\d\d)\b/g)].map((m) => +m[1]);
  out.years = years;
  if (span) { out.start = +span[1]; out.end = +span[2]; out.source = 'a span in the text'; }
  else if (decade) { out.start = +decade[1] * 10; out.end = out.start + 9; out.source = 'a decade in the text'; }
  else if (years.length) { out.start = years[0]; out.source = 'a year in the text'; if (until) out.end = +until[1]; }
  if (by && !span) { out.start = by[1].endsWith('s') ? +by[1].slice(0, 3) * 10 : +by[1]; out.end = null; out.source = '"by" a year, taken as the start'; }
  if (out.start === null) out.start = storyYear;
  return out;
}

// ---------- Stage 2: resolve names ----------
function resolve(text) {
  const lower = ' ' + text.toLowerCase().replace(/[‘’]/g, "'") + ' ';
  const has = (alias) => lower.includes(' ' + alias + ' ') || lower.includes(' ' + alias + "'") || new RegExp('(^|[^a-z])' + alias.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '([^a-z]|$)').test(lower);
  const found = { characters: [], places: [], communities: [], demonyms: [], categories: [], glossary: [], ageGroups: [], unknownCaps: [] };
  for (const c of CHARACTERS) { const m = c.aliases.filter(has).sort((a, b) => b.length - a.length)[0]; if (m) found.characters.push({ ...c, matched: m }); }
  for (const p of PLACES) { const m = p.aliases.filter(has).sort((a, b) => b.length - a.length)[0]; if (m) found.places.push({ ...p, matched: m }); }
  // "Sydney's husband" is not Sydney, and "Siyuan's temple" is a place, not Siyuan: a name inside a longer match is not the subject.
  const longer = [...found.characters, ...found.places].map((e) => e.matched);
  found.characters = found.characters.filter((c) => !longer.some((m) => m !== c.matched && m.includes(c.matched)));
  for (const c of COMMUNITIES) {
    if (c.aliases.some(has)) found.communities.push({ ...c, via: 'alias' });
    if ((c.demonyms || []).some(has)) found.demonyms.push(c);
  }
  for (const c of CATEGORIES) if (c.cues.some(has)) found.categories.push(c);
  for (const g of GLOSSARY) if (text.includes(g)) found.glossary.push(g);
  for (const a of AGE_GROUPS) if (a.words.some(has)) found.ageGroups.push(a);
  // Capitalised words mid-sentence that matched nothing: likely a name the bible lacks.
  const caps = [...text.matchAll(/(?<=[a-z,;]\s)((?:[A-Z][a-z']+\s?){1,3}(?:(?:district|neighborhood|neighbourhood|street|avenue|building|bridge|park)\b)?)/g)].map((m) => m[1].trim());
  const known = (w) => [...CHARACTERS.flatMap((c) => c.aliases), ...PLACES.flatMap((p) => p.aliases), ...COMMUNITIES.flatMap((c) => [...c.aliases, ...(c.demonyms || [])])].some((a) => a.includes(w.toLowerCase()) || w.toLowerCase().includes(a));
  const stop = /^(the|a|an|in|on|at|by|to|for|and|or|but|starting|around|chinese|american|compact|party|congress|us|china)$/i;
  found.unknownCaps = caps.filter((w) => !known(w) && !stop.test(w) && !/^(I|US|LA|SF)$/.test(w));
  // Deduplicate characters that share a place name match (Li family vs Dawn Li handled by alias specificity).
  found.characters = found.characters.filter((c, i, arr) => arr.findIndex((o) => o.id === c.id) === i);
  return found;
}

// ---------- Stage 3: score and route ----------
function score(text, parsed, found) {
  const lower = text.toLowerCase();
  const scores = {}; const cues = {};
  const add = (section, label, w) => { scores[section] = (scores[section] || 0) + w; (cues[section] ||= []).push(label); };
  const placeNamed = found.places.length > 0 || found.communities.length > 0;
  const demonymPlusPlace = found.demonyms.length > 0 && placeNamed;
  const communityNamed = found.communities.length > 0 || found.places.some((p) => p.communityId);
  const categoryCue = found.categories.length > 0;
  for (const [section, rules] of Object.entries(LEX)) {
    for (const [cue, label, w] of rules) {
      if (cue instanceof RegExp) { if (cue.test(lower)) add(section, label, w); continue; }
      if (cue === 'DEMONYM_PLUS_PLACE' && demonymPlusPlace) add(section, label, w);
      if (cue === 'COMMUNITY_NAMED' && communityNamed) add(section, label, w);
      if (cue === 'DEMONYM_NAMED' && found.demonyms.length) add(section, label, w);
      if (cue === 'PLACE_SUBJECT' && [...found.places, ...found.communities].some((e) => lower.replace(/^the\s+/, '').startsWith(e.matched || e.aliases[0]))) add(section, label, w);
      if (cue === 'CHARACTER_SUBJECT' && found.characters.length) add(section, label, w);
      if (cue === 'CATEGORY_CUE' && categoryCue) add(section, label, w);
      if (cue === 'YEAR_NO_CHARACTER' && parsed.years.length && !found.characters.length) add(section, label, w);
      if (cue === 'CJK' && parsed.cjk) add(section, label, w);
      if (cue === 'QUOTED_WORD' && parsed.quoted.length) add(section, label, w);
    }
  }
  // A character as subject pulls a "world" verb towards a moment; a group as subject pulls it away.
  if (found.characters.length && scores.worldEvents) scores.worldEvents = Math.round(scores.worldEvents * 0.5);
  if (!found.characters.length && scores.moments) scores.moments = Math.round(scores.moments * 0.4);
  if (/\b(people|everyone|kids|teenagers|parents)\b/.test(lower) && scores.moments) scores.moments = Math.round(scores.moments * 0.5);
  // A line that ends in a question mark is a question, whatever else it names.
  if (parsed.question) for (const s of Object.keys(scores)) if (s !== 'openQuestions') scores[s] = Math.round(scores[s] * 0.25);
  if (!Object.keys(scores).length) { scores.openQuestions = 10; cues.openQuestions = ['nothing matched, so it waits as a question']; }
  return { scores, cues };
}

function pickCommunity(found, povCommunity) {
  const cands = [];
  for (const p of found.places) if (p.communityId) cands.push({ id: p.communityId, why: `place ${p.name}` });
  for (const c of found.communities) cands.push({ id: c.id, why: `alias for ${c.label}` });
  if (found.demonyms.length) {
    const placeInCalifornia = cands.some((c) => ['san-francisco', 'pacific-states-ca-or-wa'].includes(c.id));
    for (const d of found.demonyms) {
      if (d.id === 'china-national' && placeInCalifornia) cands.push({ id: 'chinese-diaspora-in-california', why: 'demonym Chinese in California' });
      cands.push({ id: d.id, why: `demonym ${d.demonyms[0]}` });
    }
  }
  const seen = new Set(); const uniq = cands.filter((c) => !seen.has(c.id) && seen.add(c.id));
  if (!uniq.length && povCommunity) uniq.push({ id: povCommunity, why: 'the writing strand', weak: true });
  return uniq;
}

function route(text, storyYear, povCommunity, thresholds, overrides = {}) {
  const parsed = parse(text, storyYear);
  const found = resolve(text);
  const { scores, cues } = score(text, parsed, found);
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((s, [, v]) => s + v, 0) || 1;
  let [section, top] = ranked[0];
  const second = ranked[1] ? ranked[1][1] : 0;
  const share = top / total;
  const margin = top - second;
  if (overrides.section) section = overrides.section;
  const communities = pickCommunity(found, povCommunity);
  const missing = []; const asks = []; const reasons = [];
  let facts = 1;
  const proposals = [];
  const titleFromText = () => {
    const first = text.trim().split(/(?<=[.!?])\s+/)[0];
    let t = first.replace(/\s*(starting|beginning)?\s*(around|from|by|in|after|since|until|through)\s+(the\s+)?20\d\d(s)?\b.*$/i, '').replace(/[.?!]+$/, '');
    t = t.replace(/\s*(20\d\d\s*(to|-|–)\s*20\d\d)/i, '').trim();
    if (t.length < 8) t = first.replace(/^(in|by|around|from)\s+(the\s+)?20\d\d(s)?,?\s*/i, '').replace(/[.?!]+$/, '').trim();
    t = t.length > 90 ? t.slice(0, 89) + '…' : t;
    return t.charAt(0).toUpperCase() + t.slice(1);
  };
  const communityId = overrides.communityId || (communities[0] && communities[0].id) || null;
  const demographic = overrides.demographic || (found.ageGroups[0] && found.ageGroups[0].id) || 'all';
  const start = overrides.start ?? parsed.start;
  const end = overrides.end ?? parsed.end;
  if (section === 'culturalEntries') {
    if (!communityId) { missing.push('communityId'); asks.push('Community'); }
    proposals.push({ op: 'create', collection: 'culturalEntries', fields: { title: titleFromText(), communityId: communityId || '(choose)', demographic, startYear: start, endYear: end ?? 2100, body: text.trim(), status: 'idea' } });
    if (communities[0] && communities[0].weak) reasons.push('community guessed from the strand');
  } else if (section === 'moments') {
    if (!found.characters.length) { missing.push('characterId'); asks.push('Character'); }
    facts = Math.max(1, found.characters.length);
    const place = found.places[0];
    const lives = /\b(moves?|moved|lives? in)\b/i.test(text) && place;
    for (const c of found.characters.length ? found.characters : [{ name: '(choose)', id: null }]) {
      proposals.push({ op: 'create', collection: 'moments', fields: { characterId: c.name, year: start, endYear: end, title: lives ? `Lives in ${place.name}` : titleFromText(), body: text.trim(), status: 'idea' } });
    }
    if (found.characters.length > 1) reasons.push('one moment per character, each needs its own wording');
    if (/\b(goes by|calls|calling|nickname)\b/i.test(text) && parsed.quoted.length) { proposals.push({ op: 'create', collection: 'glossaryTerms', fields: { characters: parsed.quoted[0], language: 'english', meaning: '(Claude writes from the line)' } }); reasons.push('a quoted word may also be a glossary term'); }
    if (/\b(is a|works as|became a)\b/i.test(text) && !lives) reasons.push('might be a role on the character rather than a moment');
  } else if (section === 'worldEvents') {
    const cat = overrides.categoryId || (found.categories.length === 1 ? found.categories[0].id : null);
    if (!cat) { missing.push('categoryId'); reasons.push(found.categories.length > 1 ? `category to choose: ${found.categories.map((c) => c.label).join(' or ')}` : 'category to choose from 126'); }
    proposals.push({ op: 'create', collection: 'worldEvents', fields: { title: titleFromText(), start, end, categoryId: cat || '(choose)', regions: found.places.map((p) => p.name).join(', ') || '(none)', body: text.trim(), status: 'idea' } });
  } else if (section === 'places') {
    const name = found.unknownCaps[0] || (found.places[0] && found.places[0].name);
    if (!name) { missing.push('name'); asks.push('Place name'); }
    const parent = found.places.find((p) => p.name !== name);
    proposals.push({ op: 'create', collection: 'places', fields: { name: name || '(choose)', parent: parent ? parent.name : '(none)', communityId: communityId || '(none)', body: text.trim(), status: 'idea' } });
    if (found.unknownCaps.length) reasons.push(`"${found.unknownCaps[0]}" is not in the bible, probably new`);
  } else if (section === 'glossaryTerms') {
    const term = (text.match(/\p{Script=Han}+/u) || parsed.quoted)[0];
    if (!term) { missing.push('characters'); asks.push('Term'); }
    proposals.push({ op: 'create', collection: 'glossaryTerms', fields: { characters: term || '(choose)', language: parsed.cjk ? 'mandarin' : 'english', meaning: '(Claude writes from the line)', usageNote: text.trim() } });
    reasons.push('meaning and romanization need writing');
  } else if (section === 'openQuestions') {
    proposals.push({ op: 'create', collection: 'openQuestions', fields: { title: titleFromText(), question: text.trim(), tags: 'capture', status: 'idea' } });
  } else if (section === 'characters') {
    const name = found.unknownCaps[0];
    if (!name) { missing.push('name'); asks.push('Name'); }
    proposals.push({ op: 'create', collection: 'characters', fields: { name: name || '(choose)', role: text.trim(), status: 'idea' } });
  }
  if (found.unknownCaps.length && section !== 'places' && section !== 'characters') reasons.push(`unknown name "${found.unknownCaps[0]}"`);
  if (parsed.sentences > 1) reasons.push(`${parsed.sentences} sentences, probably several facts`);
  if (share < thresholds.a && !reasons.length) reasons.push(`section only ${Math.round(share * 100)}% sure`);
  const canAsk = missing.every((m) => asks.length && ['communityId', 'characterId', 'name', 'characters'].includes(m));
  let tier;
  const judgment = reasons.length > 0;
  if (overrides.force === 2) tier = 2;
  else if (parsed.sentences > 1 && share < 0.7) tier = 2;
  else if (share >= thresholds.a && margin >= 20 && !judgment && (missing.length === 0 || canAsk)) tier = 0;
  else if (share >= thresholds.b) tier = 1;
  else tier = 2;
  if (overrides.section && tier === 2 && !judgment && parsed.sentences === 1) tier = 1;
  return { parsed, found, scores, cues, ranked, section, share, margin, communities, communityId, demographic, missing, asks, reasons, proposals, tier, facts, start, end };
}

// ---------- Token estimates ----------
const FIXED_TODAY = 2750; const OUT_PER_TURN = 150;
const READ_SIZE = { characters: 2400, moments: 250, worldEvents: 250, places: 220, culturalEntries: 300, glossaryTerms: 200, openQuestions: 250 };
function estimateToday(r) {
  const names = r.found.characters.length + r.found.places.length + r.found.communities.length + r.found.unknownCaps.length + (r.parsed.quoted.length ? 1 : 0);
  const searches = Math.max(1, names);
  const reads = r.found.characters.length + Math.min(2, r.found.places.length + r.found.communities.length);
  const results = [];
  for (let i = 0; i < searches; i++) results.push(300);
  for (const c of r.found.characters) results.push(READ_SIZE.characters);
  for (let i = 0; i < reads - r.found.characters.length; i++) results.push(READ_SIZE.places);
  for (let i = 0; i < r.proposals.length; i++) results.push(60);
  const turns = results.length + 1;
  const capture = Math.ceil(r.parsed.sentences * 25);
  let input = 0; let acc = 0;
  for (let k = 0; k < turns; k++) { input += FIXED_TODAY + capture + acc + k * OUT_PER_TURN; acc += results[k] || 0; }
  const output = turns * OUT_PER_TURN;
  return { input, output, total: input + output, turns, note: `${turns} turns (${searches} searches, ${reads} reads, ${r.proposals.length} proposal${r.proposals.length === 1 ? '' : 's'}), prompt resent each turn` };
}
function estimateNew(r) {
  const capture = Math.ceil(r.parsed.sentences * 25);
  if (r.tier === 0) return { total: 0, note: 'filed from the box, nothing sent' };
  if (r.tier === 1) {
    const cands = (r.found.characters.length + r.found.places.length + r.found.communities.length + r.found.categories.length) * 40;
    const neighbours = r.section === 'culturalEntries' ? CULTURE_LINES.filter((l) => l.communityId === r.communityId).length * 15 : r.section === 'moments' ? 6 * 15 : r.section === 'worldEvents' ? 20 * 12 : 60;
    const input = 260 + 120 + cands + neighbours + capture + 40;
    const output = 120 * r.proposals.length + 40;
    return { total: input + output, input, output, note: `one Haiku call, no tools: ${input} in, ${output} out` };
  }
  // Route C: trimmed lists, cached prefix, injected candidates, capped reads.
  const lists = 90 + (r.ranked.some(([s, v]) => s === 'worldEvents' && v > 0) ? 420 : 0);
  const fixed = 820 + 650 + lists;
  const cands = (r.found.characters.length + r.found.places.length + r.found.communities.length) * 40;
  const reads = r.found.characters.length + Math.min(2, r.found.places.length);
  const results = []; for (let i = 0; i < reads; i++) results.push(600); for (let i = 0; i < r.proposals.length + (r.parsed.sentences - 1); i++) results.push(60);
  const turns = results.length + 1;
  let input = 0; let acc = 0;
  for (let k = 0; k < turns; k++) { const prefix = k === 0 ? fixed : fixed * 0.1; input += prefix + cands + capture + acc + k * OUT_PER_TURN; acc += results[k] || 0; }
  input = Math.round(input);
  const output = turns * OUT_PER_TURN;
  return { total: input + output, input, output, note: `${turns} turns on Sonnet, prefix cached after the first, candidates injected, reads capped at 600` };
}

// ---------- Examples ----------
const EXAMPLES = [
  'Chinese people in San Francisco begin to say yee haw ironically starting around 2065',
  'Teenagers in Jinan treat an American college degree as a joke by the 2070s',
  'Mark moves to Seattle in 2061 for a job at a Compact logistics firm',
  "Should Frank's church split over the Compact in 2075?",
  'Chinese parents stop sending kids abroad after 2068',
  'The Compact bans gas cars on coastal highways in 2068',
  "Siyuan's temple starts hosting Compact officials for merit-making dinners in 2070",
  'Dawn and Mark argue about whether to raise LiNa bilingual',
  "望安 goes by 'Wanda' at school",
  'The Mission district becomes mostly Compact bureaucrats by 2080',
  "Sydney's husband is a Nevada state trooper",
  "In 2063 the second crash hits. Qin's drone factory loses its export license, Xuan takes a Party job in Beijing, and the Li family apartment is sold.",
];

