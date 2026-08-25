# Task 11 independent review checklist

This checklist reviews Task 11 only. It does not authorize building or staging from this file,
and the reviewer must not edit product/source/registry state, create external destinations, stock,
publish, deploy, tag, or push. Review evidence must come from the Task 11 implementation diff,
test output, ignored execution evidence, and independently reopened external bytes.

## Fixed review baseline

- Source/lifecycle checkpoint: commit `a2a870e4`, registry revision `33`, all ten fixed records
  `authored` after the serialized Task 10 transitions.
- Exact common receipt:
  `authoring:d2031e6ceca4f929929176891710d15dfd0b36080d490ac6150e111608fd3378`.
- Delivery profile: `genstudio-store-receipt-v1`.
- Minimum Story version: `1.0.843`.
- Maximum archive size: `52_428_800` bytes.
- Real artifact destination, which must be absent before staging:
  `<owner-home>/Developer/_handoffs/artifacts/story-thumbnail-expansion-ten-2026-08-24`.
- Real receiver path, which must be absent before staging:
  `<owner-home>/Developer/_handoffs/2026-08-24_to-claude-genstudio_from-gpt-storystudio_thumbnail-expansion-ten-candidates.json`.
- Fixed allowed order:
  `before-after-proof-panel`, `two-option-criteria-split`, `reaction-evidence-inset`,
  `cutaway-exploded-object`, `hero-payoff-companion`, `iconic-result-closeup`,
  `scale-journey`, `numbered-lineup`, `macro-mystery-detail`, `hands-on-pov-moment`.

## 1. Scope and preflight

- [ ] The durable Task 11 diff is limited to
  `scripts/content-packs/stage-handoff-artifacts.mjs` and
  `scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs`, plus only a
  narrowly necessary backward-compatibility assertion update if the existing Wave 2 contract
  genuinely requires it. No app, checkout, package version, changelog, source pack, registry,
  Kit, commerce, or runtime file changed.
- [ ] `npm run content-pack:registry -- validate` reports revision `33`, 92 records, and no
  registry lock remains.
- [ ] Every fixed recipe record is still `authored` with exact pack/item/version/publisher/kind,
  exact source path, `dependencies: []`, the common receipt, and unchanged proposed family/SKU
  state. Task 11 performs no lifecycle mutation.
- [ ] Before the real invocation, both external destinations are physically absent and no
  `.sspack` exists anywhere below `content-packs/thumbnail-recipe-expansion-ten`.
- [ ] The implementation records the plan correction discovered in `task-11-preparation.md`:
  the existing helper required a fixed named-wave extension and could not safely be consumed
  unchanged.

## 2. Staging-helper backward compatibility

- [ ] Calling the helper without `waveId` preserves the historical Reusable Primitives Wave 2
  contract: its exact five-slug order, bindings, receipt, review requirements, archive binding,
  ledger/release/receiver shapes, and lack of a newly invented receiver `status` field.
- [ ] The existing `reusable-content-primitives-pack.test.mjs` passes as an independent suite,
  including malformed partitions, exact fixed-set rejection, wrong receipt, cross-labeled
  archives, wrong evidence/profile/floor, pre-existing destinations, repository containment,
  symlinks, source mutation, exclusive-create races, cleanup/failure inventory, ancestry swaps,
  and partial-status truth.
- [ ] The ten-recipe path is selected only by exact
  `waveId: "thumbnail-recipe-expansion-ten"`; unknown, missing-for-ten, malformed, or duplicate
  wave selection fails before filesystem writes.
- [ ] The new bindings, allowed order, exact receipt, exact summaries, required review set, and
  output schema are immutable helper-owned contract data. The caller cannot inject or override
  a bindings map, expected receipt, summary matrix, status, or authority fields.
- [ ] Shared no-follow, physical-containment, stable-open/read, source-identity, bounded-copy,
  copy-hash, exclusive-create, post-write revalidation, owned-cleanup, and failure-inventory
  protections remain shared code rather than a copied weaker implementation.

## 3. Deterministic archive qualification

- [ ] For each currently eligible slug, the test and real executor build twice into a fresh
  `mkdtemp()` candidate root using exactly
  `buildContentPack({ deliveryProfile: "genstudio-store-receipt-v1",
  minAppVersion: "1.0.843" })`.
- [ ] Each pair is byte-for-byte identical and has the same lowercase SHA-256; each archive is
  positive-sized and at most `52_428_800` bytes.
- [ ] Both copies validate independently with `validateContentPack`, the exact delivery profile,
  and `includeManifest: true`; validation is not inferred from build success.
- [ ] Every manifest matches the fixed slug binding: pack ID, version `1.0.0`, publisher
  `com.storystudio`, minimum `1.0.843`, profile, one item with exact item ID and kind
  `thumbnail-recipe`, and `dependencies: []`.
- [ ] ZIP inventory is exact: `manifest.json`, one declared
  `content/thumbnail-recipe.json`, and the three declared WebPs only. Every entry is a regular
  Unix file with mode `0100644`; there is no executable bit or executable extension.
- [ ] The three archived WebPs are byte-identical to their declared source files, not recomposed,
  replaced, or regenerated during build.
- [ ] The delivery archive has no `signature.ed25519`, `key_id`, private key, publisher-key
  material, or test-signing residue.

## 4. Forbidden content and summary placement

- [ ] A semantic recursive scan of every parsed archive JSON rejects `component_summary`
  anywhere in the archive, source manifest, source content, registry, provenance, or build
  evidence.
- [ ] Parsed archive JSON and archive filenames contain no credentials, tokens, secrets,
  private/public signing material, executable content, arbitrary URL-valued strings, provider,
  model, engine, route, price, credits, discount, commerce, product, release, account, purchase,
  grant, entitlement, wire, shelf, publication, or Store-state fields.
- [ ] The forbidden scan checks recursive keys and values, not just top-level keys or a small
  filename list, and the tests include representative failures.
- [ ] `component_summary` occurs only once per delivered entry in `release-handoff.json` and in
  the value-identical matching `successful_entries` row of the receiver handoff. It is absent
  from `ledger.json`, blocked rows, archives, and every other persisted structure.

## 5. Identity, receipt, and review linkage

- [ ] Eligibility is recomputed at execution time from the current registry and evidence; a
  present source or stale PASS inventory alone cannot make a recipe eligible.
- [ ] Each delivered row matches its immutable binding for `slug`, `pack_id`, `item_id`,
  `version`, `publisher_id`, `kind`, `source_path`, and `dependencies: []`.
- [ ] The common Task 1 receipt is re-verified against each exact identity immediately before
  building/staging; a merely well-formed or other-wave receipt is rejected.
- [ ] Each delivered row carries exactly nine unique passed reviews in this order: `schema`,
  `originality-provenance`, `compatibility`, `prompt-equivalence`, `visual`, `thumbnail`,
  `safety`, `copy`, `commercial-boundary`.
- [ ] Review evidence points to the exact repository-relative Task 10 spec/quality review file
  and relevant heading/table for that slug. Generic claims, missing evidence, duplicate rows,
  `pending`, `blocked`, or `not_applicable` are rejected.
- [ ] The helper revalidates the archive's exact bound identity after preflight copy, staged
  copy, final copy, and final reopen; swapping two otherwise valid recipe archives fails.

## 6. Eligibility, blocked complement, and status equations

- [ ] `allowedSlugs` is exactly the ten unique slugs in fixed order.
- [ ] `eligibleSlugs` is unique, ordered by `allowedSlugs`, wholly contained in it, and equals
  exactly the recipes whose registry status is authored, receipt verifies, source qualification
  passes, both independent reviews are PASS, and no Important/Critical finding remains open.
- [ ] `blockedSlugs = allowedSlugs.filter(slug => !eligibleSlugs.includes(slug))` in the same
  fixed order.
- [ ] `entries.map(e => e.slug)` equals `eligibleSlugs` exactly; `blockedEntries.map(e => e.slug)`
  equals `blockedSlugs` exactly. Entry and blocked sets are disjoint, their union equals allowed,
  and no set contains duplicates, omissions, unknowns, or overlaps.
- [ ] Every blocked row is exactly `{ slug, blocker }`, with a specific failed/missing gate and
  evidence path. It contains no archive path/hash/bytes, reviews-as-passed, summary, or successful
  identity claim.
- [ ] If eligibility is empty, the helper is not called and neither destination is created.
  Any staging failure delivers zero rows and never becomes partial success.
- [ ] Receiver `status` is helper-derived, never caller-selected:
  `ready-for-owner-stocking` iff phase is complete, all ten fixed slugs were delivered in exact
  order, and blocked is empty; otherwise a persisted complete partial transaction is exactly
  `partial-ready-blocked` with a non-empty exact complement.

## 7. Exclusive absent-path staging and failure safety

- [ ] Tests use only test-owned temporary roots and assert the literal real destination strings
  without touching them.
- [ ] Real execution uses a fresh temporary candidate root and requires both real destinations
  absent. It never overwrites, renames, auto-deletes, or reuses a prior artifact root or receiver
  handoff.
- [ ] Repository, candidate, artifact-parent, receiver-parent, artifact-root, and staging-root
  ancestry/physical identities are checked with no caller-controlled symlink. Artifact and
  receiver destinations are outside the repository and do not contain each other.
- [ ] All candidate, staged, final archive, ledger, release, and receiver creation uses exclusive
  no-follow semantics. A competing path is preserved and never deleted by cleanup.
- [ ] Candidate bytes are stable-opened, bounded, hashed, and identity-checked before and while
  copying. Equal-size rewrites, growth, path replacement, source escape, ancestry swap, and
  symlink races fail closed.
- [ ] After-root failure removes only paths whose owned device/inode identity still matches,
  writes truthful `failure.json` only inside the still-owned artifact root, leaves the receiver
  absent, and never redirects success/failure evidence into attacker-controlled ancestry.
- [ ] `afterPhase` remains test-only; the real invocation passes no race hook.

## 8. Exact output schemas

- [ ] `ledger.json` top-level keys are exactly `schema_version`, `entries`. Each row has exactly
  `absolute_path`, `bytes`, `delivery_profile`, `min_app_version`, `receipt_ref`, `reviews`,
  `sha256`, `slug`; it has no Story identity expansion and no summary.
- [ ] `release-handoff.json` top-level keys are exactly `schema_version`, `entries`. Every row
  contains the ledger evidence plus exact Story `pack_id`, `item_id`, `version`, `publisher_id`,
  `kind`, `source_path`, `dependencies`, and its exact `component_summary`; no other keys occur.
- [ ] Receiver top-level keys are exactly `schema_version`, `status`, `artifact_root`,
  `ledger_path`, `successful_entries`, `blocked_entries`, `explicitly_not_done`.
- [ ] `receiver.successful_entries` is JSON-value-identical to `release-handoff.entries`; blocked
  entries are the exact complement; every archive filename is exactly `<slug>.sspack`.
- [ ] Paths, byte counts, lowercase SHA-256 values, profile, minimum, receipt, identities, reviews,
  and summaries agree across archive validation, ledger, release handoff, and receiver.

## 9. Exact component-summary literals

Every delivered summary object must have exactly four keys and no others:
`schema_version: 1`, `kind: "thumbnail-recipe"`, the exact literal below, and
`slots: { "thumbnail-recipe": 1 }`.

- [ ] `before-after-proof-panel` — `Matched before-and-after states show one subject changing across a truthful temporal seam.`
- [ ] `two-option-criteria-split` — `Two present-time alternatives receive equal visual weight for an honest criteria-based comparison.`
- [ ] `reaction-evidence-inset` — `A reaction subject directs attention to one original in-scene evidence detail.`
- [ ] `cutaway-exploded-object` — `One object opens into an ordered, readable view of its meaningful internal layers.`
- [ ] `hero-payoff-companion` — `A generic hero visibly interacts with a separate, tangible result object.`
- [ ] `iconic-result-closeup` — `One truthful finished outcome dominates the frame at a detail-revealing angle.`
- [ ] `scale-journey` — `Three related forms progress through continuous depth to communicate scale or magnitude.`
- [ ] `numbered-lineup` — `Three to five equal-status entries form a precise lineup with matching native numerals.`
- [ ] `macro-mystery-detail` — `An extreme close detail creates bounded curiosity while a small honest clue preserves context.`
- [ ] `hands-on-pov-moment` — `First-person or over-shoulder hands perform one clear, safe action in task context.`

- [ ] No summary contains identity, version, digest, dependencies/closure, family/SKU, price,
  Store state, receiver authority, or GenStudio product/release/account/wire data.

## 10. Independent external reopen

- [ ] After staging, the reviewer independently reopens every delivered `.sspack` from the
  external artifact root, recounts bytes, recomputes SHA-256, validates the exact delivery
  profile with manifest inclusion, and rechecks bound identity/floor/dependencies/file inventory.
- [ ] All three external JSON files parse. Their exact key sets, ordering equations, status
  equation, cross-file value equality, and component-summary placement pass independently of
  the staging helper's returned object.
- [ ] The reopened archive count equals eligible count; there are no extra archives, missing
  archives, `.staging` paths, keys, signatures, temporary files, or repository archives.
- [ ] A semantic recursive scan proves `component_summary` exists only in delivered release and
  receiver successful entries, never by relying on raw text occurrence alone.

## 11. Receiver authority and commercial boundary

- [ ] `explicitly_not_done` is exactly, in order: `upload`,
  `product-or-release-draft-creation`, `price-or-discount-decision`, `purchase`, `grant`,
  `publication`, `production-signing`, `deploy`, `push`.
- [ ] The receiver is a local, non-mutating candidate handoff only. Its ready status means the
  bytes are ready for a separate owner stocking decision; it does not grant GenStudio authority
  to upload, create a product/release draft, stock, price, discount, activate, publish, sign,
  purchase, grant, alter a Channel Kit, deploy, tag, or push.
- [ ] No GenStudio API/admin call, Store/catalog mutation, commercial decision, customer-data
  change, Channel Kit mutation, external upload, publication, deploy, tag, or push occurred.
- [ ] No invented GenStudio product/release/account/receipt/purchase/grant/wire identity appears.
  Story identities and the Story authoring receipt remain visibly distinct from GenStudio-owned
  identities and later stocking authority.

## 12. Required review evidence and verdict

- [ ] Focused tests pass together:
  `node --test scripts/content-packs/__tests__/thumbnail-recipe-expansion-ten-pack.test.mjs`
  and `node --test scripts/content-packs/__tests__/reusable-content-primitives-pack.test.mjs`.
- [ ] Task 12 matrix passes: registry validation; authoring-registry and new pack tests; source
  test 12/12; Electron typecheck; security; model-drift; and `git diff --check`.
- [ ] The durable commit contains only reviewed helper/test changes. Ignored SDD execution files,
  candidate roots, `.sspack` files, external ledgers/handoffs, and receiver files are not in Git.
- [ ] The review report states `PASS` only if every applicable item above is evidenced. Any
  discrepancy names the exact slug/path/gate, marks delivered eligibility truthfully, and blocks
  stocking authorization until corrected.

