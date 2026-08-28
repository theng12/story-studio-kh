# Paid Wave Proposal: Deep Time Field Record, wave one

Status: **proposal**. Not a product, not a release, not a price, not a shelf entry. This document
is submitted against `docs/product/content-store-paid-wave-boundaries.md` and must be accepted
against all seven admission gates before any commercial identity is assigned.

Free foundation: **Deep Time**.
Approved paid depth path for that lane: *"Enriched Prehistoric Life & Extinction; Ancient Oceans
& Deep Sea; Human Origins & Ancient Worlds; Speculative Earth Scenarios."*

This proposal takes that path as the wave's scope — four Topic components — and authors the
first of them. Packs two to four are scoped here and authored later, each against this same
document plus the per-pack notes in "Wave sequencing" below.

## 1. What the wave is

**Deep Time Field Record** is an evidence-led palaeontology and deep-history collection for the
Deep Time Documentary channel format. Its editorial posture is the field record itself: a
specimen, a quarry, a core, a section, a monograph plate, an expedition notebook — and the
method that turns that object into a claim about the past.

Four Topic components, each an independent catalog identity:

| # | Component | Direction | Status |
| --- | --- | --- | --- |
| 1 | Prehistoric Life & Extinction (enriched) | Ancient ecosystems, evolutionary transitions, extinction mechanisms, and the specimens and sections that record them | **Authored in this wave** |
| 2 | Ancient Oceans & Deep Sea | Ocean chemistry, reef systems, marine reptiles and fishes, anoxia and ventilation, the deep-sea record read from cores | Scoped; not authored |
| 3 | Human Origins & Ancient Worlds | Hominin fossils, sites, dating controversies, dispersal and the archaeological record of the deep past | Scoped; not authored |
| 4 | Speculative Earth Scenarios | Counterfactual Earths built from real physical constraints and published model runs | Scoped; **evidence contract unresolved — see §8** |

## 2. Net-new outcome

The customer outcome this wave adds, which no unchanged free or legacy-included component
delivers today:

> A Deep Time channel can run a *specimen-first* documentary series — each episode built on one
> named object, in one named formation, at one named geological interval, with the analytical
> method that establishes it — for a full production year, without the operator selecting
> subjects, localities or evidence framing by hand.

The free foundation delivers the *format*: the Deep Time Documentary Formula (free) and the
Earth Systems & Deep Change Topic Pack (free), which is a planetary-mechanism direction —
mountains, oceans, atmospheres, ice. Neither delivers a life-and-extinction direction at
authored tuple grain.

The legacy built-ins deliver a *subject list only*. `deep-time-prehistoric-life` carries 30
subject strings, two idea axes and a prompt context, and **zero** authored episode objects,
scopes, mechanisms or evidence lenses — so it plans nothing at tuple grain and offers no
structured spread of place, period or method. That is a different product from what this wave
proposes, not a smaller amount of it.

This outcome is observable in the supported workflow: the difference shows up as authored
assignments the planner can reserve, with distinct localities and evidence methods, not as
different cover art.

## 3. Material content

Pack 1 as authored:

* **100 named subjects**, spread across eight geological eras and nine evidence regions.
* **20 authored whole tuples per subject** on the family's four axes —
  `{episode_object, time_place_scope, mechanism, evidence_lens}` — matching
  `deep-time-earth-systems@1.0.1` exactly.
* **2,000 authored whole tuples**, every value on every axis distinct across the document.
* Coverage-profile mode: the runtime selects an authored whole tuple, never an independently
  zipped combination of axis values.

### Why 100 x 20 and not 50 x 20

The wave-boundaries policy sets no number; the honest floor is what the material supports and
what the family already publishes. Three reference points were measured, not assumed:

| Reference | Subjects | Tuples per subject | Structured assignments |
| --- | --- | --- | --- |
| Legacy built-in `deep-time-prehistoric-life` | 30 | none authored | 0 |
| Free family standard, `deep-time-earth-systems@1.0.1` | 50 | 20 | 1,000 |
| Paid family standard, the Archival Ledger 1.0.1 successors | 100 | 20 | 2,000 |

The paid standard is chosen. Palaeontology supports it comfortably and without padding: the
named Lagerstatten alone run to several dozen, the formally named extinction events and their
competing kill mechanisms to a dozen more, and every major evolutionary transition carries its
own well-attested specimen series, type locality and analytical literature. The owner's standing
rule is that more is better and there is no cap; the constraint applied instead was that every
one of the 100 subjects had to survive the same test — could a competent documentary writer
build twenty materially different episodes from it, each with its own object, locality, interval,
mechanism and method? Subjects that could not were cut before authoring, not padded during it.

At 2,000 authored assignments and the Deep Time Documentary Formula's two episode lanes, a
channel publishing three episodes a week has more than twelve years of non-repeating directions
from this component alone.

### Structural commitments, each machine-checked

* Every `time_place_scope` names **both** a real place or stratigraphic setting **and** a real
  geological interval. (The free sibling satisfies this for roughly three-quarters of its scopes;
  the paid pack is held to all of them.)
* No two scopes inside a subject are the same setting reworded. Checked three ways: as a bag of
  words ignoring articles, again ignoring hedges, and again as {period words} plus {place words}.
* No subject echo: a subject string never appears inside its own episode objects or mechanisms.
* Affix share at or under 5% on every axis, so no template opening carries the pack.
* Disputed datings, affinities and kill mechanisms appear **only** in the evidence lens, as a
  named-record comparison. They are never asserted in a mechanism.

## 4. No legacy rebilling

* The four legacy built-ins (`deep-time-prehistoric-life`, `deep-time-deep-ocean`,
  `deep-time-human-origins`, `deep-time-speculative-earth`) remain in the app, unmodified,
  usable, and free. This wave withdraws nothing and rewrites nothing.
* Existing projects keep their current pins, including the free Deep Time kit's pin of
  `deep-time-earth-systems@1.0.1`.
* The paid pack shares **no authored bytes** with any legacy file. The legacy subject lists were
  read as reference material for editorial direction only; the paid subject list was authored
  independently at a materially finer grain — named formations, quarries, sections, expeditions
  and events in place of generic labels.
* No migration, replacement or upgrade path is offered by this wave. If one is ever wanted, the
  policy requires it to be a separate, separately reviewed choice.

## 5. Independent identity

Each of the four Topic components is proposed as its own catalog identity and entitlement
family, so any one of them can be owned, updated, withdrawn or reviewed without the others. The
wave is not a monolith and this proposal does not create a kit.

Each of the four Topic components is its own catalog identity and entitlement family, so any one
can be owned, updated, withdrawn or reviewed without the others. The wave is not a monolith and
this proposal does not create a kit.

**Pack 1's authoring identity is now reserved and the record is `authored`.** The reservation
chains from the repaired ledger (`d0b741f0` re-mint plus the committed-ledger guard at
`45ea6ae3`):

| Event | Revision | Reference |
| --- | --- | --- |
| reserve `topic.deep-time-field-record.prehistoric-life-extinction@1.0.0` | 90 | `authoring:62e4f791...81e33ae` |
| transition that record to `authored` | 91 | `lifecycle:1ba362ae...714f1661` |

Registry after the wave: **revision 91, 139 records, 18 batches, 72 transitions.**

The reserved strings are:

```
pack_id  com.storystudio.pack.topic.deep-time-field-record.prehistoric-life-extinction
item_id  com.storystudio.topic.deep-time-field-record.prehistoric-life-extinction
sku      com.storystudio.sku.topic.deep-time-field-record.prehistoric-life-extinction
family   com.storystudio.family.topic.deep-time-field-record.prehistoric-life-extinction
```

`stocking_proposal` holds the family and SKU at status `proposed`, which is what that field is
for: GenStudio still assigns the eventual product, release and SKU identities after approval.
An authoring reservation is not a catalog listing, and this document creates none.

### Packs 2-4: identities NOT reserved, and why

The sixteen-record `topic-pack-1000-repair` batch (revision 34) is the precedent for reserving a
whole planned wave up front and promoting each record to `authored` as its source lands. That
batch could do it because all sixteen records were the *same settled operation* against an
accepted design doc -- repair each Topic Pack to 1,000 -- so every identity described something
whose shape was already known.

This wave does not meet that bar, by its own account. Section 10 records an unresolved cross-pack
overlap boundary for pack 2, two missing contracts for pack 3, and an explicit **block** on pack
4 pending an evidence contract. A reserved record is a claim in a permanent ledger; reserving
three identities for components this document says are not ready would make the ledger assert a
readiness the proposal denies.

So pack 1 only. Packs 2-4 are reserved at their own authoring, one batch each, exactly as the
symbolic-psychology wave reserved its leaves. Nothing is lost by waiting: reservation is cheap,
and the identity strings are already written down above the line that reserves them.

## 6. Proofable claim

Every number this wave will ever put in front of a customer is derived from the signed release
and backed by a named offline gate. Nothing is inferred from a title, a folder count or an
authoring intention.

| Claim | Proof |
| --- | --- |
| 100 subjects, all distinct | standalone gate, subject and profile arithmetic |
| 2,000 authored tuples, 20 per subject | standalone gate, profile arithmetic |
| 2,000 distinct values on each of the four axes | standalone gate, set arithmetic after `slug()` |
| 2,000 lifetime non-repeating assignments | planner gate: `planIdeaAssignments` returns exactly 2,000, replays deterministically, and **fails closed at 2,001** rather than repeating an object or mechanism |
| every assignment is an authored whole tuple | planner gate, tuple membership assertion per assignment |
| works with the free Deep Time Documentary Formula | planner gate runs against that exact free Formula document |
| the archive is reproducible | build twice, byte-identical, then validate the signature |
| the gates can actually see defects | mutation test: six deliberate defects injected one at a time, each caught, clean document re-measured |

The mutation test is the load-bearing one. A gate that has never been shown to fail is not
evidence, and this family needed a new false-positive class closed before its casing rule could
be trusted at all — see §9.

## 7. Complete use

Pack 1 is not an orphan. It declares
`compatible_formula_ids: ["com.storystudio.formula.deep-time-documentary"]` — the **free** Deep
Time Documentary Formula that ships in the free Deep Time starter kit. A customer who owns
nothing else can install this Topic and run it immediately.

The acceptance test exercises that path rather than validating a manifest: the planner gate
loads the free Formula document, attaches this Topic, and plans the full 2,000.

No paid Formula, Style or Thumbnail component is required, proposed or implied by this wave.

## 8. Transparent dependency

The one required component is the free Deep Time Documentary Formula, and the detail view must
say so in those words: *required, free, already included in the free Deep Time kit*.

Story Studio calculates no price, discount, grant or dependency value. The customer sees the
exact GenStudio quote and ownership facts. Price follows the policy order: GenStudio recommends
from the live credit economy, then the owner decides — after the evidence review, not before it.

## 9. What this wave had to build

The checker lineage was inherited from `content/infrastructure-commodities-1.0.1-2026-08-28`
(commit `e0e9dbc3`), which carries the empires-trade and wars-treaties gates before it. Adapting
it to a palaeontological family required three changes, all of them measured rather than assumed:

1. **The period signal was rewritten for geological time.** The inherited rule looked for
   centuries, dynasties and eras. This family's intervals are the geological time scale, so the
   rule now recognises eons, eras, periods, epochs and the stage names the pack actually uses,
   plus numeric ages.
2. **The place rule was rewritten for stratigraphy.** A palaeontological setting is legitimately
   named by a lithostratigraphic unit, a depositional environment or a collecting locality, not
   only by an ordinary geographic name.
3. **Binomial nomenclature broke the inherited casing rule.** Species names are written
   `Genus species` by international convention, so the half-lowercase rule — the rule that
   catches "Indian ocean" and "Hell creek" — fires on every correctly written species name in
   the pack. The fix is an explicit binomial allowlist rather than a `[A-Z][a-z]+ [a-z]+`
   pattern, so genuine half-lowercasing is still caught; mutation test 6 proves it.

A fourth false-positive class was found by running the inherited rule against the family's own
free sibling: informal chronostratigraphic modifiers ("early Cambrian", "late Palaeozoic") are
lowercase by convention and produced 9 of that sibling's 11 half-hits, all of them correct. That
pair is now exempt from the half rule, and a separate consistency check was added in its place —
the pack must pick one casing per modifier-and-period pair and keep it. Run against the free
sibling, that new check immediately found a real split it carries (`late Palaeozoic` and
`Late Palaeozoic` in the same document). The sibling is not in this wave's scope and is left
alone; the check is recorded here so the finding is not lost.

## 9a. House-style audit against the family's published sibling

Both packs were measured with the same final checker. The audit runs in both directions, and
neither direction came back empty.

| Measure | Free sibling `deep-time-earth-systems@1.0.1` | This pack |
| --- | --- | --- |
| subjects / tuples | 50 / 1,000 | 100 / 2,000 |
| distinct `episode_object` | 1,000 / 1,000 | 2,000 / 2,000 |
| distinct `time_place_scope` | 995 / 1,000 | 2,000 / 2,000 |
| distinct `mechanism` | 1,000 / 1,000 | 2,000 / 2,000 |
| distinct `evidence_lens` | 994 / 1,000 | 2,000 / 2,000 |
| scopes with no geological interval | 615 / 1,000 | 0 / 2,000 |
| scopes naming no place | 227 / 1,000 | 0 / 2,000 |
| casing hits (single / bigram / half) | 1 / 0 / 5 | 0 / 0 / 0 |
| modifier splits, lowercase formal subdivisions | 2, 41 | 0, 0 |
| median length: object / scope / mechanism / lens | 48 / 40 / 49 / 52 | 56 / 61 / 67 / 65 |

### Finding against this pack: register drift, open for review

This pack runs longer than its sibling on every axis, and the `mechanism` axis is the widest
gap: median 67 characters against the family's 49. One of the ten writers measured this in their
own part and rewrote all 200 of their mechanisms to close it; the other nine did not, so the
divergence is real and uneven.

It is left as authored, and flagged here rather than silently accepted, because the reason is
arguable in both directions. A palaeontological mechanism carries a biological or taphonomic
process rather than a one-clause geological one, and the evidence lenses that hold this family's
contested datings and kill mechanisms are named-record *comparisons* -- "the Deccan argon age
model set against the Chicxulub ejecta horizon in the same sections" -- which cannot be said in
52 characters without losing the second half of the comparison. Every value is inside the
authored ceilings. But a reader moving between the free and paid packs would notice, and no
automated gate measures register.

**This is a taste call for the independent wave review, not a defect the author should settle
alone.** If the review wants the family's shorter register, the fix is a mechanism-only rewrite
pass; the content and its evidence would not change.

### Findings against the free sibling, recorded and not acted on

The audit also found real defects in the published free pack. They are out of this wave's scope
-- it is a published component pinned at 1.0.1 by the free Deep Time kit, and editing it would
change bytes the kit's pin depends on -- so they are recorded here rather than lost:

* 5 duplicate `time_place_scope` values and 6 duplicate `evidence_lens` values.
* 615 of 1,000 scopes name no geological interval, and 227 name no place.
* 1 lowercased proper noun (`maar` beside `Maar`).
* 5 half-lowercased proper names: `Indian ocean` (twice), `Atlantic ridge`, `American southwest`,
  `Chinese loess`.
* 2 chronostratigraphic modifier pairs written both ways, and 41 lowercase formal subdivisions.

None of these is severe, and none blocks this wave. They are the natural candidates for a
`deep-time-earth-systems` 1.0.2 whenever one is wanted, and they are the reason the paid pack's
own bars were set where they are rather than at "matches the sibling".

## 9b. Two gate gaps found while registering this wave

Registering pack 1 meant merging the repaired ledger, and doing that surfaced two problems that
are not this wave's content but are this wave's to report.

**A stale registry snapshot, red before this branch existed.**
`scripts/content-packs/__tests__/symbolic-psychology-studio-wave-1.test.mjs` asserted that two
leaf records were still `reserved` and that no Kit record existed. The symbolic-psychology wave
then promoted both leaves and reserved the Kit, which is exactly what it was supposed to do, and
the test was not updated. Bisected rather than assumed: it fails identically at `45ea6ae3`,
before this branch touched anything. Repaired here by restating the claim so it survives the wave
completing -- each leaf is promoted by its own transition, distinct from the Formula's, and the
Kit is a separate reservation under a different receipt -- rather than by re-pinning a new
snapshot that the next legitimate write would break again.

**That whole directory ran in no gate at all.** `npm test` chained `test:backend`,
`test:frontend` and `test:release`; nothing ran `scripts/content-packs/__tests__`. That is 156
tests, including the ones that describe the authoring ledger, executing only when somebody
happened to invoke them by hand. It is the same gap that let a corrupted ledger land through a
fully green suite, and the symbolic-psychology wave closed the highest-value part of it by adding
a committed-ledger guard under `electron/server/__tests__/`. The rest is closed here: a
`test:content-packs` script now runs the directory, and `npm test` chains it. All 156 pass.

The backend gate's own anchors are unchanged by this, because the new script is separate from
`test:backend`.

## 10. Wave sequencing

**Pack 1 — Prehistoric Life & Extinction (enriched).** Authored in this wave at 100 x 20.

**Pack 2 — Ancient Oceans & Deep Sea.** Same shape and same four axes. Its distinctness from
pack 1 must be argued explicitly at proposal time, because marine reptiles, reef systems and
anoxia events could be written from either direction. The boundary proposed: pack 1 owns the
*organism and the extinction*, pack 2 owns the *ocean as a system and its record* — water
chemistry, circulation, ventilation, sea level, the deep-sea core record, and the modern deep
sea read as a deep-time archive. A cross-pack subject-overlap gate should be added before pack 2
is authored, not after.

**Pack 3 — Human Origins & Ancient Worlds.** Same shape. Two additional contracts are needed
before authoring: a dating-dispute posture at least as strict as pack 1's (hominin
chronologies are contested more often than they are settled), and an explicit statement of the
boundary against the **First Humans** free foundation and its own approved paid depth path, so
the two lanes do not author into each other.

**Pack 4 — Speculative Earth Scenarios.** *Blocked pending an evidence contract.* The family's
Formula requires that observation, inference, debate and speculation stay separated in plain
language, and the free Earth Systems pack carries the exclusion *"Do not claim speculative
reconstructions as settled fact."* A counterfactual pack cannot use pack 1's evidence lens
unchanged, because there is no specimen for an Earth that never existed. The proposal for pack 4
must first define what the fourth axis becomes — the published model run, the physical
constraint, the closest real analogue — and what the gate measures in its place. Do not author
pack 4 against this document as written.

## 11. What this proposal does not do

It creates no product ID, SKU, release ID, entitlement family, price, discount or catalog
listing. It does not publish, grant, purchase, install or shelf-place anything, and no such
action follows from a passing test. Publication requires the separate owner-approved release and
GenStudio catalog actions.

It does now hold one **authoring** reservation (section 5). That is the publisher-side ledger
entry that lets the source live in `content-packs/` and be built reproducibly; it is not a
product, a price, a release or a shelf entry, and the family and SKU it names remain at status
`proposed` for GenStudio to assign.

Independent wave review is still outstanding, and Critical or Important findings block the wave
until corrected and re-reviewed.
