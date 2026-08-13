# Story Content Pack Contracts and Publisher Tooling Implementation Plan

> **For Codex:** Execute this plan with `superpowers:subagent-driven-development`, one task at a time, using strict RED→GREEN TDD and per-task review.

**Goal:** Give Story Studio one strict, signed, non-executable `.sspack` contract and first-party publisher tooling without changing any customer catalog, project selection, GenStudio request, billing, or generation behavior.

**Architecture:** Zod schemas are the single source of truth for the pack envelope and its four initial content item kinds. A pure library validates normalized archive entries, exact raw manifest bytes, SHA-256 bindings, namespaces, limits, and Ed25519 signatures. A small Node CLI builds and validates first-party archives through that same library. Runtime installation, activation, entitlement networking, catalog migration, and store UI remain separate follow-up plans.

**Tech stack:** TypeScript, Node `crypto`, Zod, JSZip, `node:test`, existing repository scripts.

**Approved source:** `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`

## Non-goals for this plan

- No GenStudio calls, prices, entitlements, checkout, account identity, or secrets.
- No renderer route or UI.
- No activation state, project pinning, compatibility adapter, or migration of current built-ins.
- No private publisher key in source, fixtures, packaged resources, logs, or test snapshots.
- No executable content, arbitrary URLs, provider/model IDs, fonts, SVG, HTML, CSS, or scripts.

## Task 1: Define the strict v1 contract

**Files:**

- Create: `electron/server/content-packs/schemas.ts`
- Create: `electron/server/content-packs/types.ts`
- Create: `electron/server/__tests__/content-pack-contract.test.ts`

**Step 1: Write failing tests**

Cover a valid manifest and one item of each initial kind:

- `series-formula`
- `topic-pack`
- `visual-style`
- `thumbnail-recipe`

Assert strict rejection of unknown fields, non-namespaced IDs, invalid exact semver, range dependencies, undeclared item paths, unsupported MIME types, URLs, provider/model IDs, and executable-looking extensions. Assert `channel-kit` is a manifest bundle reference, not a fifth content document schema.

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-contract.test.ts
```

Expected: FAIL because the content-pack schemas do not exist.

**Step 2: Implement the smallest strict schemas**

Export:

```ts
export const CONTENT_PACK_FORMAT = 1 as const
export const ContentPackManifestSchema: z.ZodType<ContentPackManifest>
export const ContentPackDocumentSchema
export const ContentPackBundleSchema
export function parseContentPackManifest(input: unknown): ContentPackManifest
export function parseContentPackDocument(kind: ContentPackItemKind, input: unknown): ContentPackDocument
```

Use qualified lowercase reverse-DNS IDs, exact semantic versions, bounded strings/arrays, `.strict()` throughout, and only relative in-pack raster references. Define types from `z.infer`; do not duplicate manually maintained interfaces.

**Step 3: Run focused GREEN**

Run the Task 1 command and `npm run typecheck:electron`.

**Step 4: Commit**

```bash
git add electron/server/content-packs electron/server/__tests__/content-pack-contract.test.ts
git commit -m "feat: define signed content pack contract"
```

## Task 2: Verify immutable archive integrity and publisher signatures

**Files:**

- Create: `electron/server/content-packs/archive.ts`
- Create: `electron/server/content-packs/signature.ts`
- Create: `electron/server/__tests__/content-pack-archive.test.ts`
- Create: `electron/server/__tests__/fixtures/content-packs/test-publisher-public.pem`

**Step 1: Write failing tests**

Generate an ephemeral Ed25519 keypair inside each test; persist only a public test key fixture if a stable fixture is needed. Build archives in memory and assert:

- detached signature covers the exact raw `manifest.json` bytes;
- every declared file matches SHA-256 and byte size;
- no undeclared file exists;
- archive path normalization rejects absolute paths, `..`, backslashes, duplicate normalized paths, case collisions, and Unicode-normalization collisions;
- symlink/external attributes are rejected;
- entry, compressed, expanded, JSON, raster, and per-file limits are enforced;
- only `manifest.json`, `signature.ed25519`, declared JSON, and declared PNG/JPEG/WebP files are admitted;
- tampered manifest, content, asset, signature, namespace, or key ID fails without extracting anything.

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-archive.test.ts
```

Expected: FAIL because the verifier does not exist.

**Step 2: Implement pure verification**

Export:

```ts
export interface ContentPackVerificationPolicy {
  publisherKeys: ReadonlyMap<string, { publisherId: string; publicKeyPem: string }>
  limits?: Partial<ContentPackArchiveLimits>
}

export async function verifyContentPackArchive(
  archiveBytes: Uint8Array,
  policy: ContentPackVerificationPolicy,
): Promise<VerifiedContentPack>
```

Return verified in-memory bytes and parsed documents only after all checks pass. Do not write to disk. Keep the implementation pure so the later installer can stage and atomically activate it.

**Step 3: Run focused GREEN and mutation checks**

Run Task 1 + Task 2 tests and Electron typecheck. Temporarily bypass signature verification and observe the tamper test fail, then restore. Temporarily relax normalized-path collision checking and observe its test fail, then restore.

**Step 4: Commit**

```bash
git add electron/server/content-packs electron/server/__tests__/content-pack-archive.test.ts electron/server/__tests__/fixtures/content-packs/test-publisher-public.pem
git commit -m "feat: verify immutable content pack archives"
```

## Task 3: Add first-party build and validation tooling

**Files:**

- Create: `scripts/content-packs/build-pack.mjs`
- Create: `scripts/content-packs/validate-pack.mjs`
- Create: `scripts/content-packs/lib.mjs`
- Create: `scripts/content-packs/README.md`
- Create: `scripts/content-packs/__tests__/publisher-tools.test.mjs`
- Modify: `package.json`

**Step 1: Write failing CLI tests**

Create a temporary source directory and ephemeral private key during the test. Assert:

- `build-pack` creates deterministic file ordering and a valid `.sspack`;
- `validate-pack` verifies it using an explicit public-key file and prints only non-secret pack identity/version/hash facts;
- missing key, wrong publisher namespace, undeclared file, unsupported asset, and invalid document exit nonzero;
- the private key is supplied only by an explicit path or environment variable and is never copied into the output or printed;
- rebuilding identical input produces the same manifest bytes and archive file order.

Run:

```bash
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
```

Expected: FAIL because the commands do not exist.

**Step 2: Implement minimal commands through shared contract code**

Add package scripts:

```json
"content-pack:build": "node scripts/content-packs/build-pack.mjs",
"content-pack:validate": "node scripts/content-packs/validate-pack.mjs"
```

The CLI must not duplicate schema or signature policy. It invokes the compiled/shared contract library through `tsx` or a thin TypeScript command if that is simpler in this repository. Do not add a dependency.

**Step 3: Document the publisher workflow**

Document source folder layout, manifest rules, key handling, build, validation, immutable versioning, and the explicit prohibition on committing private publisher keys.

**Step 4: Run focused GREEN**

Run publisher-tool tests, both content-pack backend suites, `npm run typecheck`, and `git diff --check`.

**Step 5: Commit**

```bash
git add scripts/content-packs package.json package-lock.json
git commit -m "feat: add content pack publisher tools"
```

## Task 4: Freeze current catalog behavior before runtime migration

**Files:**

- Create: `electron/server/__tests__/content-pack-migration-golden.test.ts`
- Create: `electron/server/__tests__/fixtures/content-packs/current-catalog-golden.json`

**Step 1: Write the golden behavior test**

Snapshot stable effective facts—not whole implementation objects—for representative current content:

- Hidden Mechanics of History Formula + its default Topic Packs;
- its recommended archival visual style and thumbnail recipe;
- one non-HMH Formula;
- one current user-override precedence case.

Capture prompt-relevant formula fields, topic axes/subjects, style prompt text/hash, thumbnail recipe/hash, and selected defaults. Exclude volatile filesystem paths and timestamps.

**Step 2: Prove the fixture detects drift**

Temporarily change one expected prompt-relevant field in the fixture, run the test and observe RED, then restore.

**Step 3: Run full foundation verification**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-pack-contract.test.ts \
  electron/server/__tests__/content-pack-archive.test.ts \
  electron/server/__tests__/content-pack-migration-golden.test.ts \
  electron/server/__tests__/format-loader.test.ts \
  electron/server/__tests__/thumbnail-recipe-catalog.test.ts \
  electron/server/__tests__/formula-production-kit.test.ts \
  electron/server/__tests__/niche-metadata-profile.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
npm run typecheck
git diff --check
```

**Step 4: Commit**

```bash
git add electron/server/__tests__/content-pack-migration-golden.test.ts electron/server/__tests__/fixtures/content-packs/current-catalog-golden.json
git commit -m "test: freeze content catalog migration behavior"
```

## Task 5: Independent review and next-plan handoff

**Files:**

- Create: `.superpowers/sdd/2026-08-13-story-content-pack-contracts/progress.md`
- Create: `docs/superpowers/plans/2026-08-13-story-content-pack-runtime.md`

**Step 1: Review the whole foundation range**

Review for schema strictness, ZIP confusion/path traversal, Unicode/case collisions, signature/key-ID correctness, private-key leakage, deterministic build output, dependency creep, and accidental changes to current catalog or generation behavior.

**Step 2: Fix every Critical or Important finding with RED→GREEN coverage**

Do not waive security findings for schedule.

**Step 3: Write the separate runtime plan**

The next plan covers staged install, atomic state, quarantine, keyring, retention/rollback, local discovery, immutable built-in recovery packs, and compatibility adapters. It must not include GenStudio checkout or customer store UI.

**Step 4: Final verification**

Run the full foundation command again and ensure the worktree is clean. Do not bump the app version or changelog until customer-visible runtime consumption ships.

