# Task 5 independent review — Habits & Momentum

**Verdict: FAIL**

Reviewed commit `19df47b5d702cf41e1d7ced75e609a0761058440` over exact range `2b3c31b3d38dcada505ab855f8438a1421155852..19df47b5d702cf41e1d7ced75e609a0761058440` against the design, plan, Task 5 brief, and Tasks 3–17 semantic guardrails.

## Findings

### High — The 1,000 raw-unique tuples are one 20-row ordinal template applied to all 50 routines

File: `content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json:3264`

All 50 profiles reuse the same 20 intervention/evidence frames in the same ordinal positions. For example, ordinal 2 is always `<base artifact> at its action point | staging <base artifact> before search | search count and start seconds ... staged versus stored`; ordinal 4 is always `first-move cover | exposing one reversible move toward <completion> | starts and stops ... visible`; and ordinals 6, 7, 11, 13, 14, 15, 17, and 20 likewise reduce exactly to one 50-member skeleton after substituting only the profile subject/base/fallback/barrier/completion. The remaining ordinals reduce to the same pattern after also substituting the profile cue, action, constraint list, handoff actor, or observation-period noun. Thus every profile receives the same gate/stage/marker/cover/fallback/boundary/choice/capacity/short-start/transition/pause/finish/holder/log/access/handoff/attempt/stop/layout/retire sequence.

The shoe example at lines 3264–3375 and the phone example beginning at line 3764 demonstrate the substitution directly. Raw strings remain unique only because the routine-specific noun phrase is embedded in each wrapper. This is the generic axis substitution that the design expressly prohibits, and it is also the Task 5 guardrail's named failure mode (generic cue/friction/note-card/calendar/timer/bottle/checklist substitutions across unrelated routines). A profile-specific base artifact and subject prefix do not turn the same twenty intervention frames into 20 independently authored material siblings.

I separately compared all 499,500 unordered pairs using broad marker/note/card, holder/tray/shelf, record/log, layout/placement, start/gate, finish/stop, choice/fallback, burden/friction, and adaptation/retirement synonym classes, then manually adjudicated the highest-similarity candidates. I did not find an additional exact material core-pair collision once genuinely different routine targets and comparisons were retained. That does not cure this finding: the failure is copied ordinal construction, not merely two equal raw strings.

### High — At least 200 tuple coordinates contain systematic grammar or completion/evidence defects

File: `content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json:3776`

The completion value is interpolated into grammar slots that require a noun phrase. In profiles 5–50, the completion is a full clause, so ordinal 4 and ordinal 12 fail systematically (46 profiles × 2 ordinals = 92 tuple coordinates). The phone rows are representative:

- `5/04`: `exposing one reversible move toward the phone has one declared location and essential access remains available` (line 3779).
- `5/12`: `ending placing ... at the phone has one declared location ...` and `the phone has ... reached, revised, declined, or exceeded` (lines 3827–3828).

The same malformed construction occurs through profile 50 (`the block reduces demands ... reached, revised, declined, or exceeded`). Besides being ungrammatical, the ordinal-12 suffix does not cleanly measure its purported completion boundary: `revised`, `declined`, and `exceeded` are applied to an asserted outcome clause rather than to a defined boundary/choice variable.

A second interpolation defect affects the 36 verb-led subjects (profile 1 and profiles 16–50) at ordinals 13, 14, and 17 (108 more tuple coordinates): for example, `keeping only material needed for the next prepare tomorrow's shoes start`, `weighing easier prepare tomorrow's shoes starts`, and `logging prepare tomorrow's shoes attempts` at lines 3333, 3339, and 3357. Other direct defects include `3/03`'s `marker presence when the named appointment becoming current` and possessives such as `47/11`'s `options's state`.

These are not style preferences; they are incomplete/ill-formed mechanisms and evidence lenses in a corpus whose acceptance explicitly requires grammatical copy, observable completion, and evidence capability. Consequently the hash-bound review's 1,000 tuple PASS verdicts and its `Copy, grammar, and completion — PASS` finding are false.

### High — The claimed semantic audit is structurally incapable of detecting the two failures above

File: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-5-semantic-audit.mjs:64`

The grammar check at lines 64–66 recognizes only duplicated articles/conjunctions (`a a`, `the the`, and similar), so it cannot detect the clause-slot and verb-phrase interpolation failures. Evidence capability at lines 67–96 is accepted solely because each ordinal contains its expected canned phrase; ordinal 12 passes merely by containing `reached, revised, declined, or exceeded`. The pair comparator at lines 99–118 preserves all routine-specific nouns and uses an exact normalized-token key or a high dual-Jaccard threshold, so inserting a different base artifact is enough to hide the common wrapper. It therefore reports zero analog groups while the corpus has twenty obvious 50-row ordinal families.

The implementer report's statement that the audit checked grammar, every repeated intervention family, and all 499,500 pairs, and the semantic review's claims at lines 72–79, are not truthful quality evidence until the source is repaired and the audit/review are rerun with template-variable stripping plus syntactic/semantic adjudication.

## Exhaustive semantic assessment

- Audited all 50 profiles and all 20 ordinal families (1,000 tuples). Every profile's single broad scope is materially compatible with its routine; no scope requires exact event restatement.
- Checked evidence capability against the mechanism at every coordinate. The recurring evidence families generally expose a relevant independent/dependent variable or comparison (latency, search, cue contact, fallback/default, interruption, burden, access, handoff, or retirement), but the malformed ordinal-12 family fails as described above.
- Checked habit-science and safety framing. The source avoids fixed habit-formation promises, diagnosis/treatment claims, guaranteed productivity/identity/income outcomes, coercion, shame, and unsafe universal exercise/nutrition/hydration advice. Sensitive routines preserve adaptation, deferral, rest, authoritative guidance, and non-participation.
- Checked all 499,500 core-pair comparisons with broad synonym/modifier normalization and manual review of the highest-similarity and same-profile candidates. No additional material duplicate is asserted beyond the prohibited common ordinal-template construction. Candidate overlaps such as alternative choice versus accessible alternative, capacity gate versus stop/reassess, and staged location versus alternating layout retain distinguishable decisions/comparisons.
- No numbered filler, TODO/TBD/lorem placeholder, branded copying, or covert medical/manipulative claim was found.

## Mechanical, runtime, identity, and process evidence

- Exact receipt replay: PASS at registry revision 34 for `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3` and the Habits expected identity.
- Exact range: only the successor `pack.json`, successor Topic document, and one reviewed-harness row changed; `git diff --check` is clean. No out-of-scope source changed.
- Predecessor unchanged: manifest SHA-256 `6a0703d092a644a162ff3f425ed89d9a89efdb4dfdd01afa52d477d3d0ec77aa`; document SHA-256 `51bf60446162c91a7bae3864d8b575c76c91b8c3ed3c2c8a91adb78b7042541d`.
- Successor identity/compatibility: correct `pack_id`, item ID, publisher, family/SKU, lifecycle, placeholders, empty dependency closure, and Practical Motivation-only compatibility. Inherited exclusions, prompt context, tags, and compatibility rules are preserved.
- Shape/capacity: 50 unique subjects, 50 source-ordered profiles, 20 tuples each, cap 20, 1,000 tuples, and exactly `+970` over the predecessor. Raw objects, mechanisms, evidence lenses, complete tuples, and object/mechanism pairs each count 1,000.
- Successor hashes: manifest `64c0ee125cb9ecff3432acca20901db3dc8b017c78f9d088c6641add69abc070`; document `f16bbf96adc49c5fb36067fa9b081cd7988e87cb564bdf492de9e4f8cb601af8`. Document size is 830,165 bytes, 218,411 bytes below 1 MiB.
- Review artifact: present, ignored, and untracked; binds the exact successor document hash; contains exactly 50 source-ordered subject rows and 1,000 explicit tuple verdicts. Its verdict content is false for the findings above.
- Named capacity harness: PASS 1/1. Full successor harness: PASS 5/5, including real parser/adapter/planner, exact authored tuple selection, deterministic replay, 1,000 unique fingerprints/idea keys, disjoint 500+500 reservations, and safe exhaustion.
- Signed-source golden: PASS 8/8. Authoring-registry suite: PASS 35/35. Registry validation: PASS (revision 34, 108 records). Electron typecheck: PASS.
- Known Task 18 legacy inventory assertion: expected non-blocking failure only, `60 !== 55` at the unchanged root-count assertion. Task 5 did not modify that test.

Task 5 is mechanically qualified but is not semantically acceptable until the generic ordinal construction and copy/evidence defects are repaired and the ignored review/audit are regenerated against the repaired source hash.
