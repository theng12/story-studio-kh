# Content Catalog focused integration qualification

Date: 2026-08-16

Status: **Final release qualification GO (C0/I0/M0).** The focused integration
evidence below remains historical; the final full-repository verification,
unsigned packaged-artifact qualification, and packaged QA are recorded in the
final ledger below. This is not production sealing, GenStudio draft stocking,
publication, installation, or restart authority.

## Immutable code identity

- integration base: `58dda52214a873cf0b697d961cae31c58b00a64b`
- clean integration start: `26e2f025e5b10f46825a96934874ca4d839ad4b5`
- qualified integrated code head: `15a46d48d95d46c2a74d199a27947db617bd5478`
- integration evidence commit and release metadata parent: `a2b743f425cb0f7b9044f0b5228465cae6acc1c8`
- release metadata version: `1.0.842`
- release metadata identity: the direct child commit of the metadata parent
  containing this report, the bounded version/changelog/migration files, and
  the `ContentProductCard.vue` shared typography-token correction required by
  the release source gate
- base-exclusive commit count: 96
- merge commits after the integration base: 0

## Final release identity and review

- final code and artifact head: `0664bf1dda8ccd067d67e5be41da01f4682f9a0c`
- release metadata version: `1.0.842`
- final base-exclusive code/artifact commit count: 101
- merge commits from integration base through final code/artifact head: 0
- final independent review verdict: **GO — C0/I0/M0**
- this ledger commit is documentation-only and follows the final code/artifact
  head; it does not change the qualified code or artifact identity.

## Reviewed correction mapping

| Concern | Reviewed source | Applied commit | Verdict |
| --- | --- | --- | --- |
| Per-account retained Store proof and active-account ownership separation | `63525e2eb2b58f6bde609a7685d4888bdc080d5f` | `2f086d613506bf7b35b44682686623a88416a2e1` | GO |
| Bounded safeStorage/key-history anchor updates | `2e8f7a668e7fba4d5940f1b0d902c68704b08462` | `a61a4de66fa5f7e65b3d3ad068a2c80fb611d7a8` | GO |
| Transactional bundle activation and rollback | `6bed1651b173b1442cfa9b39bd3d0421f1821a1d` | `370891e64f8c5713e4319fe8ddb3a7c9e9660fcd` | GO |
| Cross-process bundle transaction serialization | `b3ce6423c1528e3ca5f968f112cca2b5f7ee622b` | `564ad9f527d0200bec0d6d66c940f210c3936b57` | GO |
| Strict published video price-row validation | `c78383658e6cbd84371ba70f91907f8bf31c6941` | `15a46d48d95d46c2a74d199a27947db617bd5478` | GO |

All five cherry-picks applied in the required order. There were no conflicts
and no merge commits. Git performed routine content auto-merges in
`electron/server/content-packs/installer.ts`; no manual resolution was needed.
The current authoring-registry lifecycle/source-kind dispatch and model-drift
annotations remained present.

## Qualified source identities

Git object IDs at the qualified code head provide deterministic source-tree
identity without retaining a generated archive or key:

- `content-packs/`: `f874e2e897a57afb71605b8de57ee50348337262`
- `content-packs/free-starters/`: `afad771284746bcfcb58ae3f274cc2f6dd5bcf57`
- `content-packs/archival-ledger/`: `54531b59cbb60a59de41b03844960fbf2886f849`
- `content-packs/authoring-registry.json`: `d3f3b85054d20460e03de940b83bfd93f25f442b`
- `scripts/content-packs/`: `077e55062302a258b35c6773186f7c2cb8d39978`

## Fresh focused evidence

1. `node --test scripts/content-packs/__tests__/*.test.mjs`
   - PASS: 84/84, including 29/29 authoring-registry tests.
2. `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-*.test.ts electron/server/__tests__/content-store-*.test.ts electron/server/__tests__/genstudio-content-store-*.test.ts electron/server/__tests__/genstudio-capacity-and-variants.test.ts electron/server/__tests__/genstudio-video-tts-transcription-hardening.test.ts electron/server/__tests__/motion-prompt.test.ts`
   - PASS: 355/355 across 22 suites.
3. `cd frontend && npx tsx --import ./__tests__/setup.ts --test __tests__/motionReview.test.ts`
   - PASS: 5/5.
4. `npm run typecheck:electron`
   - PASS.
5. `npm --prefix frontend run typecheck`
   - PASS. Nuxt reported the existing local development proxy derived from
     per-machine `app-settings.json`; no setting was written.
6. `npm run lint -- --quiet`
   - PASS with zero errors.
7. `npm run check:security`
   - PASS: production security check passed.
8. `npm run check:model-drift`
   - PASS: 563 source files, 26 annotated exceptions.
9. `git diff --check`
   - PASS.
10. `find content-packs scripts/content-packs -type f \
    \( -name '*.pem' -o -name '*.sspack' \) -print`
    - PASS: no generated key or archive remained in either source tree.

Expected negative-path error logs appeared only inside adversarial tests for
corrupt archives, failed Store delivery, and invalid user-fork selection. The
test runner reported zero failures, cancellations, skips or todos.

## Final full-repository and packaged-artifact evidence

All commands below ran once at final code/artifact head
`0664bf1dda8ccd067d67e5be41da01f4682f9a0c`, with a clean worktree and
`git diff --check` clean before and after qualification.

1. `npm run verify`
   - PASS, exit 0: backend 2698/2698 across 408 suites; frontend 699/699
     across 96 suites; release 11/11 across 2 suites.
   - Lint: 0 errors, 1,721 existing warnings (12 fixable). Changelog,
     typography, source and built security, model drift (563 files, 26
     annotated exceptions), source and built release checks, Nuxt static build,
     and Electron compile passed.
   - Durable log:
     `<owner-home>/Developer/_handoffs/story-studio-kh-v1.0.842-verify-0664bf1-20260816.log`
     — SHA-256 `e7e4a785bd7c534b2a8f4af63a0e10af03a2eda358f3ac654721cbc3e65f04ce`.
2. `npm run dist:smoke`
   - PASS, exit 0: unsigned arm64 DMG built, inspected, mounted read-only, and
     detached. Artifact: `dist/Story Studio KH 1.0.842-arm64.dmg`.
   - 238,357,296 bytes; SHA-256
     `15b06b69cbf76ae6ef34c210958c9105341584d602c04f9a7bbd06f6636ca2a7`;
     bundle `com.storystudio.kh`; version `1.0.842`; arm64; ad-hoc signature
     with no Developer ID (expected for the unsigned smoke flow).
   - Durable log:
     `<owner-home>/Developer/_handoffs/story-studio-kh-v1.0.842-dist-smoke-0664bf1-20260816.log`
     — SHA-256 `4bf9cb5ff86ffcba0b104e07060f56912e2ec607228e380a52ec0fb78c3b3298`.
3. `npm run check:release -- --built --package-input`
   - PASS, exit 0: source contract, built startup, and package inputs passed.
   - Durable log:
     `<owner-home>/Developer/_handoffs/story-studio-kh-v1.0.842-check-release-built-package-input-0664bf1-20260816.log`
     — SHA-256 `2deb6aa4515930aee152286396f50c0aa1639649fb821123d501af4d920fe8f7`.
4. `npm run verify:artifact -- --app "dist/mac-arm64/Story Studio KH.app" --dmg "dist/Story Studio KH 1.0.842-arm64.dmg"`
   - PASS, exit 0: independently repeated the exact bundle/version/architecture,
     ad-hoc signature, SHA-256, and read-only mount checks.
   - Durable log:
     `<owner-home>/Developer/_handoffs/story-studio-kh-v1.0.842-verify-artifact-0664bf1-20260816.log`
     — SHA-256 `f1aced1d98ac40c761285e317cb93b029c77b3ce25cb4a64c0d3dd62729ef743`.
5. Packaged QA
   - GO: the packaged UI retained 44×44 minimum interactive targets and the
     critical Content Store quote facts — total, discount, balance, expiry,
     status/refusal, and explicit confirmation — without inventing a quote or
     spending action.

## Remaining external gates

- Production sealing and the immutable archive ledger are not complete and
  require explicit owner authority plus the GenStudio sealing operation.
- GenStudio draft stocking is not performed.
- No public publication, installation, restart, merge, push, deployment,
  purchase, or live generation is authorized or recorded here. The unsigned
  smoke artifact is not a customer distributable release.
