# Task 2 implementer report — Natural World Animals

## Outcome

- Status: COMPLETED
- Implementer/reviewer: Codex (OpenAI)
- Date: 2026-08-25
- Worktree: `<owner-home>/Developer/story-studio-kh/.worktrees/content-expansion-portfolio`
- Start commit: `4c8df44e3fd9268f416546e35c5c064828b768bd`
- Initial Task 2 commit: `28a8d6a902a6923f396c5d41e79db26524148d58` (`feat(content-packs): expand natural world animals`)
- Semantic repair commit: `c25b71e0f93768b5d46b2d0dc4f937b1e1128fea` (`fix(content-packs): repair animal tuple semantics`)
- Second semantic repair commit: `497a583c9b869f5b8eecab673c0fb35d7b4af725` (`fix(content-packs): ground animal scope and evidence`)

## Reservation and identity evidence

`npm run content-pack:registry -- verify-receipt --revision 34 --receipt authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3 --expected-identity .superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json` exited 0 before authoring and again after authoring. It returned the exact reserved identity:

- pack: `com.storystudio.pack.topic.natural-world-animals@1.0.1`
- item: `com.storystudio.topic.natural-world-animals`
- publisher: `com.storystudio`
- source: `content-packs/free-starters/topic/natural-world-animals-v1.0.1`
- minimum app version: `{{MIN_APP_VERSION}}`, release-bound
- dependencies: `[]`
- family/SKU: the existing proposed Natural World Animals values

`npm run content-pack:registry -- validate` also exited 0 at revision 34 with 108 records. The registry was not modified.

## TDD RED and diagnosed shared-harness contract

After adding only the exact reviewed profile row (`subjects: 50`, `siblings: 20`, `tupleAdditions: 980`), the literal named test exited 1 with the legitimate missing-source RED:

```text
ENOENT: no such file or directory, open '.../natural-world-animals-v1.0.1/pack.json'
```

After the source and review were authored, an intermediate GREEN attempt exposed that the new shared harness treated `planIdeaAssignments({ count: 500 })` as an exact-length response. Root-cause tracing showed this planner intentionally returns an oversized retry pool (`targetPoolSize = count * 4`), while production `idea-campaign.ts` and existing tests consume only the requested prefix. The coordinator authorized the smallest harness-boundary correction: slice each 500-reservation pool to 500. No production planner, schema, adapter, or runtime behavior changed.

## Independent-review repair: before and after

The first independent review rejected the corpus's scope and evidence semantics even though its mechanical gates were green:

- **Before:** every profile reused five scopes with the same `6,4,4,3,3` ordinal pattern; after removing the species prefix, all 1,000 evidence lenses collapsed to 20 ordinal method strings. This created concrete contradictions for polar-bear maternity/lactation, emperor-penguin call recognition, albatross nest defense, cuckoo plumage mimicry, naked-mole-rat excavation labor, octopus papilla control, and giant-tube-worm juvenile symbiont acquisition.
- **After:** every tuple has a unique subject/context scope that includes its exact focal episode object, and a unique subject-specific evidence lens that names a claim-capable scientific method, the exact object, and the exact mechanism tested. Mechanical audit reports 1,000 unique scopes, 1,000 unique lenses, 1,000 exact scope→object bindings, 1,000 exact lens→object bindings, and 1,000 exact lens→mechanism bindings. The seven named contradictions were inspected directly after regeneration, and every other profile passed the same binding/category audit.
- Field-level comparison against the initial Task 2 commit confirms only `time_place_scopes`, `evidence_lenses`, and the corresponding tuple fields changed. Subjects, objects, mechanisms, identities, compatibility, exclusions, prompt context, and all other source fields remain exact.
- The first repaired minified document was 897,168 bytes. The second semantic repair reduced it to 644,558 bytes by removing copied claim suffixes while adding real contexts and methods; both remain below the 1,048,576-byte limit.
- The semantic review was regenerated with exactly 50 subject rows and 1,000 explicit tuple verdicts, rebound to the repaired document hash, removed from Git tracking, and preserved on disk at the ignored Task 19 evidence path.

## Second independent-review repair: semantic bases rather than copied suffixes

The second review correctly found that the first repair still manufactured string-level uniqueness: all 1,000 scopes appended `focus: <episode_object>` and all 1,000 evidence lenses appended both the object and mechanism to only 27 underlying method strings. Removing those suffixes exposed incoherent base values, including sea-otter tool use and kelp anchoring, a polar-bear summer fast, dolphin biosonar, cuckoo calling, octopus chemotactile feeding and paralarval dispersal, and multiple tube-worm reproduction/dispersal/growth records.

The second repair removes every copied `focus:`/`test:` suffix and both generic migration/care templates. It authors compatible place/time/behavioral phases and claim-capable observation methods, including a complete cross-profile audit of the high-risk defense, movement, seasonal, conservation, performance-trade-off, and ecosystem categories. Repeated settings and methods are deliberately retained when scientifically correct; cosmetic string uniqueness is no longer treated as semantic evidence. The final corpus has 523 legitimate scope values and 82 method bases, while its 1,000 subject-labelled evidence lenses, 1,000 objects, 1,000 mechanisms, and 1,000 object/mechanism core pairs remain exact.

Named second-review corrections were inspected directly: Sea otter #2/#8, Polar bear #17, Common bottlenose dolphin #7, Common cuckoo #14, Common octopus #2/#13, and Giant tube worm #10/#11/#12/#14/#15/#17. The ignored review now describes actual judgments and legitimate reuse, still contains exactly 50 subject rows and 1,000 explicit tuple verdicts, and binds the final source digest.

## GREEN and verification evidence

- `npx tsx --test --test-name-pattern "capacity: natural-world-animals" electron/server/__tests__/topic-pack-1000-successors.test.ts` — exit 0; 1 test, 1 pass, 0 fail.
- `npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts` — exit 0; 8 tests, 8 pass, 0 fail.
- Exact receipt re-verification — exit 0 at revision 34 and the receipt above.
- `npm run content-pack:registry -- validate` — exit 0; revision 34, 108 records.
- `npm run typecheck:electron` — exit 0.
- `git diff --cached --check` — exit 0 before commit.
- Predecessor byte comparison against baseline `ddf8a42b475efec3e3556f95f21ae6a182752204` — no diff.
- Mechanical corpus/review scan — 50 unique subjects, 50 profiles, 1,000 complete tuples, 1,000 unique episode objects, 1,000 unique mechanisms, 523 legitimate scopes, 1,000 unique subject-labelled evidence lenses backed by 82 actual method bases, 1,000 unique `episode_object|mechanism` pairs, zero copied claim suffixes or generic migration/care templates, 50 review subject rows, and 1,000 explicit tuple PASS verdicts.
- Placeholder scan — no match for `TBD`, `TODO`, `placeholder`, `lorem ipsum`, generic/various animal filler, or numbered animal/mechanism/tuple filler.

The named capacity GREEN exercises real strict parsing, receipt identity, predecessor byte identity, the exact +980 tuple delta, profile tuple atomicity, full/replay 1,000 determinism, unique fingerprints and idea keys, 500+500 non-overlap at the real reservation boundary, hash-bound review evidence, and safe exhaustion.

## Exact SHA-256

- predecessor `pack.json`: `73e75b08c5577118c39d5b51e78db84e7224d67e0a2ea7206a5ca46959183a4f`
- predecessor `content/topic-pack.json`: `3fd6d7be667eb797489b7b34d1a89cf39fade4d4ce09679e7e6acfd903c293ac`
- successor `pack.json`: `056fa7a24ff6452394b667005022e1bf5879f39bcf2cc584cbcac6155b0eddfe`
- successor `content/topic-pack.json`: `b96e981851f11605038c14ebfbd5646605a349d8059dadd47b72fefcf4a6b3d6`
- ignored on-disk semantic review: `51862f8addfe9c4d73eccf62f29520c3ee8ae66ede33d8ec453251e6a3247263`

## Final tracked Task 2 files

- `content-packs/free-starters/topic/natural-world-animals-v1.0.1/pack.json`
- `content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json`
- `electron/server/__tests__/topic-pack-1000-successors.test.ts`

The semantic review remains at `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md` for Task 19 but is ignored and absent from the Git index, as required.

No registry, Formula, Kit, schema, planner, adapter, application version, lockfile, changelog, GenStudio record, or external handoff was changed.

## Child-process cleanup

The temporary corpus generator, both semantic-repair generators, and diagnostic files were removed. Every Task 2 `tsx`, `tsc`, registry, and Node validation command exited and returned control; no Task 2 child or tool session remains. A separate full-suite process owned by the parent repository was observed during the initial implementation and deliberately left untouched because it was not started by this task.

## Third-review rescue — complete inventory repair

This section supersedes the earlier semantic-count and successor-hash claims above while preserving their history.

- Rescue start commit: `497a583c9b869f5b8eecab673c0fb35d7b4af725`.
- Rescue repair commit: `437a9d50ccd54d3ae68ae4b518122cd84c6fa00d` (`fix(content-packs): repair animal tuple semantics`).
- Root cause: ordinal scope and evidence-method families had been assigned without checking the complete species event, life phase, medium, and mechanism. Structural uniqueness and subject prefixes hid 184 atomic contradictions.
- TDD RED: the ignored task-local regression check failed first at `African bush elephant#5`, showing current scope `a midday shade and water stop` against the audited required scope `a deep river crossing during seasonal travel`.
- GREEN: the repair applies every exact recommendation from the hash-bound 184-coordinate inventory. It changes all 98 flagged scope dimensions and all 110 flagged evidence dimensions (208 total, including 24 tuples with both) and leaves zero flagged dimensions unchanged.
- Full-corpus re-audit: all 1,000 tuple coordinates reconcile exactly as 184 repaired plus 816 unflagged tuples proven unchanged at the parsed tuple level. Objects and mechanisms remain immutable, every non-corpus source field remains exact, and aggregate axis arrays exactly mirror tuple order after repair.
- No cosmetic uniqueness was added. The repaired corpus measures 603 distinct legitimate scopes, 175 method bases, and 997 distinct evidence-lens strings. The three same-subject lens reuses are deliberate claim-capable methods for King cobra venom, Axolotl regeneration, and Electric eel electrophysiology.
- The ignored semantic review was regenerated and rebound to the repaired source. It contains exactly 50 source-ordered subject rows and exactly 1,000 ordered tuple `PASS` verdicts.
- Repaired source size: 653,042 bytes, below the 1,048,576-byte task gate.
- Repaired successor document SHA-256: `cbf2e4c4edc89043ef4ca8794be987f3745c5c42eee17652cd91ab3194009020`.
- Repaired ignored semantic review SHA-256: `e6a02c46bebf9d2a799c31149090545c9998a385f3555be8764dc4f917826b7a`.
- Successor manifest SHA-256 remains `056fa7a24ff6452394b667005022e1bf5879f39bcf2cc584cbcac6155b0eddfe`.
- The successor remains exactly 50 subjects × 20 tuples with `tupleAdditions: 980`, 1,000 unique objects, 1,000 unique mechanisms, 1,000 unique object/mechanism pairs, deterministic replay, non-overlapping 500 + 500 reservations, and fail-closed exhaustion.
- Receipt identity remains revision 34 / `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3`; registry validation remains revision 34 / 108 records.

### Rescue verification

- `node .superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-repair-check.mjs` — PASS: 1,000 audited, 184 repaired, 816 unchanged/re-audited, 208 changed flagged dimensions, zero unchanged flagged dimensions, 50 review rows, 1,000 review verdicts.
- `npx tsx --test --test-name-pattern "capacity: natural-world-animals" electron/server/__tests__/topic-pack-1000-successors.test.ts` — PASS, 1/1.
- `npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts` — PASS, 8/8.
- Exact receipt verification — PASS.
- `npm run content-pack:registry -- validate` — PASS, revision 34 / 108 records.
- `npm run typecheck:electron` — PASS.
- `git diff --check 497a583c9b869f5b8eecab673c0fb35d7b4af725 --` — PASS.

Only the tracked successor content document changed. The semantic review, failure inventory, repair/check scripts, and this report remain ignored/untracked SDD evidence. No predecessor, manifest, registry, Formula, Kit, production planner, schema, adapter, package/version, lockfile, changelog, or external handoff changed.

## Exhaustive v2 semantic repair

This section supersedes the earlier rescue counts and hashes above while preserving the audit history.

- v2 repair baseline: `437a9d50ccd54d3ae68ae4b518122cd84c6fa00d` / source SHA-256 `cbf2e4c4edc89043ef4ca8794be987f3745c5c42eee17652cd91ab3194009020`.
- Exact v2 inventory SHA-256: `f1189d0e5a905057500ea6c69d6240f1004c639e4d3896cab6d742e8a88d78ab`.
- v2 repair commit: `0a59e9fecfbbff929ea296fbadf85be7d931486a` (`fix(content-packs): apply exhaustive animal semantics audit`).
- TDD RED: the v2 hash-bound verifier failed first at `African bush elephant#11`, retaining `a breeding herd during musth and oestrus` instead of the audited late-gestation scene.
- GREEN: all 251 v2 coordinates were repaired with their exact recommendations. All 91 failed scopes and 183 failed evidence lenses changed, including 23 coordinates with both; all 274 failed dimensions changed and zero remain unchanged.
- Exhaustive reconciliation: 1,000 tuples and 2,000 independent questions audited; 749 unflagged tuples remained exact; all 1,726 passing dimensions remained exact; all 56 conservative-borderline inventory rows were included in the repair.
- Objects, mechanisms, subjects, order, compatibility, identity, and every non-corpus field remain immutable. Aggregate material-axis arrays exactly mirror the repaired tuple order.
- Repaired source: 670,346 bytes; SHA-256 `a24092d8180a69ab147fdc12b4005efbf7bf1e12ecb02b492b8bfcd561758f15`.
- Truthful ignored semantic review: exactly 50 source-ordered subject rows and 1,000 ordered tuple verdicts; SHA-256 `fe48395ed8fec76e6010768ef629f1582cc0a0b2ab6469352553635a77da9c5c`.
- Measured corpus: 678 legitimate scope values, 358 method bases, 997 distinct evidence-lens strings, 1,000 unique objects, 1,000 unique mechanisms, 1,000 unique object/mechanism pairs, and 1,000 unique complete subject-bound tuples. The same three evidence methods remain deliberately reused where the mechanism warrants them; no cosmetic suffix or ordinal-template uniqueness was introduced.
- Structural capacity remains 50 × 20 / `+980`, with deterministic replay, unique fingerprints and idea keys, non-overlapping 500 + 500 reservations, and fail-closed exhaustion.

### v2 verification

- `node .superpowers/sdd/2026-08-25-topic-pack-1000-repair/task-2-semantic-repair-v2-check.mjs` — PASS: v2/current hashes bound; 1,000 tuples; 2,000 questions; 251 repaired; 749 unchanged; 274 changed failing dimensions; zero unchanged failing dimensions; 1,726 preserved passing dimensions; 56 borderline rows; 50 review rows; 1,000 review verdicts.
- Focused capacity — PASS, 1/1.
- Signed-source golden — PASS, 8/8.
- Exact receipt — PASS at revision 34 / `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3`.
- Registry validation — PASS at revision 34 / 108 records.
- Electron typecheck — PASS.
- `git diff --check 437a9d50ccd54d3ae68ae4b518122cd84c6fa00d --` — PASS.

Only the successor content document is tracked for the v2 repair. The v2 inventory, verifier, apply script, semantic review, and this report remain ignored/untracked. No predecessor, manifest, registry, Formula, Kit, production planner, schema, adapter, package/version, lockfile, changelog, or external handoff changed.
