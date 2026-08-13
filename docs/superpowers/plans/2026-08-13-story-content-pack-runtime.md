# Story Content Pack Local Runtime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Install, verify, activate, recover, and consume signed local Story Studio Content Packs without GenStudio network access, while preserving current catalog behavior and making every project and generated job reproducible.

**Architecture:** The existing pure `.sspack` verifier remains the trust boundary. A new main-process runtime stages archive bytes under userData, verifies before materialising, atomically renames immutable versions, and changes the small locked state document only after the version is durable. A registry exposes only verified active/recovery packs; legacy loaders become adapters over it, retaining legacy files as an explicit compatibility source until the catalog migration removes them. Project pins resolve exact pack versions and are copied into every queued job as provenance.

**Tech Stack:** Electron main process, Node `fs/promises`, Node `crypto`, existing Zod contracts, Sharp, `node:test`, existing `writeJsonAtomic`/`withLock`, Electron Builder `extraResources`.

## Global Constraints

- Use `verifyContentPackArchive()` from `electron/server/content-packs/archive.ts`; do not reimplement ZIP, hash, signature, raster, schema, or path validation.
- Story’s renderer must never download, verify, unzip, or access pack filesystem paths. All pack operations run in the Electron backend.
- V1 accepts only strict JSON, PNG, JPEG, and WebP. Never add executable content, URLs, provider/model IDs, fonts, SVG, HTML, CSS, symlinks, or customer credentials.
- Keep purchased/store/GenStudio catalog networking, quotes, receipts, account identity, and checkout out of this plan. This runtime accepts local archive bytes and an optional expected SHA-256 only.
- Preserve the existing legacy Niche, Topic Pack, Thumbnail Recipe, and `BUILT_IN_STYLES` results until the project explicitly selects a signed pack. Existing project data must not be rewritten merely by booting.
- A project pin is exact `pack_id → version`; content updates and successor links never change a project, job, or prompt silently.
- An active damaged version rolls back locally to the most-recent verified retained version. A failed install never changes the current active version.
- Keep the latest active version plus its two previous verified versions per pack. Never prune a version pinned by a project.
- Runtime state is machine-local under `getUserDataDir()/content-packs`, locked with `withLock(statePath, ...)`, and written with `writeJsonAtomic(statePath, ..., { mode: 0o600 })`.
- Pack archive and asset serving must use manifest asset IDs, canonical IDs, and containment checks; never accept filesystem paths from a renderer request.
- Generate all production and test behavior with TDD: observe RED before production implementation, then focused GREEN before the commit.
- The shipped customer-visible runtime requires the normal version bump, lockfile update, newest-first `CHANGELOG.md` entry, `npm run check:changelog`, full verification, and packaged visual QA. Do not do those until this plan’s customer runtime is actually enabled.

---

## File map

| Path | Responsibility |
| --- | --- |
| `electron/server/content-packs/runtime-types.ts` | Zod-derived persisted runtime state, pack version records, provenance, and install/result interfaces. |
| `electron/server/content-packs/runtime-paths.ts` | Lazy userData/recovery roots and safe, contained path constructors. |
| `electron/server/content-packs/keyring.ts` | Pinned first-party public key policy and explicit test-policy constructor; no private key. |
| `electron/server/content-packs/state.ts` | Locked state read/mutation, state validation, and crash-safe activation records. |
| `electron/server/content-packs/installer.ts` | Staging, archive verification, safe materialisation, quarantine, dependency checks, activation, and retention. |
| `electron/server/content-packs/recovery.ts` | Bundled recovery archive discovery and local-only boot verification/rollback. |
| `electron/server/content-packs/registry.ts` | One read-only catalog of verified recovery, installed signed, and legacy compatibility records. |
| `electron/server/content-packs/legacy-adapters.ts` | Lossless mapping between verified content documents and current `Niche`, `TopicPack`, `ThumbnailTemplate`, and `BuiltInStyle` shapes. |
| `electron/server/content-packs/project-pins.ts` | Exact pin resolution, pin mutations, upgrade/rollback plans, and affected-project lookup. |
| `electron/server/routes/content-packs.ts` | Local import/lifecycle/read-only catalog APIs and bounded pack asset streaming. |
| `electron/server/services/{niche-loader,topic-pack-loader,thumbnail-template-loader}.ts` | Existing public loaders delegate to the registry before legacy fallback without changing callers. |
| `frontend/composables/useBuiltInStyles.ts` and style-library consumers | Read backend-published visual styles with the current built-in array as offline legacy fallback during migration. |
| `electron/server/boot/migrations.ts`, `electron/server/routes/index.ts`, `electron-builder.json` | Boot verification, route mounting, and immutable recovery/key resource packaging. |
| `electron/server/models/types.ts`, `electron/server/services/project-manager.ts`, `electron/server/services/job-queue.ts` | Exact content pins and immutable job provenance. |

## Task 1: Define runtime state, paths, and the pinned key policy

**Files:**

- Create: `electron/server/content-packs/runtime-types.ts`
- Create: `electron/server/content-packs/runtime-paths.ts`
- Create: `electron/server/content-packs/keyring.ts`
- Create: `electron/server/content-packs/state.ts`
- Create: `electron/server/__tests__/content-pack-state.test.ts`

**Consumes:** `ContentPackManifest` from `content-packs/types.ts`, `writeJsonAtomic`, `withLock`, `getUserDataDir()`.

**Produces:**

```ts
export interface ContentPackRuntimePaths {
  root: string
  statePath: string
  stagingRoot: string
  installedRoot: string
  quarantineRoot: string
  recoveryRoot: string
}
export function getContentPackRuntimePaths(): ContentPackRuntimePaths
export function installedVersionPath(paths: ContentPackRuntimePaths, manifest: ContentPackManifest): string
export function resolveVerifiedPackFile(versionRoot: string, relativePath: string): string

export interface ContentPackRuntimeState {
  schema_version: 1
  packs: Record<string, {
    active_version?: string
    discovery_disabled: boolean
    versions: Record<string, ContentPackInstalledVersion>
  }>
}
export interface ContentPackInstalledVersion {
  archive_sha256: string
  installed_at: string
  verified_at: string
  source: 'local-import' | 'recovery'
  install_path: string
  manifest: ContentPackManifest
}
export interface ContentPackVersionRef {
  pack_id: string
  version: string
  archive_sha256: string
}
export function emptyContentPackState(): ContentPackRuntimeState
export async function readContentPackState(paths?: ContentPackRuntimePaths): Promise<ContentPackRuntimeState>
export async function mutateContentPackState<T>(
  mutate: (state: ContentPackRuntimeState) => Promise<T> | T,
  paths?: ContentPackRuntimePaths,
): Promise<T>
```

- [ ] **Step 1: Write failing state/path tests**

Create isolated `STORY_STUDIO_DATA_DIR` tests using `useTempDataDir()`. Assert the layout is exactly `content-packs/{state.json,.staging,installed,quarantine}` under userData; no import creates directories until a write is requested. Assert a malformed `state.json` is quarantined as `state-invalid-<sha256>.json` and replaced by the empty strict state instead of silently trusting unknown fields. Assert 20 parallel `mutateContentPackState` calls retain every mutation. Assert `installedVersionPath()` cannot escape `installedRoot` for any valid manifest and `resolveVerifiedPackFile()` rejects `../`, slash-normalization, NUL, and symlink-style references.

```ts
await Promise.all(Array.from({ length: 20 }, (_, n) =>
  mutateContentPackState(state => { state.packs[`com.storystudio.test.${n}`] = { discovery_disabled: false, versions: {} }; }),
))
assert.equal(Object.keys((await readContentPackState()).packs).length, 20)
assert.throws(() => resolveVerifiedPackFile(root, '../state.json'), /contained/)
```

- [ ] **Step 2: Run the focused test and observe RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-state.test.ts
```

Expected: FAIL because runtime modules do not exist.

- [ ] **Step 3: Implement the smallest strict runtime primitives**

Use a `.strict()` Zod state schema with only `schema_version`, `packs`, `active_version`, `discovery_disabled`, and version records that store `archive_sha256`, `installed_at`, `verified_at`, `source`, `manifest`, and `install_path`. Construct all paths lazily from `pm.getUserDataDir()` so test data directories cannot freeze at module import. Canonicalise and re-check each joined path with `path.relative(root, candidate)`; valid manifest paths are already archive-verified but disk paths must still be contained.

`keyring.ts` exports a readonly `ContentPackVerificationPolicy` built solely from a packaged first-party public-key JSON resource. It must reject missing resources and unknown key IDs. Test callers use `createContentPackKeyring([{ keyId, publisherId, publicKeyPem }])`; production code must not accept renderer-supplied keys. Do not generate, commit, log, or package a private key.

- [ ] **Step 4: Run focused GREEN**

Run the Task 1 command, `npm run typecheck:electron`, and `git diff --check`.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/runtime-types.ts electron/server/content-packs/runtime-paths.ts electron/server/content-packs/keyring.ts electron/server/content-packs/state.ts electron/server/__tests__/content-pack-state.test.ts
git commit -m "feat: add content pack runtime state"
```

## Task 2: Stage, verify, materialise, and quarantine local imports

**Files:**

- Create: `electron/server/content-packs/installer.ts`
- Create: `electron/server/__tests__/content-pack-installer.test.ts`
- Modify: `electron/server/content-packs/runtime-types.ts`

**Consumes:** `verifyContentPackArchive()`, Task 1 paths/keyring/state.

**Produces:**

```ts
export interface ContentPackInstallRequest {
  archiveBytes: Uint8Array
  source: 'local-import' | 'recovery'
  expectedArchiveSha256?: string
}
export interface ContentPackInstallResult {
  pack_id: string
  version: string
  archive_sha256: string
  activated: boolean
  retained_versions: string[]
}
export interface ContentPackInstallerHooks {
  afterStageWrite?: () => Promise<void>
  beforeVersionRename?: () => Promise<void>
  beforeActivationWrite?: () => Promise<void>
}
export async function installContentPack(
  request: ContentPackInstallRequest,
  options?: { paths?: ContentPackRuntimePaths; policy?: ContentPackVerificationPolicy; hooks?: ContentPackInstallerHooks },
): Promise<ContentPackInstallResult>
export async function quarantineContentPackBytes(
  bytes: Uint8Array, reason: string, paths?: ContentPackRuntimePaths,
): Promise<string>
```

- [ ] **Step 1: Write failing installer tests**

Use the existing in-memory signed-archive test builder and ephemeral keypair from `content-pack-archive.test.ts`. Cover: successful import; SHA mismatch before activation; bad signature; app version below `min_app_version`; a missing exact dependency; duplicate `(pack_id, version)` with a different SHA; a valid identical re-import; invalid input copied into quarantine with a redacted reason sidecar; and all files materialised only after verification.

Add failure injection hooks named `afterStageWrite`, `beforeVersionRename`, and `beforeActivationWrite`. Make each hook throw in a separate test. Assert the old active version and state remain unchanged, staging is either cleaned or remains beneath its UUID transaction directory only, and a next clean install succeeds.

```ts
await assert.rejects(() => installContentPack(candidate, { hooks: { beforeActivationWrite: async () => { throw new Error('cut power') } } }))
assert.equal((await readContentPackState()).packs[packId]?.active_version, previousVersion)
assert.ok(await loadVerifiedVersion(previousVersion))
```

- [ ] **Step 2: Run focused RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-installer.test.ts
```

Expected: FAIL because `installContentPack` is missing.

- [ ] **Step 3: Implement a transaction that cannot damage an active version**

Write the archive to `.staging/<randomUUID>/archive.sspack` with bounded bytes, calculate SHA-256, compare the optional expected hash, and call the existing verifier before creating content or asset files. Materialise only `VerifiedContentPack.files` into `.staging/<id>/version/` with `open(..., 'wx')`, `lstat` checks, contained paths, and a final directory rename into `installed/<publisher>/<pack>/<version>`. Never unzip directly into its final destination.

Validate `min_app_version` through one exact-semver comparator and build a dependency graph from already installed verified versions plus the candidate. Reject self-dependencies, absent exact dependencies, and cycles before any state activation. Inside `mutateContentPackState`, make the immutable directory durable first, write the new version record, then set `active_version`; a write failure leaves any unreferenced version harmless and inactive. Quarantine only the submitted bytes plus a bounded machine-readable failure code—never request text, account data, or a stack trace.

- [ ] **Step 4: Run GREEN and exercise two safety mutations**

Run the installer suite plus contract/archive suites. Temporarily skip expected-SHA checking and observe the mismatch test fail; temporarily activate before the final rename and observe the power-cut test fail. Restore both safeguards immediately.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/installer.ts electron/server/content-packs/runtime-types.ts electron/server/__tests__/content-pack-installer.test.ts
git commit -m "feat: install verified content packs atomically"
```

## Task 3: Add lifecycle operations, retention, and local rollback

**Files:**

- Create: `electron/server/content-packs/lifecycle.ts`
- Create: `electron/server/__tests__/content-pack-lifecycle.test.ts`
- Modify: `electron/server/content-packs/installer.ts`

**Consumes:** installed version records from Tasks 1–2 and project reference query supplied by Task 6 as an injected callback.

**Produces:**

```ts
export async function setContentPackDiscoveryDisabled(packId: string, disabled: boolean): Promise<void>
export async function rollbackContentPack(packId: string, version: string): Promise<void>
export async function uninstallContentPackVersion(
  packId: string,
  version: string,
  isPinned: (packId: string, version: string) => Promise<string[]>,
): Promise<void>
export async function pruneUnpinnedContentPackVersions(
  packId: string,
  isPinned: (packId: string, version: string) => Promise<boolean>,
): Promise<string[]>
```

- [ ] **Step 1: Write failing lifecycle tests**

Install four versions of one signed pack and a separate dependent pack. Assert a disable removes a pack only from new discovery, not exact pin resolution. Assert rollback changes only active discovery and refuses a version with a broken dependency. Assert uninstall refuses an active version and every project-pinned version with the affected project slugs in its error. Assert pruning keeps active plus two prior verified versions and all pins, removes only unpinned inactive versions, and never removes a dependent version. Assert a corrupt active content file on disk causes boot verification to restore the newest healthy retained version, not a fresh network fetch.

- [ ] **Step 2: Run focused RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-lifecycle.test.ts
```

Expected: FAIL because lifecycle operations do not exist.

- [ ] **Step 3: Implement lifecycle operations under the state lock**

Store disable state independently from installed versions. `rollbackContentPack` must validate the selected on-disk manifest, hash, signature, dependencies, and app compatibility through the registry verifier before moving `active_version`. `uninstallContentPackVersion` first queries pins, then atomically marks a `pending_removal` record in state, removes only the contained immutable directory, and finally deletes the state record; a failed deletion retains the guard. Pruning uses a deterministic semver-descending order and validates each candidate again before removal.

- [ ] **Step 4: Run focused GREEN**

Run Task 2 and Task 3 suites, Electron typecheck, and diff check.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/lifecycle.ts electron/server/content-packs/installer.ts electron/server/__tests__/content-pack-lifecycle.test.ts
git commit -m "feat: manage content pack rollback and retention"
```

## Task 4: Bundle and verify the immutable recovery catalog at boot

**Files:**

- Create: `electron/server/content-packs/recovery.ts`
- Create: `electron/server/content-packs/recovery/trust-keys.json`
- Create: `electron/server/content-packs/recovery/README.md`
- Create: `electron/server/__tests__/content-pack-recovery.test.ts`
- Modify: `electron/server/boot/migrations.ts`
- Modify: `electron-builder.json`

**Consumes:** Tasks 1–3; published `.sspack` files produced only by the Task A publisher CLI with an owner-held private key.

**Produces:**

```ts
export async function verifyContentPackRuntimeAtBoot(): Promise<{
  recovery_verified: number
  installed_verified: number
  rolled_back: Array<{ pack_id: string; from: string; to: string }>
  quarantined: number
}>
export async function listVerifiedRecoveryPacks(): Promise<VerifiedContentPack[]>
```

- [ ] **Step 1: Write failing recovery tests**

Test dev and packaged resource resolution by injecting `recoveryRoot`. Assert a signed recovery fixture validates with the packaged public key; downloaded-cache deletion leaves it available; a corrupt recovery archive is ignored and reported without stopping the rest of boot; and an active installed pack whose hash no longer matches is rolled back to a retained verified version. Assert this method does not invoke `fetch`, GenStudio client, secrets store, or renderer code.

- [ ] **Step 2: Run focused RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-recovery.test.ts
```

Expected: FAIL because boot verification is absent.

- [ ] **Step 3: Implement recovery packaging and local-only boot work**

Keep `trust-keys.json` public-key-only and immutable in `extraResources` as `content-packs/recovery/trust-keys.json`; package recovery `.sspack` archives beside it. The README names the signed archive SHA-256, source pack ID/version, and the release command, but never a private-key path. Add `verifyContentPackRuntimeAtBoot()` as one best-effort task in `runBootMigrations()` before boot completion. It scans only recovery and installed roots, verifies archives/installed files locally, cleans stale staging directories older than 24 hours only when their names are UUID transaction IDs, and logs counts and IDs—not document prompt text or bytes.

- [ ] **Step 4: Run GREEN plus a packaging assertion**

Run the recovery suite, then `npm run build:electron` and inspect the Electron Builder configuration test or packed resource list to verify `content-packs/recovery/**` is included. Do not run a production pack build until the release owner supplies the signing key through the documented explicit path.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/recovery.ts electron/server/content-packs/recovery electron/server/__tests__/content-pack-recovery.test.ts electron/server/boot/migrations.ts electron-builder.json
git commit -m "feat: verify bundled content pack recovery catalog"
```

## Task 5: Publish one verified registry and adapt the existing loaders

**Files:**

- Create: `electron/server/content-packs/registry.ts`
- Create: `electron/server/content-packs/legacy-adapters.ts`
- Create: `electron/server/services/visual-style-loader.ts`
- Create: `electron/server/__tests__/content-pack-registry.test.ts`
- Create: `electron/server/__tests__/content-pack-legacy-adapters.test.ts`
- Modify: `electron/server/services/niche-loader.ts`
- Modify: `electron/server/services/topic-pack-loader.ts`
- Modify: `electron/server/services/thumbnail-template-loader.ts`
- Modify: `electron/server/routes/niches.ts`
- Modify: `electron/server/routes/thumbnail-templates.ts`
- Modify: `frontend/composables/useBuiltInStyles.ts`
- Modify: `frontend/components/{StylePicker,BuiltInStyleLibraryModal,ProjectStyleLibrary}.vue`
- Modify: `frontend/pages/projects/[slug]/{image-prompts,settings}.vue`

**Consumes:** verified installed/recovery data and current legacy object types.

**Produces:**

```ts
export type ContentCatalogSource = 'signed-installed' | 'signed-recovery' | 'legacy-builtin' | 'legacy-user-fork'
export interface CatalogEntry<T> { value: T; source: ContentCatalogSource; pack?: ContentPackVersionRef }
export interface VisualStyleCatalogEntry {
  id: string
  name: string
  builtin: true
  blurb: string
  category: 'Digital' | 'Explainer' | 'Illustration' | 'Realistic'
  tags: string[]
  data: { style_bible: string; negative_prompt: string }
  preview_image: string
}
export async function listCatalogEntries(kind: ContentPackItemKind, options?: { includeDisabled?: boolean }): Promise<CatalogEntry<ContentPackDocument>[]>
export async function resolveCatalogItem(id: string, pin?: ContentPackVersionRef): Promise<CatalogEntry<ContentPackDocument> | null>
export async function listVisualStyles(): Promise<VisualStyleCatalogEntry[]>
```

- [ ] **Step 1: Write failing registry and adapter tests**

Build two signed packs containing Formula, Topic, Visual Style, and Thumbnail Recipe documents with qualified IDs. Assert the registry orders explicit pinned signed content first, active signed content second, recovery content third, then legacy fallback; disabled signed content is omitted from new discovery but resolved by exact pin. Assert a `series-formula` maps only documented fields to `Niche`, a `topic-pack` maps to `TopicPack`, a recipe maps to `ThumbnailTemplate`, and a style maps to the existing frontend shape without inventing provider/model fields. Run the golden catalog test unchanged and assert all current legacy lookups still return byte-for-byte equivalent prompt-relevant output.

For visual styles, make a frontend test prove that API-published styles display alongside legacy `BUILT_IN_STYLES`, that the API outage fallback retains the 17 current styles, and that no component reads a direct pack file path.

- [ ] **Step 2: Run RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-registry.test.ts electron/server/__tests__/content-pack-legacy-adapters.test.ts electron/server/__tests__/content-pack-migration-golden.test.ts
npm --prefix frontend run test -- --test-name-pattern "style"
```

Expected: FAIL because the registry and adapters do not exist.

- [ ] **Step 3: Implement the registry and compatibility adapters**

Do not modify existing JSON files. `registry.ts` reads only locally verified manifests/files and returns immutable cloned values. It must not list disabled or retired packs for new selection, but exact pins can resolve both when locally installed. Each legacy loader first asks the registry for a qualified signed ID, then retains its present legacy lookup and cache path. Continue supporting bare legacy IDs solely for existing projects.

`legacy-adapters.ts` converts only fields already consumed by Story. Where signed documents use snake_case and legacy types use camelCase, write one explicit mapping table per kind. If an approved content field has no existing Story behavior, preserve it in registry metadata but do not manufacture runtime behavior. `visual-style-loader.ts` returns a server-published `BuiltInStyle`-compatible record with asset URLs from the Task 8 endpoint; frontend code uses a reactive `useVisualStyleCatalog()` layer so direct static imports become the offline legacy fallback rather than a competing source of truth.

- [ ] **Step 4: Run GREEN and visual QA**

Run the focused backend/frontend suites, `npm run typecheck`, and existing catalog tests. Launch `npm run dev`, inspect Style Picker and thumbnail selector at narrow and standard widths, verify every legacy visual-style preview still appears, and verify a signed test style can load its preview without exposing a disk path.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/registry.ts electron/server/content-packs/legacy-adapters.ts electron/server/services/visual-style-loader.ts electron/server/services/niche-loader.ts electron/server/services/topic-pack-loader.ts electron/server/services/thumbnail-template-loader.ts electron/server/routes/niches.ts electron/server/routes/thumbnail-templates.ts frontend/composables/useBuiltInStyles.ts frontend/components frontend/pages/projects/[slug] electron/server/__tests__/content-pack-registry.test.ts electron/server/__tests__/content-pack-legacy-adapters.test.ts frontend/__tests__
git commit -m "feat: consume verified content pack catalog"
```

## Task 6: Add exact project pins and immutable job provenance

**Files:**

- Modify: `electron/server/models/types.ts`
- Modify: `electron/server/contracts/index.ts`
- Create: `electron/server/content-packs/project-pins.ts`
- Create: `electron/server/__tests__/content-pack-project-pins.test.ts`
- Modify: `electron/server/services/project-manager.ts`
- Modify: `electron/server/services/job-queue.ts`
- Modify: `electron/server/routes/niches.ts`
- Modify: `electron/server/routes/thumbnail-templates.ts`

**Consumes:** Task 5 registry and project CRUD/job enqueue boundaries.

**Coordination rule:** Every project-pin mutation must acquire the shared
`withContentPackCoordinationLock()` exported by the lifecycle runtime before it
acquires the project-manager lock. Lifecycle deletion/pruning uses the same
coordination lock before reading pins. The global order is therefore content
pack coordination → content-pack state → project-manager; callers must never
acquire these in reverse. This closes the check-pin/delete race across files.

**Produces:**

```ts
export interface ContentPackProvenance extends ContentPackVersionRef { item_ids: string[] }
export interface ContentPackUpgradePlan {
  pack_id: string
  from: ContentPackVersionRef
  to: ContentPackVersionRef
  changed_item_ids: string[]
  affected_generation_types: JobType[]
}
export interface ProjectMeta { content_pack_versions?: Record<string, string> }
export interface Job { content_pack_provenance?: ContentPackProvenance[] }
export async function resolveProjectContentPins(project: ProjectMeta): Promise<ContentPackVersionRef[]>
export async function setProjectContentPin(slug: string, ref: ContentPackVersionRef): Promise<ProjectMeta>
export async function planProjectContentUpgrade(slug: string, packId: string, targetVersion: string): Promise<ContentPackUpgradePlan>
```

- [ ] **Step 1: Write failing pin/provenance tests**

Create a project selecting a signed Formula and Topic Pack. Assert selection pins exact pack version and archive hash in `project.json`; installing v1.1 does not alter an existing project effective Formula; explicit upgrade returns changed items and is the only operation that updates its pin; rollback restores its former pin. Assert an imported project with an unavailable pin reports the exact pack/version requirement and only affected generation is blocked. Assert `enqueue()` snapshots all current project content pins into `job.content_pack_provenance`; later upgrade/disable/uninstall cannot alter a queued job’s snapshot.

- [ ] **Step 2: Run RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-project-pins.test.ts electron/server/__tests__/job-queue.test.ts
```

Expected: FAIL because project pins and job provenance fields are absent.

- [ ] **Step 3: Implement immutable selection rules**

Add only additive optional fields to persisted project/job shapes. Pin mutation and pin lookup that races pack lifecycle must hold `withContentPackCoordinationLock()` before obtaining the Content Pack state lock and then project-manager’s lock: **coordination → state → project**. Do not call a public installer/lifecycle operation while already holding coordination; use their locked inner operation or arrange work at the documented order. Every registry resolution for a project receives its pin map; new projects choose the newest compatible active version only when a user selects content, never at boot. Add a `content-pack-missing` structured validation error that names each missing exact pack/version/item and blocks only generator operations that consume it. In `enqueue`, resolve pins once before constructing the Job and store `{ pack_id, version, archive_sha256, item_ids }`; never resolve a job again from current catalog state.

- [ ] **Step 4: Run GREEN and prove migration behavior**

Run Task 6 tests, current project/routes/job queue suites, and the full migration golden suite. Temporarily replace enqueue’s snapshot with a live resolver and observe the post-upgrade queued-job assertion fail; restore snapshot behavior.

- [ ] **Step 5: Commit**

```bash
git add electron/server/models/types.ts electron/server/contracts/index.ts electron/server/content-packs/project-pins.ts electron/server/services/project-manager.ts electron/server/services/job-queue.ts electron/server/routes/niches.ts electron/server/routes/thumbnail-templates.ts electron/server/__tests__/content-pack-project-pins.test.ts
git commit -m "feat: pin project content pack versions"
```

## Task 7: Preserve legacy user overrides as explicit forks

**Files:**

- Create: `electron/server/content-packs/user-forks.ts`
- Create: `electron/server/__tests__/content-pack-user-forks.test.ts`
- Modify: `electron/server/content-packs/registry.ts`
- Modify: `electron/server/routes/niches.ts`
- Modify: `electron/server/routes/thumbnail-templates.ts`
- Modify: `electron/server/services/{niche-loader,topic-pack-loader,thumbnail-template-loader}.ts`

**Consumes:** Task 5 adapters and Task 6 pin APIs.

**Produces:**

```ts
export async function forkLegacyContentForEdit(input: {
  kind: ContentPackItemKind
  legacyId: string
  projectSlug?: string
}): Promise<{ fork_id: `user:${string}`; source: ContentCatalogSource }>
export interface LegacyShadowConflict {
  kind: ContentPackItemKind
  legacy_id: string
  signed_item_id?: string
  referencing_project_slugs: string[]
}
export async function listLegacyShadowConflicts(): Promise<LegacyShadowConflict[]>
```

- [ ] **Step 1: Write failing user-fork tests**

Set up same-ID files in `.niches`, `.topic-packs`, and `.thumbnail-templates`. Assert the legacy project still resolves its current shadowed behavior unchanged before edit. On an edit request, assert Story writes a new explicit `user:<uuid>` record beneath the content-pack user-fork store, changes only the requesting project’s selection/pin, leaves the signed version untouched, and never rewrites or deletes the legacy source file. Assert two projects sharing a legacy shadow can fork independently; “restore signed content” only alters the requesting project after confirmation.

- [ ] **Step 2: Run RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-user-forks.test.ts
```

Expected: FAIL because explicit fork migration does not exist.

- [ ] **Step 3: Implement non-destructive fork-on-edit**

Keep legacy shadow lookup read-only and visible as `legacy-user-fork`. Generate `user:<randomUUID()>` only when an explicit edit/fork action occurs, serialise the mapped document under `content-packs/user-forks/<uuid>.json` with the original source metadata, and update the one project through Task 6’s atomic API. Do not auto-convert files on startup, do not let an unqualified user ID shadow a signed ID, and do not expose raw filesystem locations in responses.

- [ ] **Step 4: Run GREEN**

Run user-fork, registry, loader, niche-route, and thumbnail-route tests; then run the golden user-shadow regression unchanged.

- [ ] **Step 5: Commit**

```bash
git add electron/server/content-packs/user-forks.ts electron/server/content-packs/registry.ts electron/server/routes/niches.ts electron/server/routes/thumbnail-templates.ts electron/server/services/niche-loader.ts electron/server/services/topic-pack-loader.ts electron/server/services/thumbnail-template-loader.ts electron/server/__tests__/content-pack-user-forks.test.ts
git commit -m "feat: preserve legacy content as explicit user forks"
```

## Task 8: Add backend-only local management and asset endpoints

**Files:**

- Create: `electron/server/routes/content-packs.ts`
- Create: `electron/server/__tests__/content-pack-routes.test.ts`
- Modify: `electron/server/routes/index.ts`
- Modify: `electron/server/routes/niches.ts`
- Modify: `electron/server/routes/thumbnail-templates.ts`

**Consumes:** Tasks 2–7.

**Produces routes:**

```text
GET    /api/content-packs                         # verified local/recovery catalog; no store prices
POST   /api/content-packs/import                  # authenticated local `.sspack` bytes, max 50 MiB
POST   /api/content-packs/:packId/disable
POST   /api/content-packs/:packId/enable
POST   /api/content-packs/:packId/rollback         # exact installed version only
DELETE /api/content-packs/:packId/versions/:version
GET    /api/content-packs/:packId/:version/assets/:assetId
GET    /api/content-packs/projects/:slug/requirements
```

- [ ] **Step 1: Write failing route tests**

Mount only `content-packs` router in an isolated Express app. Assert import accepts a valid binary archive and rejects oversized, malformed, unsigned, or JSON-body archive input. Assert all IDs/versions are schema validated before filesystem access. Assert disabled packs remain in management responses but vanish from discovery. Assert asset reads require a verified pack/version and a manifest-declared asset ID, stream the MIME declared by the manifest, set `X-Content-Type-Options: nosniff` and immutable cache headers, and reject path-looking IDs, inactive/uninstalled versions, and symlink replacement attempts. Assert no route calls GenStudio, reads API keys, or performs a purchase.

- [ ] **Step 2: Run RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-routes.test.ts
```

Expected: FAIL because the router is absent.

- [ ] **Step 3: Implement bounded backend routes**

Use Express raw-body handling only for the import endpoint with a 50 MiB limit and do not persist a body until `installContentPack` begins its transaction. The route's `assetId` is the exact declared asset file SHA-256, never the filename or a caller-supplied path. Reuse the matching manifest path from registry metadata; call `lstat` before and after opening and stream from a file descriptor so a replacement cannot leave the verified root. Return pack metadata, lifecycle state, exact pins, and affected projects, but not unbounded document prompts, filesystem paths, public-key PEM, archive bytes, entitlement/account data, or stack traces.

- [ ] **Step 4: Run GREEN and manual API smoke**

Run focused route plus runtime suites and Electron typecheck. Launch the dev app, import a signed test archive through the local management endpoint, request its preview asset, disable it, verify a new selection cannot see it, and verify an existing exact project pin still resolves it.

- [ ] **Step 5: Commit**

```bash
git add electron/server/routes/content-packs.ts electron/server/routes/index.ts electron/server/routes/niches.ts electron/server/routes/thumbnail-templates.ts electron/server/__tests__/content-pack-routes.test.ts
git commit -m "feat: expose local content pack lifecycle"
```

## Task 9: Release-grade integration review and verification

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `.superpowers/sdd/2026-08-13-story-content-pack-runtime/progress.md`

- [x] **Step 1: Review all runtime changes against the approved design**

Check every archive/control boundary for: ZIP/path verification reuse, no network or GenStudio imports, missing/unknown keys, case/Unicode collision retention, app-version/dependency/cycle rejection, recovery with cache deleted, state interruption, `pending_removal`, disabled discovery, project pin immutability, job snapshot immutability, legacy user-fork behavior, and asset containment. Categorise findings Critical/Important/Minor; do not waive Critical or Important issues.

- [x] **Step 2: Fix every accepted finding via a new RED→GREEN regression**

For each finding, add the smallest focused test in the responsible `content-pack-*.test.ts` file, run it red, fix only the responsible module, and record test evidence in the SDD ledger.

- [x] **Step 3: Run complete verification**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-pack-*.test.ts electron/server/__tests__/format-loader.test.ts electron/server/__tests__/thumbnail-recipe-catalog.test.ts electron/server/__tests__/formula-production-kit.test.ts electron/server/__tests__/niche-metadata-profile.test.ts
node --test scripts/content-packs/__tests__/publisher-tools.test.mjs
npm run lint
npm run typecheck
npm test
npm run check:changelog
npm run build
git diff --check
```

Expected: all commands pass. If the production dependency audit reports any issue, report its exact command/result separately; do not describe it as clean without an actual clean result.

- [x] **Step 4: Update release metadata and visually inspect the enabled runtime**

Increase the package and lockfile version together, add the newest-first matching changelog entry describing local signed pack import/recovery/pinning only, and re-run `npm run check:changelog`. Build the packaged app, launch it with a fresh `STORY_STUDIO_DATA_DIR`, and inspect narrow and standard screens for the adapted Formula, Topic, Thumbnail, and Style pickers. Confirm disabled copy, missing-pack requirements, rollback, and offline recovery are clear and keyboard reachable.

- [x] **Step 5: Commit**

```bash
git add package.json package-lock.json CHANGELOG.md .superpowers/sdd/2026-08-13-story-content-pack-runtime/progress.md
git commit -m "chore: release local content pack runtime"
```

## Plan self-review

- **Spec coverage:** Tasks 1–4 cover staged installation, pinned keyring, state lock/atomic activation, quarantine, retention/rollback, boot verification, recovery catalog, package resources, and failure injection. Task 5 covers registry discovery and all four existing content families. Tasks 6–7 cover exact pins, job/artifact provenance, disabled/retired behavior, legacy shadow compatibility, and non-destructive explicit user forks. Task 8 covers contained asset serving and local lifecycle management. Checkout, signed entitlements, account identity, and customer store UI remain expressly excluded for the later GenStudio/Store integration plans.
- **No behavior drift:** Task 5 runs the existing content catalog golden suite before and after adapters; Task 6 snapshots content before queueing; no startup migration rewrites legacy content.
- **Placeholder scan:** searched this document for `TODO`, `TBD`, `implement later`, and `similar to`; none are present.
- **Type consistency:** `ContentPackVersionRef`, `ContentPackRuntimePaths`, `ContentPackRuntimeState`, registry entries, exact project pins, and `Job.content_pack_provenance` are defined before later tasks consume them.

## Execution handoff

Execute this runtime plan with `superpowers:subagent-driven-development`: a fresh implementer per task, a requirements review and code-quality review after every task, and the SDD ledger kept current. Do not begin the GenStudio purchase/entitlement/store integration until the local runtime’s release gate is green.
