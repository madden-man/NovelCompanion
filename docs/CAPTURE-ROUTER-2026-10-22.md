# Capture Router, design of 2026-10-22 (A48)

The interactive design page is https://claude.ai/artifact/7s493dgEerJey1gWmiYSAM (private). Its browser draft of the rules is saved as `docs/briefs/A48-router-draft.js`. This page records the design and Tommy's decisions in words.

## Measured, before

Every Cmd+K line went to Sonnet with the same prompt: instructions and footer about 820 tokens, tool definitions about 650, the four vocabulary lists about 1,270 (the 126 event categories alone about 1,100), so about 2,750 fixed tokens before any tool turn. Claude then searched each name (one turn each), read each entry in full (a character with backstory can be 24,000 characters, about 6,000 tokens, resent on every later turn), and proposed one change per entry. Four to eight turns, up to 16, no caching. Estimated 10,000 to 90,000 tokens per capture.

## The design

Four stages. The first three are deterministic, run in the renderer on Enter, and cost nothing.

1. Parse: years and decades, "starting around", "by", "until", spans; sentences; question marks; Chinese characters; quoted words.
2. Resolve names: characters (full, first, Chinese), places (and the place's community), communities and their aliases, event categories by cue words, glossary terms, age-group words. A name inside a longer match is not the subject ("Sydney's husband" is a character of its own, "Siyuan's temple" is a place). Capitalised words that match nothing are unknown names.
3. Score and route: weighted cues per section; a question mark dominates; a group as subject discounts the moment reading. The top section's share of the points and its lead pick a route.
4. File: Route A files from the box; Route B is one Haiku call with no tools; Route C is today's capture, trimmed and with hints.

Routes:

- A, zero-token: one clear fact, one section, every name resolved, required fields filled or asked for with a chip. The box shows the proposal as the ED-7 diff; File it writes it as one undo step with status idea and source note "From a capture on <date>, filed without Claude." Thresholds: at least 55% of the points and a lead of 20 points, no judgment flags.
- B, fast file: the section is clear (at least 40%) but something needs judgment: a category among 126, an unknown place name, one moment per character, a quoted word that may be a glossary term. One call to Haiku 5.5, no tools, fed the resolved candidates with IDs, the section's fields and the existing titles nearby. About 700 to 1,400 tokens. It returns proposals through the same validation and may mint a list item (IP-17). It can say "cannot place", and the box then offers Route C.
- C, full capture: today's flow with the lists trimmed to the sections that scored, a candidates block so search turns are skipped, a capture-sized entry view, and the router's section guess as a hint.

Community resolution: a place maps to its community; a demonym plus a place prefers the place's community (the demonym stays in the title, the demonym's community is the second candidate); a demonym alone maps to the national community; nothing resolved asks with a chip, the writing strand's community first.

Year grammar: "starting around 2065", "from", "after", "in" set the start; "by 2070" and "by the 2070s" set the start and leave the end open; "until", "through", "to" set the end; "the 2060s" is 2060 to 2069; "2063 to 2066" is a span; no year takes the story year. A cultural line with an open end stores the bible's timeline end.

## Tommy's decisions (2026-10-22)

1. Route A files without Claude at all. No tidy-up call.
2. A demonym plus a place prefers the place's community ("Chinese people in San Francisco" lands under San Francisco).
3. Haiku for Route B; the Models setting can switch it. The live model list on 2026-10-22 has `claude-haiku-5-5` (Haiku 5.5, the newest) and `claude-haiku-4-5-20251001`; the default is Haiku 5.5.
4. Chips after sending: Enter runs the router; Route A then shows chips and the diff for approval; routes B and C send at once and show the chips as the hints that went with the text.
5. Multi-fact lines are split into sentences and each sentence is routed on its own; a sentence without a year inherits the year of the sentence before it. One File it approves everything ticked, as one undo step.
