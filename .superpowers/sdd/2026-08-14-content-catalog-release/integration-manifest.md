# Content Catalog integration manifest

Date: 2026-08-15

Status: Task 1 integration is complete. Release preparation, version binding,
production signing, packaging, publication, merge, push, install, restart, and
deployment remain outside this checkpoint.

## Immutable integration identity

- Repository: /build/Developer/story-studio-kh
- Worktree: /build/Developer/story-studio-kh/.worktrees/content-store-release-foundation
- Branch: codex/content-store-release-foundation
- Integration base: 58dda52214a873cf0b697d961cae31c58b00a64b
- Integrated code head before this manifest-only commit:
  ad7cddc00a4281c54b4244386c3ec224d07a47a7
- Package version intentionally retained: 1.0.841
- Merge commits in every source range: 0
- Merge commits after the integration base: 0
- Source commits checked: 57
- Unique stable source patch IDs: 57
- Duplicate stable source patch IDs: 0
- Integrated commits before this manifest: 55
- Unique stable integrated patch IDs: 55
- Duplicate stable integrated patch IDs: 0

The pricing and exact video-operation work was already present in the selected
main base. It was not cherry-picked again. Every other source range below was
applied once in dependency order. The two additional integration commits are
the navigation version deferral and the final combined-schema normalization.

## Validated source ranges

Each base is an ancestor of its head. The included lists are the complete
oldest-first base-exclusive ranges. git rev-list reported zero merge commits
for every range.

### Main pricing and exact video-operation base

- base_sha: 90e3984428ece87967d4e5638a0c4ae6f0f5c3c2
- head_sha: 58dda52214a873cf0b697d961cae31c58b00a64b
- included_sha:
  1. 2562e8a865b397e59fa8301b31cac1dad0d91ab4
  2. 6880988c2894ecb86c1330eee473d7c7cf8ef576
  3. 5a17093f32dc18d553877b28b57ea9376b7e53b1
  4. 58dda52214a873cf0b697d961cae31c58b00a64b
- disposition: already present in the integration base; not replayed.
- review evidence: final independent review supplied to the integration owner
  reported C0/I0/M0. Combined preservation suites covered published pricing,
  video variants, operation-bearing Motion Review payloads, and fail-closed
  missing-operation behavior.

### Shared GenStudio Content Store adoption

- base_sha: 90e3984428ece87967d4e5638a0c4ae6f0f5c3c2
- head_sha: 35eb3942c0090925065d7268acb979105f77c086
- included_sha:
  1. 9c0830833e8cb18322f18ae305f62a84cd610b09
  2. 35eb3942c0090925065d7268acb979105f77c086
- applied_sha:
  1. ac9b9142bd691e82ed870f49e635f4f401c663b4
  2. a8c04203b5b4416a352ba67808e2b175d584729c
- review evidence: independently accepted adoption heads supplied to Task 1;
  combined GenStudio client, Content Store client/delivery, route, pricing, and
  no-double-charge tests passed.

### Componentized Channel Kit schema and publisher

- base_sha: 35eb3942c0090925065d7268acb979105f77c086
- head_sha: 441d178a61170f152dfe2f255ffd6ef26dc070fa
- included_sha:
  1. ed87277c62e21bcf23040ddc9973542277ebb4c5
  2. 441d178a61170f152dfe2f255ffd6ef26dc070fa
- applied_sha:
  1. 9ea46a7051964dd5808434062aa79f68c8beb656
  2. aac63b12b92dad1c8cbafb9e63b2958f4e4b1c3e
- review evidence: independent schema/publisher review passed before
  integration. The combined contract, archive, installer, publisher, and
  deterministic-build suites passed.

### Catalog presentation boundary

- base_sha: 35eb3942c0090925065d7268acb979105f77c086
- head_sha: 1ed013f32c5340c54fa0199869ed8cdbe32f1dc8
- included_sha:
  1. ffeafe6081aea1e712202037e83d5f54ccbce9e8
  2. 1ed013f32c5340c54fa0199869ed8cdbe32f1dc8
- applied_sha:
  1. 4bce3064fefbe205a988b7306510508c979ec394
  2. 600bee3cb9c6ee7b5d9b9b85e150405124b6d632
- review evidence: Task 1 presentation review reported PASS/APPROVED. The
  combined presentation tests passed for server ordering, published search
  text, filters, shelf identity, HTTPS media, and fail-closed unknown products.

### Free Starter Channel Kits

- base_sha: 441d178a61170f152dfe2f255ffd6ef26dc070fa
- head_sha: 1d6348afc2753c5e445182d52173bcd04ddd5fd1
- included_sha:
  1. 14600f22a99bd8461b1dcfaa6cc7de9869fc15d1
  2. e5867c4d928b47923e4cb7c17a86dadbcd02f8bf
  3. cad6e62cc6fb78ee3abf36dd270923fe4f0b75c1
  4. 31a908e131b84be8c570d65cbd7479e62768e523
  5. 18d421e2c9acf282d95c3c597fed1852dc8ebacc
  6. 1e97044aa2ad69288e814b16419fc61687cf78fc
  7. f27fca18c458203628846608a26554a6e0df44ab
  8. 3baff05d40c337ae95df376feb673842971893f4
  9. fe14f7d096bdf5220c982c303d3458aa7f329a8d
  10. 8546d2f1d8f0d65bf2200c40eca293dfe138191d
  11. 293b0b589fe62bac557909b03d9643f9a34b2f0a
  12. 9ae6004a707d7f3ab460b1cca5dc1609764b4873
  13. 2978795ceec73563fb2895f39e9c318c73c76067
  14. e77462d253a5ecd1709ce83eb7e884283b6dcb94
  15. cfa922a488a159aff2953c3070391f1a98c9fa5f
  16. 4eede79afb28b9f154385b0451cb989f0aef3c50
  17. d4cc5bb4781a9393d2dc6d7d10566f15b7094226
  18. 46d6b4297823736665eeb35f4a575ce303e232c1
  19. 505966b29d828b9160872cebf1343669061b4db8
  20. 70e824f84bdafc24d5be615c344d6e2de15c114d
  21. 72b7b9148cd43fe6b44d07c6ec93a8ea9f3bdf0f
  22. f45a166e69e0ca710d3619fac1cc2f77ce280d18
  23. faf2d3d40a958385381fc00cbccc8bb24d869701
  24. 1d6348afc2753c5e445182d52173bcd04ddd5fd1
- applied_sha:
  1. ba4e8e90af5908a0fd81594e32f7b4f81abed7c9
  2. 2e45ed775951799fe4b48f9c6e7ad7675c3b0cf3
  3. 940f6efb8e05cc32571c55d906e0dcb6e7edea6b
  4. 1b9362fd15e96575e43243fd94c11c92013873bd
  5. 0fbf53d704bd610e5c23545c37ffc1adae2e5088
  6. a56909b196e9de23a1a959c1520b8432cfad6b0b
  7. e2e423e382c940bcf778cb2ce94f3cd81dd58012
  8. 77ba79f7d304ff07412a9d23e16adfe6285b6aeb
  9. 4dc824bec0b70d7ea958b52954dbaaa99f677f94
  10. 45825860ef2b450d79fb688bdef088bf12ae198a
  11. ccf49b346c60bb45be25b115b1bbf3a4dae79013
  12. cd368b8d4a05c2c8331b6391db573c176cdc2eb6
  13. da9ffc7529e8085b3303585bcd89f255705e98da
  14. 3fcc4a7a66ab1d2b0a29ca417cbbc408ddb737c8
  15. fea5a7bf182b80c7f636ad47e7c4a53e03b999a1
  16. 7cff4695055c7bd53e00f5f2be8a28bdd80cab5f
  17. 955c611992af1738e28a10ec9679c458458ea36e
  18. 1d84d7538ccf1580b388a4cd77abba88155545a2
  19. 8c9a80ded78f6a9be151d78e13df4406cac7cb4a
  20. b8a7c5efb44b9d0256b6197e88ee5d7930a21736
  21. 6d0b49b9509198b8d295d9bac5926623532debde
  22. 069b22d584a928c5e4a831553bb8ba31c3debab8
  23. c92d7ae5b4ae49a15be7f498bb47abb4ed855af6
  24. d5b906b2a2c8730c9b6cf835d4e524069feb77df
- review evidence: the parent-supplied final independent gate was GO at exact
  head 1d6348afc2753c5e445182d52173bcd04ddd5fd1. Combined tests proved all ten
  kits, source fidelity and provenance, zero-credit same-account ownership,
  offline exact-pin resolution, per-subject authored profile atomicity,
  deterministic reservation, and structurally new resume assignments.

### Paid Archival Ledger components and coordinator

- base_sha: 441d178a61170f152dfe2f255ffd6ef26dc070fa
- head_sha: 422ae0fe14692d555b87f3239142e0802cf9ca2f
- included_sha:
  1. badbf3814452dd624d1247c42e4226a5a6efdb79
  2. 8e65f1ddd5f09b8f2808319a06987334e5a05981
  3. 1578dcd85e8408e9e721994c45d6cf73d506d782
  4. 82488395f3d0c97ab3267a37fc75295523cc8cd9
  5. 23869979654d745b48bcde38239a45b2c0ca4d4c
  6. b67b76e57f60f9b0618f14326185de9209cd4049
  7. 199246927246a3fccbfeb19754c25ecf89188b98
  8. 404b2d5ef7773683542edbe98cb8c61310e5ebb3
  9. 422ae0fe14692d555b87f3239142e0802cf9ca2f
- applied_sha:
  1. 62758a57450cecde95a3a24f0611496064ef4e53
  2. cca4099cea959a77b1586ed63a01bedfa5512440
  3. 656bfb29bf36393f73c0c108c4e94c5ac92749da
  4. 2b6663ecdf8d84e12626acc681a0bc49ef528324
  5. 52893960c6a89916731fd9da5c85cbb57352efe1
  6. 105040131d775200c4974c97540163f56acc40b7
  7. b1a8a0d4b08d5dc01ebc59ea510b82d055bcb5eb
  8. 41faa25d62ce3e1563403ff2fa86e6e012762797
  9. 4b1745069608918f65fdb0e2146a8d784e3cf5af
- review evidence: .superpowers/sdd/2026-08-14-paid-component-catalog/progress.md
  records the pre-Task5 aggregate GO with C0/I0. Combined tests passed for the
  eight stockable components, source-only monolith refusal, exact coordinator
  closure, 500 assignments with four distinct material dimensions per subject,
  missing-only reservations, grandfathering, and explicit migration locking.

### Content Store navigation and package guards

- base_sha: 90e3984428ece87967d4e5638a0c4ae6f0f5c3c2
- head_sha: e94b4d2dde8db8aa00439f34bb8cc06024c0120e
- included_sha:
  1. a309cb3d3ff894b1de51f8a3b747eece4d2862f5
  2. e94b4d2dde8db8aa00439f34bb8cc06024c0120e
- applied_sha:
  1. 19940ebd681b50c49df8a6ccf220f3e674563516
  2. 8be2498d49b656d2b2f2c8ca8dff2625aff29e66
- integration-only normalization:
  94bf951bfabbb1b6171fbfa6fa1df153b33d4666
- review evidence: independent navigation review supplied to Task 1 reported
  C0/I0. Mounted page, in-place scope refusal, route/chunk package input, and
  release utility tests passed.

### Stale Scene Review render-state reliability

- base_sha: 90e3984428ece87967d4e5638a0c4ae6f0f5c3c2
- head_sha: e14c6d1f27f8cbdd44fbb8c5a3e1bc41dcd95218
- included_sha:
  1. 0e4cd04ef029ba7294d717e1c0876a791b12e781
  2. 1a32e913718a7c4a1acf53c28672261ec281325c
  3. 2a129bb7f2604e224a1874fcb9dffce21d86ee29
  4. 72b063a21de133705abb250d439f8aac3b613806
  5. b6143164f51e4061f8a75947c3a796cec746e110
  6. ed1aba96b834147cbf145e3aeb8a90955d273204
  7. e14c6d1f27f8cbdd44fbb8c5a3e1bc41dcd95218
- applied_sha:
  1. 43dd2108116855cea0a94cca85b85329131b9acc
  2. 64bcc5adffa906a11a21a12c7b68676fa9bf116f
  3. cd15a185b4cbb5f7df0214dbda89261c82ad1f50
  4. 735ad6542cea7a8b6b3ab4536d871cfe4bae658f
  5. 829f82fb85eb9e47a88d27f0b8a975c108ee9590
  6. 3c8d082104a4b617146ea00d76a579672e221739
  7. a9b5923d273f0214ceda1434f993b75202607c32
- optional disposition: included. The final independent gate supplied to Task
  1 was GO with C0/I0/M0 at e14c6d1f. The committed task report also records an
  earlier GO at 72b063a2. Combined backend and frontend tests covered active
  owner reconciliation, paused state, cross-process locking, terminal cleanup,
  and a newer active successor after a cached terminal batch.

### Approved design and implementation plans

- base_sha: 90e3984428ece87967d4e5638a0c4ae6f0f5c3c2
- head_sha: 2e59991ae99b305f3cecf8105f95747be060098f
- included_sha:
  1. 2acf4168a9e51a3a38a5b6dfbbe32eeb7be60b1e
  2. 54773747bad4fa378375943645b779af167e0ed8
  3. c02e88d15d2f600b3e5d287882b3de2235ed3031
  4. a80419661674b7d740373ce505fcc730084110d9
  5. 2e59991ae99b305f3cecf8105f95747be060098f
- applied_sha:
  1. aab35b5bbdaf61bf8772f11d605814a539471fa0
  2. 93be29a2557ff70b158f8e339d19df730a028745
  3. f3d4b9180f28c46a748d25642d2f283cf9df13c4
  4. 761a7c6e62ea24cdc056c622b775924e5f0f9dce
  5. 9b555d6f13e1bf75a7991ad59803508700b38052
- review evidence: approved owner design and corrected dependency/range plans;
  these were applied last without conflict.

## Conflict and normalization record

1. Navigation test placement conflicted with the already-adopted recalled
   release regression. The resolution retained the recalled-release test and
   added the initial content:read scope-refusal test. The source navigation
   branch had prematurely advanced package/changelog metadata to 1.0.842.
   Commit 94bf951bfabbb1b6171fbfa6fa1df153b33d4666 removed only that premature
   release entry and restored package.json and package-lock.json to 1.0.841.

2. The paid first commit conflicted with the reviewed free Topic Pack schema,
   adapters, runtime types, planner, and their tests. The resolution in applied
   commit 62758a57450cecde95a3a24f0611496064ef4e53 preserves both contracts:
   coverageProfiles and coverageGroups remain authored atomic tuple lanes;
   episodeObjects, timePlaceScopes, mechanisms, evidenceLenses, and exclusions
   remain signed generic planning dimensions; both are projected by the
   adapter; no niche ID or title text selects planner behavior.

3. The first combined planner run returned 458 rather than 500 Archival
   assignments. Root cause was greedy seeded sorting of generic candidates:
   hash order could consume overlapping values before four independent
   episode-object, time-place, and mechanism values were selected. The
   generic-only resolution primary-ranks the first independent diagonal tuples
   before hash-sorted reserve candidates. It leaves coverage profile/group
   paths unchanged. Final tests prove Archival 500/500 with four siblings for
   each of 125 subjects, missing-only continuation across prior reservations,
   free profile atomicity, HMH 1000, and Deep Time 1000.

4. Automatic schema merging retained youtube_tags_hint twice in one Zod object.
   Electron typecheck caught the duplicate. Commit
   ad7cddc00a4281c54b4244386c3ec224d07a47a7 removes the duplicate declaration;
   the field remains supported once and its adapter regression passes.

5. Shared GenStudio adoption, bundle schema, presentation, free source content,
   the remaining paid commits, stale-render work, pricing/video behavior, and
   plan documents required no other semantic conflict resolution. Existing
   unrelated user work was not overwritten.

## Combined verification evidence

Final integrated code at ad7cddc00a4281c54b4244386c3ec224d07a47a7:

- 287/287 broad backend tests passed: Content Pack archive, contracts,
  installer, adapters, migration goldens, free ownership, commerce routes,
  GenStudio clients/delivery, planner, paid grandfathering, Scene Render,
  pricing, capacity/variants, and settlement/no-double-charge.
- 98/98 frontend tests passed: Content Store state and navigation,
  presentation, model menus, published pricing, exact Motion operation,
  dialog focus, thumbnail vision, and Scene Review owner reconciliation.
- 61/61 publisher/release tests passed: all free and paid source inventories,
  deterministic ephemeral-key builds, provenance, component/coordinator
  closure, publisher safety, and release utility route/chunk checks.
- 60/60 post-resolution contract, adapter, planner, free source, and paid
  grandfathering tests passed.
- Electron typecheck passed.
- Nuxt typecheck passed.
- ESLint exited 0 with 0 errors. The repository remains warning-mode and
  reported 1,721 existing warnings.
- Production security check passed.
- Model-drift check passed across 555 source files with 15 annotated
  exceptions.
- Changelog/package consistency passed at 1.0.841.
- Range diff check passed.
- The independent integration review found one Important plan-compliance gap
  and no code defect: this manifest was absent. This commit closes that gap.

## Deferred release and external gates

- Final version and newest changelog entry are deliberately deferred. The
  integration remains 1.0.841 until release Task 2 binds the next version.
- A production Ed25519 public key identity has not been supplied or committed.
  No production private key may enter this repository, worktree, log, handoff,
  or command history.
- Production pack signing and immutable archive ledgers require their explicit
  owner gate and external signing operation.
- GenStudio still owns the signed merchandising, bundle entitlement,
  quote/promotion, stocking, upload, and publication contracts. Story Studio
  does not invent those fields. Catalog Experience work that consumes those
  live contracts and paid Task 5 remain gated on the exact GenStudio contract
  handoff and qualification.
- No desktop package, DMG, merge to main, push, tag, public release, install,
  restart, deploy, GenStudio mutation, purchase, or paid generation occurred.
- This Mac remained control/development-only and performed no fleet generation,
  rendering, voice, audio, video, image, transcription, chat, or transcoding.
