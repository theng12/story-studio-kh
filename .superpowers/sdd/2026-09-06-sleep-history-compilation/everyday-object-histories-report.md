# Everyday Object Histories — Topic Pack authoring report

Pack `com.storystudio.pack.topic.everyday-object-histories` / item `com.storystudio.topic.everyday-object-histories`, version 1.0.0
Source root: `content-packs/sleep-history/topic/everyday-object-histories/`
Files created: `pack.json`, `content/topic-pack.json` (nothing else).
Generator + corpus: `.superpowers/sdd/2026-09-06-sleep-history-compilation/everyday-object-histories-corpus.mjs`

## Counts

| item | count |
| --- | --- |
| subjects | 50 |
| coverage profiles | 50 (one per subject, in subject order) |
| tuples | 1000 (20 per subject) |
| episode_objects (deduplicated) | 1000 |
| time_place_scopes (deduplicated) | 949 |
| mechanisms (deduplicated) | 1000 |
| evidence_lenses (deduplicated) | 988 |
| exclusions | 6 |
| idea_axes values | 10 |
| example_topics | 12 |
| youtube_tags_hint | 14 |
| compatibility_rules | 3 |
| evidence_expectations | 4 |
| prompt_context | 1102 chars (cap 1500) |

`compatible_formula_ids` is exactly `["com.storystudio.formula.sleep-history-compilation"]`.
`max_siblings_per_subject` is 20. All four top-level lists are well under the 2000 cap.

## Schema validation

```
npx tsx -e "import { ContentPackDocumentSchema } from './electron/server/content-packs/schemas.ts'; ..."
SCHEMA OK
```

## Own uniqueness / hygiene audit

```
subjects: 50
profiles: 50
tuples: 1000
episode_objects: 1000
time_place_scopes: 949
mechanisms: 1000
evidence_lenses: 988
bytes: 731367
AUDIT OK
```

Checks run by the generator over every tuple and every string in the document:

- exactly 50 profiles, exactly 20 tuples each;
- per subject, all 20 `episode_object` values unique and all 20 `mechanism` values unique;
- across the whole pack, no complete tuple repeats and no `episode_object|mechanism` pair repeats;
- every tuple value present in the matching top-level deduplicated list;
- field length bands: `episode_object` and `time_place_scope` 40–140 chars, `mechanism` and `evidence_lens` 40–160 chars — all 4000 values inside band;
- every string 1–1000 chars (prompt_context 1–1500);
- no URI-like references, no domain-shaped text, no provider/model routing directives, no exact calendar dates;
- forbidden platform/vendor words absent everywhere. `youtube` appears once in the whole document and only as the key name `youtube_tags_hint`.

Output byte size of `content/topic-pack.json`: **731,367 bytes**.

## Three sample tuples

**the fork** (tuple 1)
- episode_object: a two-tined iron sweetmeat fork with a turned bone handle
- time_place_scope: a Byzantine court dining hall in Constantinople across the 1000s
- mechanism: a foreign table habit arriving through a marriage household and meeting clerical suspicion before it settled
- evidence_lens: court chronicles and clerical complaint writing taken as a genre rather than as single reports

**the matchstick** (tuple 8)
- episode_object: a match taxed by the box under a national revenue measure
- time_place_scope: a European revenue office in a capital city in the 1870s
- mechanism: taxation of a cheap object, which raised revenue in pennies and drew organised public objection
- evidence_lens: revenue legislation and parliamentary petition records as official documents

**the coin** (tuple 19)
- episode_object: a coin worn nearly smooth by decades of passing hand to hand
- time_place_scope: a market town in southern Europe in the 1800s
- mechanism: wear in circulation, reducing a coin's metal until it was worth less than its stated value
- evidence_lens: numismatic wear studies and mint reports on the condition of circulating coin

## Authoring notes

Every tuple is hand-authored for its own subject; there is no template substitution and no shared boilerplate row reused across subjects. Within each subject the 20 mechanisms are drawn from different families — making and materials, guild and regulation, trade route, pricing and taxation, class and etiquette, technological change, standardisation, naming, household custom, repair and reuse, institutional provisioning, disposal and salvage — so no subject recycles a single mechanism family. No named individuals appear anywhere, real or invented, and no brand, company, or trademark is used as an object or a mechanism. Evidence lenses name source *types* only (probate inventories, guild statutes, customs ledgers, pattern books, patent registers as a type, museum-held survivals as a category, and so on), never a specific title, author, or maker.
