# Paid Component Catalog — Task 1 Report

## Status

Complete on `codex/paid-component-catalog`, based on
`441d178a61170f152dfe2f255ffd6ef26dc070fa`. The final reviewed Archival Ledger tree at
`18e6bbe02f382ee7dcd1868da7052296e24222d8` was integrated as source/runtime material without
accepting its monolithic commercial shape.

## Integrated boundary

- Added the reviewed `content-packs/archival-ledger/` documents and previews as source material.
- Added signed-schema and legacy-adapter support for Formula YouTube tag hints, recipe composition
  rules, and optional recipe headline guidance.
- Retained Topic Pack `episode_objects`, `time_place_scopes`, `mechanisms`, `evidence_lenses`,
  `exclusions`, and `max_siblings_per_subject` in the runtime model.
- Integrated the deterministic generic planner behavior that reserves four materially independent
  siblings per Archival subject, including prior-campaign reservations.
- Preserved the base branch's componentized Channel Kit and bundle-only publisher hardening.
  Archival's unresolved release floor uses that existing `{{MIN_APP_VERSION}}` contract; no second
  template dialect or guessed release version was introduced.
- Kept `com.storystudio.pack.archival-ledger` as reviewed source material only. It is explicitly
  forbidden from the paid release registry. No paid registry or `content-packs/paid/` release source
  was created in Task 1.

## TDD handoff to Task 2

The original Task 1 wording requested a RED paid-registry assertion before a real component
registry existed. The plan owner clarified that Task 1 must remain green and must not introduce a
dormant/fake registry or intentionally failing test. Task 2 must begin RED against its real
component-source registry and retain these assertions:

```js
assert.notEqual(sourceManifest.pack_id, 'com.storystudio.pack.kit.archival-ledger')
assert.equal(paidRegistry.some(row => row.packId === 'com.storystudio.pack.archival-ledger'), false)
```

## Verification evidence

- Baseline: 21/21 publisher tests and 19/19 neighboring runtime tests passed on `441d178a`.
- Integrated source/publisher suite: 24/24 passed.
- Integrated adapter/planner/thumbnail suite: 22/22 passed, including 500 distinct assignments
  across 125 subjects with four distinct episode objects, time/place scopes, and mechanisms per
  subject.
- `npm run typecheck`: Electron and Nuxt typechecks passed.
- `git diff --check`: passed.
- Self-review confirmed no `package.json`, `package-lock.json`, or `CHANGELOG.md` change; no price,
  production key, `.sspack`, trust resource, purchase/publication call, or live GenStudio/fleet
  mutation; and no monolithic paid release registry entry.

## Preserved and deferred

- Legacy Hidden Mechanics of History prompt/topic/style/thumbnail parity is covered by the imported
  behavioral golden and focused runtime tests.
- Production minimum version, signing key, trust record, artifacts, component release identities,
  price, and publication remain deferred. Task 2 owns the eight component sources and the real RED
  registry boundary.
- The three upstream handoff letters listed in the Archival source report were not available during
  the reviewed source task; they remain a precondition for later GenStudio catalog publication.
