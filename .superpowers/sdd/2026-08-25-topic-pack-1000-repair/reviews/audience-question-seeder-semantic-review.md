# Audience Question Seeder 1.0.1 semantic review

- Reviewer: Claude (Anthropic)
- Review date: 2026-08-28
- Reservation: `content-packs/authoring-registry.json` revision 34; `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3`
- Predecessor manifest: `content-packs/reusable-primitives/topic/audience-question-seeder/pack.json`; SHA-256 `54ff38d00ab5032d1f58a2b161c3b77c79ad1566aa94bc36665d651fac31a0ff`
- Predecessor document: `content-packs/reusable-primitives/topic/audience-question-seeder/content/topic-pack.json`; SHA-256 `742c79279efbb9997875880707a41b4f5930908862041ed4c2d56eb22c724e17`
- Successor manifest: `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1/pack.json`; SHA-256 `fbdcf71a0408e0edc8c7f5beca2d89f2a0a814873b2e8f3150dd641dd415f13a`
- Successor document: `content-packs/reusable-primitives/topic/audience-question-seeder-v1.0.1/content/topic-pack.json`; SHA-256 `99ee58ffa69d9059b8b5f7d70d3157ed6b0d464e0c25ae9273a4f23d01cef68a`
- Universal matrix: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/audience-question-seeder-universal-matrix.json`; SHA-256 `2c62b6f28bec0a5ccd45b33e0702a0ee1f47ca48ab4cbf70ae7c0593a299ccaf`

## What this pack is, and why its shape differs from the ten Free Starters

This is not a Free Starter and not an Archival Ledger pack. It is the only Topic Pack
in the sixteen-member batch that lives under `content-packs/reusable-primitives/`, and
the design doc's `Independent-axis rule (6)` places it with the five Archival Ledger
packs rather than with the ten profile-based Free Starters: exactly 50 unique subjects,
`max_siblings_per_subject: 20`, and at least 20 distinct, universally coherent values in
each material axis. It therefore has **no `coverage_profiles` and no `coverage_groups`**,
and it must not acquire them.

Its axis names are inherited from the shared Topic Pack schema, but in this pack they
carry question-seeding semantics rather than narrative ones. That distinction is
load-bearing for anyone reviewing the corpus:

| Schema field | What it holds here |
| --- | --- |
| `subjects` | question intents - the purpose behind an audience question |
| `episode_objects` | audience context - who is asking |
| `time_place_scopes` | constraint - what bounds the asker. **Not a time and not a place.** |
| `mechanisms` | actionability - the bounded next step available to the asker |
| `evidence_lenses` | evidence type - the kind of evidence that could settle the question |

The pack supplies question domains only. It does not own answer structure, and the
inherited exclusions keep it out of diagnosis, treatment, legal conclusions, individualized
professional guidance, live directories, and UI seeding features.

## Review method and the meaning of a verdict

An independent-axis pack cannot be reviewed tuple by tuple, because it authors no tuples.
The planner pairs index k of `episode_objects`, `time_place_scopes`, `mechanisms` and
`evidence_lenses` with **every** subject, so the correctness question is universality:
does each material axis remain coherent against all fifty subjects at once? The bound
universal matrix records that as 150 explicit subject-axis verdicts (50 subjects x 3
material axes), every one `accepted`, with an empty `rejected_values` list.

Universality here is structural rather than lucky. Every axis value is deliberately
domain-free: no value names a field, a period, a place, a profession, or a product, so
none can contradict a question intent. A first-time learner can hold any of the fifty
intents; any of the fifty can be bounded by budget, by energy, or by how easily a choice
can be undone; and every listed action is one an ordinary asker can take for any of them.

## Per-subject axis verdicts

Each subject was checked against all three material axes in full. `A` = accepted.

1. **understand a mechanism** - audience context A; constraint A; actionability A.
2. **compare options** - audience context A; constraint A; actionability A.
3. **plan a bounded next step** - audience context A; constraint A; actionability A.
4. **identify a trade-off** - audience context A; constraint A; actionability A.
5. **check an exception** - audience context A; constraint A; actionability A.
6. **evaluate an observation** - audience context A; constraint A; actionability A.
7. **trace a cause to its source** - audience context A; constraint A; actionability A.
8. **estimate a realistic cost** - audience context A; constraint A; actionability A.
9. **forecast how long something takes** - audience context A; constraint A; actionability A.
10. **decide when to start** - audience context A; constraint A; actionability A.
11. **know when to stop** - audience context A; constraint A; actionability A.
12. **sequence steps in the right order** - audience context A; constraint A; actionability A.
13. **spot an early warning sign** - audience context A; constraint A; actionability A.
14. **distinguish a symptom from a cause** - audience context A; constraint A; actionability A.
15. **set a threshold for acting** - audience context A; constraint A; actionability A.
16. **size the risk of doing nothing** - audience context A; constraint A; actionability A.
17. **isolate the limiting factor** - audience context A; constraint A; actionability A.
18. **separate correlation from cause** - audience context A; constraint A; actionability A.
19. **judge whether a claim is testable** - audience context A; constraint A; actionability A.
20. **establish whether a decision can be revisited later** - audience context A; constraint A; actionability A.
21. **choose the cheapest reliable test** - audience context A; constraint A; actionability A.
22. **establish what is already well known** - audience context A; constraint A; actionability A.
23. **locate an authoritative source** - audience context A; constraint A; actionability A.
24. **tell which rules are mandatory and which are advisory** - audience context A; constraint A; actionability A.
25. **name who actually decides** - audience context A; constraint A; actionability A.
26. **confirm whether a stated condition applies** - audience context A; constraint A; actionability A.
27. **record a baseline before changing anything** - audience context A; constraint A; actionability A.
28. **spot a pattern behind a one-off** - audience context A; constraint A; actionability A.
29. **find what would change the answer** - audience context A; constraint A; actionability A.
30. **narrow a broad problem to one question** - audience context A; constraint A; actionability A.
31. **scope a smaller version of the problem** - audience context A; constraint A; actionability A.
32. **define what to measure** - audience context A; constraint A; actionability A.
33. **question whether a sample represents the whole** - audience context A; constraint A; actionability A.
34. **contrast precision with accuracy** - audience context A; constraint A; actionability A.
35. **notice what a number leaves out** - audience context A; constraint A; actionability A.
36. **verify that a result repeats** - audience context A; constraint A; actionability A.
37. **surface the assumption doing the most work** - audience context A; constraint A; actionability A.
38. **anticipate behaviour at the extremes** - audience context A; constraint A; actionability A.
39. **tell a hard limit from a soft preference** - audience context A; constraint A; actionability A.
40. **choose what to do while waiting** - audience context A; constraint A; actionability A.
41. **design a safe way to undo a change** - audience context A; constraint A; actionability A.
42. **map who else is affected** - audience context A; constraint A; actionability A.
43. **separate a recurring cost from a single upfront cost** - audience context A; constraint A; actionability A.
44. **prioritise what to keep and what to drop** - audience context A; constraint A; actionability A.
45. **test whether timing changes the answer** - audience context A; constraint A; actionability A.
46. **review what has changed since the previous attempt** - audience context A; constraint A; actionability A.
47. **check whether a fix creates a new problem** - audience context A; constraint A; actionability A.
48. **recognise a loophole dressed as an exception** - audience context A; constraint A; actionability A.
49. **settle what good enough looks like** - audience context A; constraint A; actionability A.
50. **rank which gap in knowledge to close first** - audience context A; constraint A; actionability A.

## Explicit findings

- **Coherence - PASS.** All 1,000 planned assignments read as a sensible question seed. The
  fifty intents are genuinely distinct purposes rather than rewordings, and each pairs
  without strain against any asker, constraint, action, and evidence type.
- **Absorption - PASS.** All six predecessor subjects are retained verbatim and kept first:
  understand a mechanism; compare options; plan a bounded next step; identify a trade-off;
  check an exception; evaluate an observation. All six predecessor values in each of the
  four axes are likewise retained verbatim and kept first, so no 1.0.0 idea already
  reserved against this pack becomes unreachable.
- **Identity and compatibility - PASS.** `id`, `name`, `description`,
  `compatible_formula_ids`, `exclusions`, `prompt_context`, `idea_axes`,
  `evidence_expectations` and `compatibility_rules` are byte-identical to the predecessor;
  the manifest keeps its pack ID, publisher, entitlement family and SKU, lifecycle, the
  `{{KEY_ID}}` and `{{MIN_APP_VERSION}}` placeholders, and an empty dependency closure.
  Only `subjects`, the four axis lists, `max_siblings_per_subject` and the manifest
  version and changelog change. The predecessor remains byte-identical to the baseline
  commit. No Formula, Kit, schema, adapter, or planner change is required.
- **Evidence posture - PASS.** The twenty evidence types stay distinct kinds of evidence, and
  the two that report a single unrepeated observation are labelled as such in the value
  itself: `lived observation labelled as anecdotal` and `case notes labelled as a single
  case`. The inherited `evidence_expectations` rule against resting a causal or universal
  conclusion on anecdote still governs the whole list.
- **Exclusions and safety - PASS.** No subject asks for a diagnosis, a treatment, or a legal
  conclusion; no action delivers individualized professional guidance. `ask a professional`
  and `seek a second opinion` route the asker to a qualified person rather than answering
  for one. No value names a real person, organization, product, service, or place.
- **Originality - PASS.** Newly authored generic phrasing. No copied wording, no branded
  language, no borrowed list.
- **Copy - PASS.** Every value is ASCII, lower-case, under 95 characters (longest 53), free of
  trailing punctuation and padded whitespace, and consistent with the predecessor's register.
  No art style is dictated anywhere in the corpus.
- **Anti-padding scan - PASS.** 50 unique subjects; 20 unique values in each of the four axes;
  zero rewording-duplicates under a stopword-stripped sorted-token normalisation; zero subject
  echoes in either direction; and no repeated two-word opener on any list. Largest single
  first-word affix group: subjects 2/50 = 4.0%, episode_objects 2/20, time_place_scopes 2/20,
  mechanisms 2/20, evidence_lenses 1/20.
- **Placeholder scan - PASS.** Case-insensitive scan for `TBD`, `TODO`, `placeholder`,
  `lorem ipsum`, `example`, and numbered filler returned no matches.

## Measured capacity

Measured with the real `planIdeaAssignments()` against the bound document, converted through
`contentPackDocumentToTopicPack()` onto the `question-ladder` Formula this pack declares:

- exactly 1,000 assignments; 1,000 unique fingerprints; 1,000 unique idea keys
- deterministic equal-seed replay
- 50 subjects covered, exactly 20 siblings each, with no repeated episode object or
  mechanism inside any subject
- a 500 + 500 reservation split with zero overlap and 1,000 combined unique fingerprints
- one request past exhaustion returns `[]`, the correct fail-closed behaviour for an
  independent-axis pack, which returns empty rather than throwing

## Final verdict

**PASS for source qualification.** The bound successor supplies 50 distinct question intents
against four twenty-value universally coherent axes for exactly 1,000 lifetime assignments,
preserves the predecessor's identity, compatibility, exclusions and evidence posture, and
leaves the predecessor untouched. Publication, stocking, signing, pricing, registry
transition, and Kit mutation remain outside this review.
