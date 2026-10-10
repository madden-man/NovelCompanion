/* East Winds story bible, trimmed for the mockups. Every value comes from Tommy's source
   material (see docs/PHASE0-FINDINGS.md). Where sources disagree the newest wins and an
   open question records the rest. IDs are stable so pages can cite them. */
window.EW = (function () {
  const characters = [
    // Sullivan
    { id: 'ch_frank', name: 'Frank Sullivan', family: 'sullivan', born: 2000, bornDate: '2000-04-04', died: 2083, birthplace: 'Reno, Nevada', status: 'planned', nick: 'Dad', note: 'VP then Head of Engineering, converts 2040, retires to start an orphanage 2065.' },
    { id: 'ch_laura', name: 'Laura Sullivan', family: 'sullivan', born: 1998, died: 2037, birthplace: 'Las Vegas area', status: 'planned', note: 'Web designer, pastels. Dies of sepsis three weeks after Mark is born.' },
    { id: 'ch_sydney', name: 'Sydney Sullivan', family: 'sullivan', born: 2030, status: 'planned', note: 'Oldest. Rejects Frank’s faith. Atlanta with Robb 2052.' },
    { id: 'ch_shannon', name: 'Shannon Sullivan', family: 'sullivan', born: 2032, status: 'planned', note: 'Twin of Emilie. CU Boulder 2050.' },
    { id: 'ch_emilie', name: 'Emilie Sullivan', family: 'sullivan', born: 2032, status: 'planned', note: 'Twin of Shannon. Matthew at 17, marries Darnell 2062.' },
    { id: 'ch_samantha', name: 'Samantha Sullivan', family: 'sullivan', born: 2034, died: 2034, status: 'planned', note: 'Miscarriage, 2034.' },
    { id: 'ch_mark', name: 'Mark Sullivan', family: 'sullivan', born: 2037, bornDate: '2037-07-08', birthplace: 'San Francisco', status: 'canon', note: 'Youngest. Draws. USC marketing major 2055. Meets Dawn at a party at nineteen.' },
    { id: 'ch_darnell', name: 'Darnell Shaw', family: 'sullivan', born: 2029, status: 'planned', note: 'Graphic designer, would-be animator. Works for Frank from 2065.' },
    { id: 'ch_matthew', name: 'Matthew Sullivan', family: 'sullivan', born: 2049, status: 'planned', note: 'Emilie’s first son. Father leaves.' },
    { id: 'ch_leon', name: 'Leon Shaw', family: 'sullivan', born: 2064, status: 'planned', note: 'Son of Emilie and Darnell.' },
    { id: 'ch_lina', name: 'LiNa Sullivan', family: 'both', born: 2068, status: 'planned', note: 'Hand pan, TikTok famous at 10.' },
    { id: 'ch_haoyu', name: 'HaoYu Sullivan', family: 'both', born: 2070, died: 2093, status: 'planned', note: 'Anti-China club 2086. Killed by a Chinese drone 2093.' },
    { id: 'ch_neveah', name: 'Neveah Sullivan', family: 'both', born: 2072, status: 'idea', note: 'Adopted 2084. Pre-law 2090.' },
    { id: 'ch_john', name: 'John', family: 'both', born: 2095, status: 'idea', note: 'Neveah’s son. Forestory strand in Part Four.' },
    { id: 'ch_robb', name: 'Robb', family: null, status: 'idea', note: 'Sydney’s boyfriend. Birth year unknown.' },
    { id: 'ch_chaney', name: 'Chaney', family: null, born: 2037, status: 'planned', note: 'Mark’s high school girlfriend 2052 to 2054. Family in Maryland.' },
    // Li
    { id: 'ch_qin', name: 'Li Qin', zh: '勤', pinyin: 'Lǐ Qín', meaning: 'diligent', family: 'li', born: 2008, died: 2086, birthplace: 'Shandong', status: 'planned', note: 'Assembly line to foreman 2046, multiple factories 2064.' },
    { id: 'ch_siyuan', name: 'Li Siyuan', zh: '思源', pinyin: 'Sīyuán', meaning: 'remember the source', family: 'li', born: 2007, birthplace: 'Jinan', status: 'planned', note: 'Pure Land Buddhist from nine. Part Four is hers.' },
    { id: 'ch_xuan', name: 'Li Xuan', zh: '煊', pinyin: 'Xuān', meaning: 'warm, brilliant', family: 'li', born: 2033, status: 'planned', note: 'Cruel older brother. Tsinghua and the Party 2054. Cyber warfare.' },
    { id: 'ch_dawn', name: 'Li Dawn', zh: '晓曦', pinyin: 'Xiǎoxī', meaning: 'dawn light', family: 'both', born: 2037, bornDate: '2037-01-07', birthplace: 'Jinan, Shandong', status: 'canon', note: 'Reader, shy, religious studies then atheist. Marries Mark 2066.' },
    { id: 'ch_sichao', name: 'Li Sichao', zh: '思潮', pinyin: 'Sīcháo', meaning: 'train of thought', family: 'li', born: 2039, status: 'planned', note: 'Two years younger than Dawn. Coma at 36 for eight years.' },
    { id: 'ch_wangan', name: 'Wang’an', zh: '望安', pinyin: 'Wàng’ān', meaning: 'hoping for peace', family: 'li', born: 1980, status: 'idea', note: 'Dawn’s grandfather. Stock broker’s assistant.' },
    { id: 'ch_nianyou', name: 'Nian You', zh: '念忧', pinyin: 'Niànyōu', meaning: 'mindful of sorrow', family: 'li', status: 'idea', note: 'Dawn’s grandmother. Birth year unknown.' },
    { id: 'ch_guchu', name: 'Gu Chu', zh: '固伫', pinyin: 'Gùzhù', meaning: 'steadfast, standing long', family: null, status: 'idea', note: '“Uncle” from Qin’s factory. Moves in 2055.' },
  ];

  const families = [
    { id: 'sullivan', name: 'Sullivan', series: 1 },
    { id: 'li', name: '李 Li', series: 3 },
    { id: 'both', name: 'Sullivan and Li', series: 2 },
  ];

  // unions: type married | partnered | other
  const unions = [
    { id: 'un_frank_laura', a: 'ch_frank', b: 'ch_laura', type: 'married', start: 2029, end: 2037, endReason: 'death' },
    { id: 'un_qin_siyuan', a: 'ch_qin', b: 'ch_siyuan', type: 'married', start: 2033 },
    { id: 'un_mark_dawn', a: 'ch_mark', b: 'ch_dawn', type: 'married', start: 2066 },
    { id: 'un_emilie_darnell', a: 'ch_emilie', b: 'ch_darnell', type: 'married', start: 2062, end: 2095, endReason: 'separated' },
    { id: 'un_sydney_robb', a: 'ch_sydney', b: 'ch_robb', type: 'partnered', start: 2047, end: 2057 },
    { id: 'un_wangan_nianyou', a: 'ch_wangan', b: 'ch_nianyou', type: 'married' },
  ];

  // parent links: type biological | adoptive | step | guardian
  const parents = [
    ['ch_frank', 'ch_sydney'], ['ch_laura', 'ch_sydney'],
    ['ch_frank', 'ch_shannon'], ['ch_laura', 'ch_shannon'],
    ['ch_frank', 'ch_emilie'], ['ch_laura', 'ch_emilie'],
    ['ch_frank', 'ch_samantha'], ['ch_laura', 'ch_samantha'],
    ['ch_frank', 'ch_mark'], ['ch_laura', 'ch_mark'],
    ['ch_emilie', 'ch_matthew'],
    ['ch_emilie', 'ch_leon'], ['ch_darnell', 'ch_leon'],
    ['ch_mark', 'ch_lina'], ['ch_dawn', 'ch_lina'],
    ['ch_mark', 'ch_haoyu'], ['ch_dawn', 'ch_haoyu'],
    ['ch_mark', 'ch_neveah', 'adoptive', 2084], ['ch_dawn', 'ch_neveah', 'adoptive', 2084],
    ['ch_neveah', 'ch_john'],
    ['ch_qin', 'ch_xuan'], ['ch_siyuan', 'ch_xuan'],
    ['ch_qin', 'ch_dawn'], ['ch_siyuan', 'ch_dawn'],
    ['ch_qin', 'ch_sichao'], ['ch_siyuan', 'ch_sichao'],
    ['ch_wangan', 'ch_siyuan'], ['ch_nianyou', 'ch_siyuan'],
    ['ch_qin', 'ch_guchu', 'guardian', 2055],
  ].map((p, i) => ({ id: 'pl_' + i, parent: p[0], child: p[1], type: p[2] || 'biological', start: p[3] }));

  const eras = [
    { id: 'era_1', name: 'The automation divide opens', start: 2025, end: 2038, technology: 'Factory automation cheaper than labor (2025); humanoid robots beat human dexterity (2030); lights-out factories (2031).', climate: 'Grain prices spike in 2038 as the US basins strain.', economy: 'Shanghai overtakes New York (2032); Japan folds into China’s supply chain (2035); a Chinese property bubble pops (2035).', politics: 'AI-industrial fusion is Chinese national strategy (2027); Open Borders passes in the US (2034).', daily: 'VR schooling standard in Chinese cities (2037). Mass white-collar layoffs begin in the US (2031).' },
    { id: 'era_2', name: 'The hinge', start: 2039, end: 2039, technology: '', climate: 'The Mississippi and Colorado basins collapse in the same year.', economy: 'Markets halt; the Fed hikes into recession; Chinese state banks lend to US states.', politics: 'Washington cedes emergency authority to the states.', daily: 'Rolling blackouts across the Southwest; breadbasket states declare emergencies.' },
    { id: 'era_3', name: 'The first rally', start: 2040, end: 2049, technology: 'Chinese state AI overtakes Western labs in industry (2040); quantum codebreaking (2041).', climate: 'Mexico becomes a net food exporter to the US Southwest (2040).', economy: 'US rare-earth boom out of Nevada and Wyoming; robots outnumber China’s human factory workforce (2048).', politics: 'California, Oregon and Washington form the Pacific Coordination Framework (2048).', daily: 'Emergency federal insurance for climate-displaced families, never repealed.' },
    { id: 'era_4', name: 'The second descent', start: 2050, end: 2062, technology: 'Taiwan’s fabs folded into mainland ownership (2053); remote presence replaces business travel (2062).', climate: '', economy: 'Unified Credit displaces SWIFT (2052); the last US hardware venture fund moves to Shenzhen (2062).', politics: 'Undeclared economic world war (2051); Washington State signs its own deal with a Chinese province (2054).', daily: 'Reverse brain drain (2055) while status-conscious Chinese parents still send children to America.' },
    { id: 'era_5', name: 'The second crash', start: 2063, end: 2065, technology: '', climate: '', economy: 'US GDP contracts six straight quarters; three automated conglomerates nationalized.', politics: 'Single-payer, UBI and a National Curriculum Act pass as emergency law.', daily: 'New businesses need a social-utility certificate.' },
    { id: 'era_6', name: 'The second rally', start: 2066, end: 2072, technology: 'AI-designed chips for routine work; humans stay for novel architecture.', climate: '', economy: 'A protected robotics champion wins contracts back by 2068.', politics: 'A genuine third-force coalition wins with a spending-review reform (2066).', daily: 'Marriage and birth rates tick up for the first time in a generation.' },
    { id: 'era_7', name: 'Compact and standoff', start: 2073, end: 2076, technology: 'An autonomous port drone fires before any human can override it.', climate: '', economy: 'Federal accounting starts excluding the Compact’s shadow economy.', politics: 'Pacific States Compact (2073); Port of Los Angeles standoff (2075).', daily: 'A majority trust their state more than any federal institution by 2077.' },
    { id: 'era_8', name: 'The Compact matures', start: 2077, end: 2089, technology: 'Embryo-selected cohort reaches adulthood (2088).', climate: '', economy: 'More engineers immigrate to China than to the US (2081).', politics: 'Automation Council consolidates Beijing (2085); Texas Compact headed off (2086).', daily: 'A Compact-raised generation resents the dependency their parents accepted.' },
    { id: 'era_9', name: 'The final decade', start: 2090, end: 2100, technology: 'Port security systems work exactly as designed at Long Beach (2090).', climate: '', economy: 'A modest US manufacturing rebound narrows the gap, briefly.', politics: 'Japan’s Diet rejects political union (2091); the Compact petitions for Associate Member status (2100).', daily: '' },
  ];

  const events = [
    { id: 'ev_2025_auto', year: 2025, title: 'Factory automation becomes cheaper than human labor', category: 'Technology > Artificial Intelligence', region: 'World', real: false, formative: true },
    { id: 'ev_2026_drone', year: 2026, title: 'China stages a drone show flexing its automation lead', category: 'China: Industrial Capacity > Construction', region: 'China', real: false },
    { id: 'ev_2029_fab', year: 2029, title: 'Beijing announces a sub-3nm breakthrough; yields stay poor for years', category: 'Technology > Semiconductors', region: 'China', real: false },
    { id: 'ev_2029_nato', year: 2029, title: 'First AI-orchestrated cyberattack breaches a NATO command network', category: 'Technology > Cyber Warfare', region: 'Europe', real: false },
    { id: 'ev_2030_robots', year: 2030, title: 'Humanoid robots exceed human dexterity on the factory floor', category: 'Technology > Robotics', region: 'China', real: false },
    { id: 'ev_2031_lights', year: 2031, title: 'China’s factories go fully lights-out', category: 'China: Industrial Capacity > Manufacturing', region: 'China', real: false, formative: true },
    { id: 'ev_2031_layoffs', year: 2031, title: 'First wave of mass white-collar layoffs in the US', category: 'Financial Systems > Unemployment (US)', region: 'US', real: false },
    { id: 'ev_2032_shanghai', year: 2032, title: 'Shanghai overtakes New York as the largest exchange', category: 'Financial Systems > Chinese Markets', region: 'China', real: false },
    { id: 'ev_2034_borders', year: 2034, title: 'Congress passes the package known as Open Borders', category: 'US Domestic Policy > Immigration', region: 'US', real: false },
    { id: 'ev_2035_japan', year: 2035, title: 'Japanese manufacturers fold into China’s automated supply chain', category: 'Foreign Relations > China/Japan', region: 'Japan', real: false, formative: true },
    { id: 'ev_2035_bubble', year: 2035, title: 'A Chinese property and shadow-banking bubble pops; Frank helps the CIA document it', category: 'China: Industrial Capacity > Construction', region: 'China', real: false, characters: ['ch_frank'] },
    { id: 'ev_2036_fertility', year: 2036, title: 'US fertility falls below 1.3', category: 'Demographics > Fertility Rate: US', region: 'US', real: false },
    { id: 'ev_2037_hypersonic', year: 2037, title: 'China deploys hypersonic missiles; carrier doctrine is rethought', category: 'Military Dominance > Missile Technology', region: 'China', real: false },
    { id: 'ev_2039_water', year: 2039, title: 'The Mississippi and Colorado basins collapse in the same year', category: 'Resources > US: Water', region: 'US', real: false, formative: true },
    { id: 'ev_2039_states', year: 2039, title: 'Washington cedes emergency authority to the states', category: 'Geopolitics > US Leadership', region: 'US', real: false },
    { id: 'ev_2040_grain', year: 2040, title: 'China locks in multi-decade grain contracts with the US Midwest', category: 'Resources > China: Food Security', region: 'US', real: false },
    { id: 'ev_2041_navy', year: 2041, title: 'China’s navy becomes the largest in the world', category: 'Military Dominance > Naval Power', region: 'China', real: false },
    { id: 'ev_2044_rare', year: 2044, title: 'The US declares a rare-earth emergency, two decades too late', category: 'Resources > US: Critical Metals', region: 'US', real: false },
    { id: 'ev_2044_embryo', year: 2044, title: 'China legalizes embryo selection for cognitive traits', category: 'Technology > Biotech', region: 'China', real: false },
    { id: 'ev_2045_median', year: 2045, title: 'China’s median age passes 50', category: 'Demographics > Median Age: China', region: 'China', real: false },
    { id: 'ev_2047_africa', year: 2047, title: 'Beijing formalizes resources-for-welfare compacts across Africa', category: 'Geopolitics > Strategic Constraints', region: 'Africa', real: false },
    { id: 'ev_2048_pcf', year: 2048, title: 'California, Oregon and Washington form the Pacific Coordination Framework', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false, formative: true, places: ['pl_sf'] },
    { id: 'ev_2048_robots', year: 2048, title: 'China’s robot population surpasses its human factory workforce', category: 'Technology > Robotics', region: 'China', real: false },
    { id: 'ev_2051_war', year: 2051, title: 'Undeclared economic world war', category: 'Pressure Gauges > US/China Tension', region: 'World', real: false, formative: true },
    { id: 'ev_2052_credit', year: 2052, title: 'Unified Credit displaces SWIFT for half of world trade', category: 'Financial Systems > Banks', region: 'World', real: false, formative: true },
    { id: 'ev_2053_taiwan', year: 2053, title: 'Taiwan joins the Pacific Coordination Framework rather than risk invasion', category: 'Foreign Relations > China/Taiwan', region: 'Taiwan', real: false, formative: true },
    { id: 'ev_2054_wa', year: 2054, title: 'Washington State signs its own deal with a Chinese province', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false },
    { id: 'ev_2055_drain', year: 2055, title: 'Reverse brain drain begins', category: 'Demographics > Brain Drain', region: 'World', real: false },
    { id: 'ev_2057_resources', year: 2057, title: 'China’s growth depends on resources and markets it administers directly', category: 'Geopolitics > Strategic Constraints', region: 'China', real: false },
    { id: 'ev_2058_japan', year: 2058, title: 'Japan joins the Pacific Coordination Framework', category: 'Foreign Relations > China/Japan', region: 'Japan', real: false },
    { id: 'ev_2062_vc', year: 2062, title: 'The last US hardware venture fund relocates to Shenzhen', category: 'Financial Systems > Venture Capital', region: 'US', real: false },
    { id: 'ev_2063_depression', year: 2063, title: 'US depression: six quarters of contraction', category: 'Financial Systems > GDP', region: 'US', real: false, formative: true },
    { id: 'ev_2064_ubi', year: 2064, title: 'Federal UBI and single-payer pass as emergency law', category: 'US Domestic Policy > Social Welfare', region: 'US', real: false },
    { id: 'ev_2066_coalition', year: 2066, title: 'A third-force coalition wins with a spending-review reform', category: 'Geopolitics > US Leadership', region: 'US', real: false },
    { id: 'ev_2070_africa', year: 2070, title: 'Chinese-built factories in Africa outproduce the continent’s prior decade', category: 'China: Industrial Capacity > Manufacturing', region: 'Africa', real: false },
    { id: 'ev_2073_compact', year: 2073, title: 'The Pacific States Compact binds the three states as one bloc', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false, formative: true },
    { id: 'ev_2075_port', year: 2075, title: 'Port of Los Angeles standoff; an autonomous drone fires first', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false, formative: true, places: ['pl_la'] },
    { id: 'ev_2081_engineers', year: 2081, title: 'More engineers immigrate to China than to the US', category: 'Demographics > Brain Drain', region: 'World', real: false },
    { id: 'ev_2085_council', year: 2085, title: 'Beijing folds Party secretaries into a single Automation Council', category: 'Geopolitics > Chinese Leadership', region: 'China', real: false },
    { id: 'ev_2086_texas', year: 2086, title: 'Texas floats its own compact; Washington heads it off', category: 'Geopolitics > US Leadership', region: 'US', real: false },
    { id: 'ev_2088_cohort', year: 2088, title: 'The embryo-selected cohort reaches adulthood', category: 'Technology > Biotech', region: 'China', real: false },
    { id: 'ev_2090_longbeach', year: 2090, title: 'A plot against Long Beach port infrastructure is stopped by autonomous security', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false, formative: true, places: ['pl_la'] },
    { id: 'ev_2091_diet', year: 2091, title: 'Japan’s Diet rejects political union with the PCF', category: 'Geopolitics > Japanese Leadership', region: 'Japan', real: false },
    { id: 'ev_2100_assoc', year: 2100, title: 'The Compact petitions for Associate Member status', category: 'Foreign Relations > Pacific States Compact', region: 'US', real: false },
  ];

  const places = [
    { id: 'pl_sf', name: 'San Francisco', parent: null, community: 'San Francisco', descriptions: [{ start: 2034, end: 2048, text: 'The Sullivan home. Enormous skyscrapers Laura calls Babel.' }, { start: 2048, end: 2075, text: 'A PCF city: Chinese credit in the schools, kids debating whether California should follow Oregon.' }] },
    { id: 'pl_jinan', name: 'Jinan', parent: 'pl_shandong', community: 'Jinan / Shandong', descriptions: [{ start: 2030, end: 2046, text: 'A shrine by a stream. A drone-factory town with an apartment that gets dirty when the parties start.' }, { start: 2046, end: 2066, text: 'Qin’s parties draw local officials. Gu Chu moves in.' }] },
    { id: 'pl_shandong', name: 'Shandong', parent: null, community: 'Jinan / Shandong', descriptions: [] },
    { id: 'pl_usc', name: 'USC, Los Angeles', parent: 'pl_la', community: 'San Francisco', descriptions: [{ start: 2055, end: 2062, text: 'Sweaty parties, cheap beer, the economy at an all-time low.' }] },
    { id: 'pl_la', name: 'Los Angeles', parent: null, community: 'San Francisco', descriptions: [{ start: 2075, end: 2075, text: 'The port standoff.' }] },
    { id: 'pl_sanjose', name: 'San Jose', parent: null, community: 'San Francisco', descriptions: [{ start: 2070, end: 2091, text: 'Where Mark and Dawn raise LiNa and HaoYu after the break with Frank.' }] },
    { id: 'pl_seattle', name: 'Seattle', parent: null, community: 'San Francisco', descriptions: [{ start: 2091, end: 2100, text: 'The city that set the Compact precedent in 2054.' }] },
    { id: 'pl_reno', name: 'Reno', parent: null, community: 'San Francisco', descriptions: [{ start: 2000, end: 2018, text: 'Frank’s childhood home. Day trading and philosophy sessions.' }] },
  ];

  const cultural = [
    { id: 'cu_1', community: 'San Francisco', start: 2040, end: 2060, title: 'Evangelical church as family glue', text: 'Mission trips to Tijuana over spring break; proverbs as parenting; youth group as the only community that seems to care for its own.' },
    { id: 'cu_2', community: 'San Francisco', start: 2050, end: 2075, title: 'High-school politics', text: 'Hall conversations about whether California should follow Oregon into deals with China. Kids know the word Compact before they know calculus.' },
    { id: 'cu_3', community: 'Jinan / Shandong', start: 2040, end: 2066, title: 'Status parties', text: 'A foreman throws lavish parties to draw local officials; his wife plans every one and calls it chasing after the wind.' },
    { id: 'cu_4', community: 'Jinan / Shandong', start: 2050, end: 2070, title: 'Sending a child to America', text: 'By 2055 the engineers are coming home, but status-conscious parents still send daughters to USC. Qin picks Dawn because she is “the most white.”' },
    { id: 'cu_5', community: 'Jinan / Shandong', start: 2016, end: 2100, title: 'Pure Land practice at home', text: 'Refuge at morning and night, a home shrine, abstaining from the desires of the world, 饮水思源 as a family motto.' },
    { id: 'cu_6', community: 'Chinese diaspora in California', start: 2066, end: 2100, title: 'Mixed households', text: 'Chinese names in an American family; Frank rants about China at Dawn across the table.' },
  ];

  const glossary = [
    { id: 'gl_li', zh: '李', pinyin: 'Lǐ', lang: 'Mandarin', meaning: 'Plum; the family name Li.' },
    { id: 'gl_qin', zh: '勤', pinyin: 'Qín', lang: 'Mandarin', meaning: 'Diligent, hard-working. Dawn’s father.' },
    { id: 'gl_siyuan', zh: '思源', pinyin: 'Sīyuán', lang: 'Mandarin', meaning: 'From 饮水思源: when you drink water, remember its source.' },
    { id: 'gl_xuan', zh: '煊', pinyin: 'Xuān', lang: 'Mandarin', meaning: 'Warm, brilliant, dazzling.' },
    { id: 'gl_xiaoxi', zh: '晓曦', pinyin: 'Xiǎoxī', lang: 'Mandarin', meaning: 'Dawn light. Dawn’s Chinese name.' },
    { id: 'gl_sichao', zh: '思潮', pinyin: 'Sīcháo', lang: 'Mandarin', meaning: 'A train of thought; a trend of thought.' },
    { id: 'gl_qifengle', zh: '起风了', pinyin: 'qǐ fēng le', lang: 'Mandarin', meaning: 'The wind rises. The last line of the introduction.' },
    { id: 'gl_yinshui', zh: '饮水思源', pinyin: 'yǐn shuǐ sī yuán', lang: 'Mandarin', meaning: 'When you drink water, think of its source.' },
    { id: 'gl_wangan', zh: '望安', pinyin: 'Wàng’ān', lang: 'Mandarin', meaning: 'Hoping for peace. Dawn’s grandfather.' },
  ];

  const arcs = [
    { id: 'arc_book', name: 'Whole book', scope: 'book', start: 2000, end: 2100 },
    { id: 'arc_sullivan', name: 'Sullivan family', scope: 'family', family: 'sullivan', start: 2000, end: 2100 },
    { id: 'arc_li', name: 'Li family', scope: 'family', family: 'li', start: 2007, end: 2100 },
    { id: 'arc_mark_college', name: 'Mark: College Arc', owner: 'ch_mark', start: 2055, end: 2059, chapters: ['chp_1_1', 'chp_1_2', 'chp_1_3'] },
    { id: 'arc_mark_compromise', name: 'Mark: Compromise Arc', owner: 'ch_mark', start: 2059, end: 2067, chapters: ['chp_1_4', 'chp_1_5', 'chp_1_6'] },
    { id: 'arc_mark_family', name: 'Mark: Family Arc', owner: 'ch_mark', start: 2067, end: 2071, chapters: ['chp_1_7', 'chp_1_8', 'chp_1_9'] },
    { id: 'arc_mark_counsel', name: 'Mark: Counseling Career Arc', owner: 'ch_mark', start: 2071, end: 2076, chapters: ['chp_1_10', 'chp_1_11', 'chp_1_12'] },
    { id: 'arc_dawn_college', name: 'Dawn: College Arc', owner: 'ch_dawn', start: 2056, end: 2060, chapters: ['chp_2_1', 'chp_2_2', 'chp_2_3'] },
    { id: 'arc_dawn_american', name: 'Dawn: American Arc', owner: 'ch_dawn', start: 2060, end: 2066, chapters: ['chp_2_4', 'chp_2_5', 'chp_2_6'] },
    { id: 'arc_dawn_philosophy', name: 'Dawn: Philosophy Arc', owner: 'ch_dawn', start: 2066, end: 2076, chapters: ['chp_2_7', 'chp_2_8', 'chp_2_9'] },
    { id: 'arc_dawn_reconnect', name: 'Dawn: Reconnect Arc', owner: 'ch_dawn', start: 2076, end: 2084, chapters: ['chp_2_10', 'chp_2_11', 'chp_2_12'] },
    { id: 'arc_frank_legacy', name: 'Frank: Legacy Arc', owner: 'ch_frank', start: 2073, end: 2077, chapters: ['chp_3_1', 'chp_3_2', 'chp_3_3'] },
    { id: 'arc_frank_family', name: 'Frank: Family Arc', owner: 'ch_frank', start: 2077, end: 2082, chapters: ['chp_3_4', 'chp_3_5', 'chp_3_6'] },
    { id: 'arc_frank_china', name: 'Frank: China Arc', owner: 'ch_frank', start: 2082, end: 2084, chapters: ['chp_3_7', 'chp_3_8', 'chp_3_9'] },
    { id: 'arc_grief', name: 'Mark and Dawn: Grief', owner: 'ch_mark', start: 2084, end: 2090, chapters: ['chp_3_10', 'chp_3_11', 'chp_3_12'] },
    { id: 'arc_siyuan_early', name: 'Siyuan: Early Buddhism', owner: 'ch_siyuan', start: 2009, end: 2030, chapters: ['chp_4_1', 'chp_4_2', 'chp_4_3'] },
    { id: 'arc_siyuan_mother', name: 'Siyuan: Motherhood', owner: 'ch_siyuan', start: 2030, end: 2056, chapters: ['chp_4_4', 'chp_4_5', 'chp_4_6'] },
    { id: 'arc_siyuan_deter', name: 'Siyuan: Deterioration', owner: 'ch_siyuan', start: 2056, end: 2074, chapters: ['chp_4_7', 'chp_4_8', 'chp_4_9'] },
    { id: 'arc_siyuan_lost', name: 'Siyuan: Lost Years', owner: 'ch_siyuan', start: 2074, end: 2096, chapters: ['chp_4_10', 'chp_4_11', 'chp_4_12'] },
  ];

  // Chapters: Book One, four parts, each chapter with a present strand and a backstory strand.
  // Years come from the High Level sheet; a chapter with no year row inherits its trio's arc span.
  function chp(part, n, title, present, back, pov, written, extra) {
    return Object.assign({ id: `chp_${part}_${n}`, part: `part_${part}`, order: (part - 1) * 12 + n, title, pov, written: !!written,
      strands: [
        { id: `chp_${part}_${n}_s1`, label: present.label, primary: true, year: present.year, pov: present.pov || pov, present: present.cast || [] },
        { id: `chp_${part}_${n}_s2`, label: back.label, primary: false, year: back.year, pov: back.pov || pov, present: back.cast || [] },
      ] }, extra || {});
  }
  const parts = [
    { id: 'part_1', book: 'Book One', number: 1, title: 'Sins of the Father', summary: 'Deep dive on Mark in college and as a father, interpolated with Frank.' },
    { id: 'part_2', book: 'Book One', number: 2, title: 'Lost Spirits', summary: 'Dawn’s spiritual reckoning, Siyuan’s hidden struggles, China background.' },
    { id: 'part_3', book: 'Book One', number: 3, title: 'Inheritance', summary: 'Qin building a family, Frank deciding where his money goes, old Mark.' },
    { id: 'part_4', book: 'Book One', number: 4, title: 'Circulation', summary: 'Siyuan’s book, with forestory strands reaching to John.' },
    { id: 'part_5', book: 'Book Two: I Take Refuge in You', number: 5, title: 'Claws Come Out', summary: 'Planned.' },
  ];
  const chapters = [
    chp(1, 1, 'Mark Feels Free', { label: 'Mark: College Arc', year: 2055, cast: ['ch_mark'] }, { label: 'Backstory: High School', year: 2051, cast: ['ch_mark', 'ch_frank', 'ch_emilie'] }, 'ch_mark', true, { summary: 'Mark arrives at USC with the economy at an all-time low and relishes the chance to reinvent himself.', status: 'canon' }),
    chp(1, 2, 'Mark Meets Dawn', { label: 'Mark: College Arc', year: 2056, cast: ['ch_mark', 'ch_dawn'], pov: 'ch_mark' }, { label: 'Backstory: High School', year: 2052, cast: ['ch_mark', 'ch_chaney'] }, 'ch_mark', true, { summary: 'A drunken hand extended at a party. “Mark from Marketing.” Angels shout for joy.', status: 'canon', inProgress: true }),
    chp(1, 3, 'Mark Gets Drunk', { label: 'Mark: College Arc', year: 2057, cast: ['ch_mark', 'ch_dawn'] }, { label: 'Backstory: High School', year: 2053, cast: ['ch_mark', 'ch_frank'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 4, 'Mark Can’t Work', { label: 'Mark: Compromise Arc', year: 2060, cast: ['ch_mark', 'ch_frank'] }, { label: 'Backstory: Sullivan Family Drama', year: 2047, cast: ['ch_frank', 'ch_sydney', 'ch_shannon', 'ch_emilie', 'ch_mark'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 5, 'Mark at Home', { label: 'Mark: Compromise Arc', year: 2061, cast: ['ch_mark', 'ch_frank'] }, { label: 'Backstory: Sullivan Family Drama', year: 2048, cast: ['ch_emilie', 'ch_frank', 'ch_sydney'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 6, 'Mark in Marketing', { label: 'Mark: Compromise Arc', year: 2063, cast: ['ch_mark', 'ch_dawn'] }, { label: 'Backstory: Sullivan Family Drama', year: 2049, cast: ['ch_emilie', 'ch_matthew', 'ch_mark'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 7, 'Mark and Dawn', { label: 'Mark: Family Arc', year: 2067, cast: ['ch_mark', 'ch_dawn', 'ch_frank'] }, { label: 'Backstory: Trauma from Birth', year: 2038, cast: ['ch_frank', 'ch_mark', 'ch_sydney', 'ch_shannon'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 8, 'LiNa and Anxiety', { label: 'Mark: Family Arc', year: 2069, cast: ['ch_mark', 'ch_dawn', 'ch_lina', 'ch_frank'] }, { label: 'Backstory: Trauma from Birth', year: 2040, cast: ['ch_frank', 'ch_mark'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 9, 'HaoYu and Family Break', { label: 'Mark: Family Arc', year: 2070, cast: ['ch_mark', 'ch_dawn', 'ch_haoyu', 'ch_frank'] }, { label: 'Backstory: Trauma from Birth', year: 2041, cast: ['ch_frank', 'ch_mark'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 10, 'Mark and Research', { label: 'Mark: Counseling Career Arc', year: 2071, cast: ['ch_mark'] }, { label: 'Backstory: Family Narrative', year: 2029, cast: ['ch_frank', 'ch_laura'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 11, 'Mark and Emilie', { label: 'Mark: Counseling Career Arc', year: 2074, cast: ['ch_mark', 'ch_emilie'] }, { label: 'Backstory: Family Narrative', year: 2032, cast: ['ch_frank', 'ch_laura'] }, 'ch_mark', false, { status: 'planned' }),
    chp(1, 12, 'Mark On Two Feet', { label: 'Mark: Counseling Career Arc', year: 2075, cast: ['ch_mark', 'ch_dawn'] }, { label: 'Backstory: Family Narrative', year: 2034, cast: ['ch_frank', 'ch_laura'] }, 'ch_mark', false, { status: 'planned' }),
    chp(2, 1, 'Dawn is Shy', { label: 'Dawn: College Arc', year: 2056, cast: ['ch_dawn', 'ch_mark'] }, { label: 'Backstory: High School', year: 2052, cast: ['ch_dawn', 'ch_siyuan'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 2, 'Dawn is Slutty', { label: 'Dawn: College Arc', year: 2057, cast: ['ch_dawn'] }, { label: 'Backstory: High School', year: 2053, cast: ['ch_dawn', 'ch_xuan'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 3, 'Dawn is Human', { label: 'Dawn: College Arc', year: 2059, cast: ['ch_dawn', 'ch_mark'] }, { label: 'Backstory: High School', year: 2055, cast: ['ch_dawn', 'ch_guchu', 'ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 4, 'Dawn Likes Things', { label: 'Dawn: American Arc', year: 2060, cast: ['ch_dawn', 'ch_mark'] }, { label: 'Backstory: Childhood', year: 2043, cast: ['ch_dawn', 'ch_sichao', 'ch_xuan', 'ch_siyuan'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 5, 'Dawn Has Things', { label: 'Dawn: American Arc', year: 2063, cast: ['ch_dawn', 'ch_qin', 'ch_siyuan'] }, { label: 'Backstory: Childhood', year: 2046, cast: ['ch_dawn', 'ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 6, 'Dawn Misses Home', { label: 'Dawn: American Arc', year: 2064, cast: ['ch_dawn', 'ch_siyuan'] }, { label: 'Backstory: Childhood', year: 2049, cast: ['ch_dawn', 'ch_xuan', 'ch_sichao'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 7, 'Dawn in the World', { label: 'Dawn: Philosophy Arc', year: 2066, cast: ['ch_dawn', 'ch_mark'] }, { label: 'Backstory: Family Narrative', year: 2035, cast: ['ch_qin', 'ch_siyuan'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 8, 'Dawn in the Clouds', { label: 'Dawn: Philosophy Arc', year: 2070, cast: ['ch_dawn'] }, { label: 'Backstory: Family Narrative', year: 2037, cast: ['ch_siyuan', 'ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 9, 'Dawn Marries Her Life', { label: 'Dawn: Philosophy Arc', year: 2075, cast: ['ch_dawn', 'ch_mark'] }, { label: 'Backstory: Family Narrative', year: 2039, cast: ['ch_siyuan', 'ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 10, 'Dawn and Siyuan', { label: 'Dawn: Reconnect Arc', year: 2079, cast: ['ch_dawn', 'ch_siyuan'] }, { label: 'Backstory: Family Narrative Reconsidered', year: 2029, cast: ['ch_siyuan'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 11, 'Dawn and Qin', { label: 'Dawn: Reconnect Arc', year: 2081, cast: ['ch_dawn', 'ch_qin', 'ch_frank'] }, { label: 'Backstory: Family Narrative Reconsidered', year: 2032, cast: ['ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(2, 12, 'Dawn and Xuan', { label: 'Dawn: Reconnect Arc', year: 2083, cast: ['ch_dawn', 'ch_xuan', 'ch_sichao'] }, { label: 'Backstory: Family Narrative Reconsidered', year: 2033, cast: ['ch_siyuan', 'ch_qin'] }, 'ch_dawn', false, { status: 'planned' }),
    chp(3, 1, 'Frank’s Piles of Money', { label: 'Frank: Legacy Arc', year: 2073, cast: ['ch_frank'] }, { label: 'Backstory: Mark Fucking Around', year: 2059, cast: ['ch_mark', 'ch_frank'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 2, 'Mark Isn’t The Answer', { label: 'Frank: Legacy Arc', year: 2074, cast: ['ch_frank', 'ch_mark'] }, { label: 'Backstory: Mark Fucking Around', year: 2061, cast: ['ch_mark'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 3, 'Frank Gives His Soul Back', { label: 'Frank: Legacy Arc', year: 2076, cast: ['ch_frank', 'ch_shannon', 'ch_mark', 'ch_lina', 'ch_haoyu'] }, { label: 'Backstory: Mark Fucking Around', year: 2064, cast: ['ch_mark', 'ch_frank', 'ch_dawn'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 4, 'Frank’s Second Chance', { label: 'Frank: Family Arc', year: 2077, cast: ['ch_frank', 'ch_lina'] }, { label: 'Backstory: Hard Earned Success', year: 2040, cast: ['ch_frank'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 5, 'Iron Sharpens Frank', { label: 'Frank: Family Arc', year: 2080, cast: ['ch_frank', 'ch_lina'] }, { label: 'Backstory: Hard Earned Success', year: 2044, cast: ['ch_frank', 'ch_sydney'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 6, 'Heartbreak Reappears', { label: 'Frank: Family Arc', year: 2081, cast: ['ch_frank', 'ch_mark', 'ch_dawn'] }, { label: 'Backstory: Hard Earned Success', year: 2052, cast: ['ch_frank'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 7, 'Frank Goes to China', { label: 'Frank: China Arc', year: 2082, cast: ['ch_frank', 'ch_dawn', 'ch_qin'] }, { label: 'Backstory: Life is Pain, China & CIA', year: 2030, cast: ['ch_frank', 'ch_laura'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 8, 'Frank and Qin', { label: 'Frank: China Arc', year: 2082, cast: ['ch_frank', 'ch_qin', 'ch_siyuan'] }, { label: 'Backstory: Life is Pain, China & CIA', year: 2035, cast: ['ch_frank'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 9, 'Detainment', { label: 'Frank: China Arc', year: 2083, cast: ['ch_frank', 'ch_xuan', 'ch_dawn'] }, { label: 'Backstory: Life is Pain, China & CIA', year: 2044, cast: ['ch_frank'] }, 'ch_frank', false, { status: 'planned' }),
    chp(3, 10, 'Inheritance', { label: 'Mark and Dawn: Grief', year: 2084, cast: ['ch_mark', 'ch_dawn', 'ch_neveah'] }, { label: 'Backstory: Frank’s Father', year: 2012, cast: ['ch_frank'] }, 'ch_mark', false, { status: 'planned' }),
    chp(3, 11, 'Neveah', { label: 'Mark and Dawn: Grief', year: 2086, cast: ['ch_mark', 'ch_dawn', 'ch_neveah'] }, { label: 'Backstory: Frank’s Father', year: 2016, cast: ['ch_frank'] }, 'ch_mark', false, { status: 'planned' }),
    chp(3, 12, 'A Life Well Lived', { label: 'Mark and Dawn: Grief', year: 2090, cast: ['ch_mark', 'ch_dawn'] }, { label: 'Backstory: Frank’s Father', year: 2018, cast: ['ch_frank'] }, 'ch_mark', false, { status: 'planned' }),
    chp(4, 1, 'Attachments', { label: 'Siyuan: Early Buddhism', year: 2009, cast: ['ch_siyuan'] }, { label: 'Forestory: Kids', year: 2076, cast: ['ch_siyuan', 'ch_dawn', 'ch_lina', 'ch_haoyu'] }, 'ch_siyuan', false, { status: 'idea' }),
    chp(4, 4, 'Siyuan & the Earth', { label: 'Siyuan: Motherhood', year: 2030, cast: ['ch_siyuan', 'ch_qin'] }, { label: 'Forestory: Grandkids', year: 2084, cast: ['ch_siyuan', 'ch_neveah'] }, 'ch_siyuan', false, { status: 'idea' }),
    chp(4, 7, 'Siyuan Loses Herself', { label: 'Siyuan: Deterioration', year: 2056, cast: ['ch_siyuan', 'ch_dawn'] }, { label: 'Forestory: Neveah', year: 2091, cast: ['ch_siyuan', 'ch_neveah'] }, 'ch_siyuan', false, { status: 'idea' }),
    chp(4, 10, 'O Death', { label: 'Siyuan: Lost Years', year: 2074, cast: ['ch_siyuan', 'ch_qin'] }, { label: 'Forestory: John', year: 2096, cast: ['ch_siyuan', 'ch_john', 'ch_neveah'] }, 'ch_siyuan', false, { status: 'idea' }),
  ];

  const beats = [
    { id: 'bt_1', year: 2055, pov: 'ch_mark', arc: 'arc_mark_college', chapter: 'chp_1_1', text: 'Mark goes to school, economy is at an all time low', world: 'Reverse brain drain begins.', experience: 'Starts college into an economy the reverse brain drain is already quietly draining.' },
    { id: 'bt_2', year: 2056, pov: 'ch_mark', arc: 'arc_mark_college', chapter: 'chp_1_2', text: 'Mark meets Dawn; they don’t fall in love right away, and Mark isn’t sure because she’s not Christian', world: 'A quiet year between the brain drain and China’s resource pivot.', experience: 'Meets his future wife in a year the world barely notices.' },
    { id: 'bt_3', year: 2052, pov: 'ch_mark', arc: 'arc_mark_college', chapter: 'chp_1_2', text: 'Mark goes to Homecoming with Chaney', world: 'Unified Credit launches.', experience: 'A small, ordinary teenage milestone the same year the dollar’s authority cracks.' },
    { id: 'bt_4', year: 2060, pov: 'ch_mark', arc: 'arc_mark_compromise', chapter: 'chp_1_4', text: 'Mark can’t find a job, things get rough, moves in with Frank', world: 'Beijing’s welfare-and-freedom model starts getting studied abroad.', experience: 'Fails to launch the year other governments admire a floor Mark does not have.' },
    { id: 'bt_5', year: 2061, pov: 'ch_mark', arc: 'arc_mark_compromise', chapter: 'chp_1_5', text: 'Mark drinks a lot', world: 'China becomes the top destination for skilled migrants.', experience: 'Going nowhere, watching a country going everywhere.' },
    { id: 'bt_6', year: 2064, pov: 'ch_mark', arc: 'arc_mark_compromise', chapter: null, text: 'Mark and Frank have it out about Dawn', world: 'UBI and single-payer pass.', experience: 'Both arguments about who gets counted and how.' },
    { id: 'bt_7', year: 2066, pov: 'ch_mark', arc: 'arc_mark_family', chapter: 'chp_1_7', text: 'Mark marries Dawn', world: 'A third-force coalition wins.', experience: 'Marries across the exact fault line a new coalition is trying to resolve.' },
    { id: 'bt_8', year: 2047, pov: 'ch_sydney', arc: 'arc_sullivan', chapter: 'chp_1_4', text: 'Sydney and Frank have it out about Christianity; she doesn’t go on the mission trip', world: 'Beijing formalizes resources-for-welfare compacts in Africa.', experience: 'Power always has a price.' },
    { id: 'bt_9', year: 2048, pov: 'ch_emilie', arc: 'arc_sullivan', chapter: 'chp_1_5', text: 'Emilie gets pregnant, goes to an abortion clinic but doesn’t go through with it; tells Frank', world: 'The Pacific Coordination Framework forms.', experience: 'A private commitment nobody expected her to keep.' },
    { id: 'bt_10', year: 2063, pov: 'ch_dawn', arc: 'arc_dawn_american', chapter: 'chp_2_5', text: 'Dawn selects Religious Studies as her major', world: 'The US depression hits.', experience: 'Choosing meaning as the country loses its footing.' },
    { id: 'bt_11', year: 2064, pov: 'ch_dawn', arc: 'arc_dawn_american', chapter: 'chp_2_6', text: 'Dawn decides she’s atheist', world: 'Emergency legislation creates no jobs.', experience: 'Lands on atheism as Washington’s answers fail too.' },
    { id: 'bt_12', year: 2046, pov: 'ch_qin', arc: 'arc_li', chapter: 'chp_2_5', text: 'Qin becomes foreman', world: 'China lands on the far side of the Moon.', experience: '' },
    { id: 'bt_13', year: 2049, pov: 'ch_siyuan', arc: 'arc_li', chapter: 'chp_2_6', text: 'Xuan terrorizes Dawn', world: 'Skilled migration reverses direction.', experience: 'Family cruelty and global realignment, both quietly happening.' },
    { id: 'bt_14', year: 2082, pov: 'ch_frank', arc: 'arc_frank_china', chapter: 'chp_3_7', text: 'Frank goes to China to bring Dawn back', world: 'More engineers immigrate to China than to the US.', experience: 'Frank feeling the same pull the rest of the country’s talent feels.' },
  ];

  const facts = [
    { id: 'fc_cia', title: 'Frank helped the CIA document China’s inflated markets in 2035', status: 'planned', knowledge: [{ who: 'ch_frank', year: 2035, how: 'Did it.' }, { who: 'ch_laura', year: 2035, how: 'Frank told her.' }, { who: 'ch_dawn', year: 2081, chapter: 'chp_2_11', how: 'Qin tells her in Jinan.' }] },
    { id: 'fc_sepsis', title: 'Laura died of a missed sepsis, not childbirth itself', status: 'planned', knowledge: [{ who: 'ch_frank', year: 2037, how: 'Was there.' }, { who: 'ch_sydney', year: 2037, how: 'Was seven, saw it.' }, { who: 'ch_mark', year: 2054, chapter: 'chp_1_3', how: 'Frank tells him on a hike.' }] },
    { id: 'fc_accident', title: 'Frank was an accident; his parents told him so', status: 'planned', knowledge: [{ who: 'ch_frank', year: 2016, how: 'Asked them.' }] },
    { id: 'fc_sichao', title: 'Xuan’s rivals orchestrated Sichao’s accident', status: 'planned', knowledge: [{ who: 'ch_xuan', year: 2075, how: 'Knew.' }, { who: 'ch_dawn', year: 2083, chapter: 'chp_2_12', how: 'Learns it in Jinan.' }, { who: 'ch_sichao', year: 2084, how: 'Dawn tells her after the coma.' }] },
    { id: 'fc_clinic', title: 'Emilie went to an abortion clinic in 2048', status: 'planned', knowledge: [{ who: 'ch_emilie', year: 2048, how: 'Went.' }, { who: 'ch_frank', year: 2048, how: 'She tells him.' }, { who: 'ch_mark', year: 2049, how: 'Overhears.' }] },
    { id: 'fc_atheist', title: 'Dawn decided she is atheist in 2064', status: 'planned', knowledge: [{ who: 'ch_dawn', year: 2064, how: 'Decided.' }, { who: 'ch_mark', year: 2064, how: 'She tells him.' }, { who: 'ch_siyuan', year: 2079, chapter: 'chp_2_10', how: 'Dawn tells her.' }] },
  ];

  const themes = [
    { id: 'th_wind', name: 'The east wind', appearances: [{ chapter: 'chp_intro', note: '起风了 on the mountain.' }] },
    { id: 'th_job', name: 'The Book of Job', appearances: [{ chapter: 'chp_1_1', note: 'Chapter title from Job 38:4; the morning stars sing (38:7).' }, { chapter: 'chp_intro', note: '“There is a mine for silver” (Job 28).' }] },
    { id: 'th_lostarts', name: 'Lost arts', appearances: [{ chapter: 'chp_1_1', note: 'Mark draws; Darnell animates by hand.' }] },
    { id: 'th_babel', name: 'Babel', appearances: [{ chapter: 'chp_1_10', note: 'Laura on the skyscrapers.' }] },
    { id: 'th_machines', name: 'Machines that fire first', appearances: [{ chapter: 'chp_3_12', note: '2075, 2090, 2093.' }] },
  ];

  const openQuestions = [
    { id: 'oq_dawn_birth', state: 'open', question: 'Dawn’s birth year: 2037 (Dawn’s Life, Sep 4), 2039 (World.xlsx, Aug 23), or 2043 (Google Sheet, Jul 20)? 2037 makes her Mark’s age and 20 at USC.', links: ['ch_dawn'], source: 'Importer conflict (IM-7)' },
    { id: 'oq_xuan_birth', state: 'open', question: 'Xuan’s birth year: 2033 (World.xlsx) or 2036 (older sheets)? Tsinghua at 2054 and “Deputy Director at 22” fit 2036.', links: ['ch_xuan'], source: 'Importer conflict (IM-7)' },
    { id: 'oq_laura_41', state: 'open', question: 'Laura dies at 39 but has a philosophy written “at 41”. Which gives?', links: ['ch_laura'], source: 'East Winds doc' },
    { id: 'oq_frank_inherit', state: 'open', question: 'Frank inherits at 55 from parents who were broke or dead by 2029. Where does the money come from?', links: ['ch_frank'], source: 'East Winds doc vs Frank’s Life' },
    { id: 'oq_mission', state: 'decided', question: 'Mission trip 2041 or 2043?', decision: '2043, per the newest sheet.', links: ['ch_frank'], source: 'Importer conflict (IM-7)' },
    { id: 'oq_lina_zh', state: 'open', question: 'Chinese characters for LiNa and HaoYu?', links: ['ch_lina', 'ch_haoyu'], source: 'Gap' },
  ];

  const sessionLog = [
    { id: 'sl_3', date: '2026-10-10', chapter: 'chp_1_2', stopped: 'Mark’s hand moves up to Dawn’s face. Next: the morning after, and whether she stays.', note: 'Chapter 1 needs Dawn’s age settled before the dorm scene.' },
    { id: 'sl_2', date: '2026-10-08', chapter: 'chp_1_1', stopped: 'Finished the party intro; “Mark from Marketing” landed.', note: '' },
    { id: 'sl_1', date: '2026-09-04', chapter: 'chp_intro', stopped: 'Introduction drafted on the mountain. Who is the man? Frank, 2082?', note: 'Keep 起风了 as the hinge line.' },
  ];

  // helpers used by every mockup
  function byId(list, id) { return list.find(x => x.id === id); }
  function ageIn(c, year) {
    if (c.born == null) return { state: 'unknown' };
    if (year < c.born) return { state: 'unborn' };
    if (c.died != null && year > c.died) return { state: 'dead', diedYear: c.died };
    const age = year - c.born;
    return { state: 'alive', age, dyingThisYear: c.died === year };
  }
  function eraFor(year) { return eras.find(e => year >= e.start && year <= e.end) || null; }
  function eventsUpTo(year, window) { return events.filter(e => e.year <= year && (window == null || e.year > year - window)).sort((a, b) => a.year - b.year); }
  function familySeries(fam) { return (families.find(f => f.id === fam) || { series: 4 }).series; }
  function displayName(c) { return c.zh ? `${c.name} ${c.zh}` : c.name; }
  function zhSpan(c) { return c.zh ? `<span class="zh" tabindex="0" data-pinyin="${c.pinyin}" data-meaning="${c.meaning}">${c.zh}</span>` : ''; }

  return { characters, families, unions, parents, eras, events, places, cultural, glossary, arcs, parts, chapters, beats, facts, themes, openQuestions, sessionLog, byId, ageIn, eraFor, eventsUpTo, familySeries, displayName, zhSpan };
})();
