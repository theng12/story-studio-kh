# Content Store Catalog Experience Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete Story Studio's catalog-published Shelf → Proof/detail → Owned → Install/Installed experience without weakening the existing signed commerce, delivery, or project-pin boundaries.

**Architecture:** Keep GenStudio's wire contract isolated in `genstudio-content-store.ts`, translate only verified live fields into bounded Story DTOs, and keep presentation fixtures separate until GenStudio publishes the remaining merchandising contract. Split the renderer into shelf, detail, and library components while reusing the existing one-attempt quote/purchase journal and signed delivery service unchanged.

**Tech Stack:** Electron main-process TypeScript, Express 5, Zod 3, Nuxt 4, Vue 3, Node `node:test`, Happy DOM, existing GenStudio Content Store client/trust/delivery services.

## Global Constraints

- Execute after `codex/genstudio-111-adoption` commit `35eb3942c0090925065d7268acb979105f77c086`; it contains the reviewed GenStudio 1.7 and 1.9–1.11 adoption.
- GenStudio remains authoritative for product identity, price, ownership, exact quotes, grants, shelf placement/order, cover media, product detail facts, license copy, and release state.
- Story must not invent a GenStudio wire field. Renderer-only fixtures are allowed; production DTO wiring stops until approved-design section 21 has a field-exact live handoff and a deployed response fixture.
- Preserve one network attempt per explicit quote/purchase action, the saved quote's exact idempotency key, canonical signed bytes, exact refusal codes, and the distinction between Owned and Installed.
- A kit is Installed only when its complete exact dependency closure verifies. Never substitute a current release for a pinned exact version.
- Content Store remains globally reachable without a project; empty catalog, offline cache, and project selection are different states.
- No hardcoded catalog order, product IDs, prices, licenses, cover URLs, or YouTube links in production Story code.
- No production purchase, publication, deployment, generation, fleet work, or customer mutation is authorized by this plan.

## Dependencies and execution order

1. Task 1 creates renderer-only normalized fixtures.
2. Task 2 waits for the field-exact live GenStudio merchandising contract.
3. Tasks 3 and 4 may follow Task 2 in parallel; Task 5 joins them.
4. Task 6 is the independent compliance, security, code-quality, and rendered-UX gate.

---

### Task 1: Define a renderer-only catalog presentation boundary

**Files:**
- Create: `frontend/content-store/catalog-presentation.ts`
- Create: `frontend/__tests__/contentStorePresentation.test.ts`

**Interfaces:**
- Consumes: `ContentStoreProduct` from `frontend/composables/useContentStore.ts`.
- Produces:

```ts
export type ContentStoreKindFilter = 'all' | ContentStoreProductKind
export interface CatalogShelfPresentation { id: string; title: string; productIds: readonly string[] }
export interface CatalogProductPresentation {
  productId: string
  cover: { src: string; alt: string } | null
  licenseLabel: string | null
  tags: readonly string[]
}
export interface CatalogPresentationFixture {
  shelves: readonly CatalogShelfPresentation[]
  products: Readonly<Record<string, CatalogProductPresentation>>
}
export function orderShelfProducts(
  products: readonly ContentStoreProduct[], shelf: CatalogShelfPresentation,
): ContentStoreProduct[]
export function filterCatalogProducts(
  products: readonly ContentStoreProduct[], query: string,
  options: { price: 'all' | 'free' | 'paid'; kind: ContentStoreKindFilter; compatibleOnly: boolean },
): ContentStoreProduct[]
```

- [ ] **Step 1: Write the failing normalized-presentation tests**

```ts
test('uses explicit server order and never appends unplaced products', () => {
  const ordered = orderShelfProducts(products, {
    id: 'starter', title: 'Free Starter Kits', productIds: ['kit-b', 'kit-a'],
  })
  assert.deepEqual(ordered.map(product => product.productId), ['kit-b', 'kit-a'])
})

test('searches only published customer text and tags', () => {
  const result = filterCatalogProducts(products, 'documentary', {
    price: 'all', kind: 'all', compatibleOnly: false,
  })
  assert.deepEqual(result.map(product => product.productId), ['kit-a'])
})
```

Also reject duplicate shelf/product IDs, unknown product references, non-HTTPS covers, blank cover alt text, and more than 100 shelves. Filtering must not search opaque IDs.

- [ ] **Step 2: Run the focused test and verify RED**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/contentStorePresentation.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `catalog-presentation.js`.

- [ ] **Step 3: Implement the normalized fixture boundary**

Use strict local validation for test fixtures and Story-normalized DTOs only. Permit cover `src` only when `new URL(src).protocol === 'https:'`; do not call this a GenStudio wire parser. Preserve `productIds` order with a lookup map and reject omissions rather than inventing an “Other” shelf.

- [ ] **Step 4: Run GREEN and commit**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/contentStorePresentation.test.ts
cd ..
git diff --check
git add frontend/content-store/catalog-presentation.ts frontend/__tests__/contentStorePresentation.test.ts
git commit -m "test: define Content Store presentation boundary"
```

- [ ] **Step 5: Obtain independent requirements review**

Compare the normalized interface with approved-design sections 13–17 and 21. Reject any production parser field, default shelf, inferred tag/license, or guessed media URL. Apply Critical/Important corrections through RED/GREEN before Task 2.

### Task 2: Adopt the live GenStudio merchandising contract exactly

**Files:**
- Modify: `electron/server/lib/genstudio-content-store.ts`
- Modify: `electron/server/services/content-store.ts`
- Modify: `electron/server/__tests__/genstudio-content-store-client.test.ts`
- Modify: `electron/server/__tests__/content-store-routes.test.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`
- Create: `electron/server/__tests__/fixtures/content-store-merchandising-contract.json`
- Modify: `frontend/composables/useContentStore.ts`
- Modify: `frontend/__tests__/contentStore.test.ts`

**Interfaces:**
- Consumes: the field-exact deployed GenStudio fixture satisfying approved-design section 21 items 1–8.
- Produces normalized Story DTOs (these are not wire names):

```ts
interface PublicContentStoreShelf { id: string; title: string; productIds: string[] }
interface PublicContentProductPresentation {
  cover: { src: string; alt: string } | null
  licenseLabel: string | null
  tags: string[]
}
interface ContentStoreOverview {
  phase: 'delivery_ready'
  account: PublicContentAccount
  products: Array<PublicContentProduct & { presentation: PublicContentProductPresentation }>
  shelves: PublicContentStoreShelf[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: { purchase: true; receipt_verification: true; download: true; install_after_purchase: true; restore: true }
}
```

- [ ] **Step 1: Enforce the external contract gate**

```bash
test -s <owner-home>/Developer/_handoffs/2026-08-14_to-gpt-storystudio_from-claude-genstudio_content-catalog-merchandising-live.md
```

Expected before GenStudio delivery: fail and stop without production parser edits. After delivery, create the bounded redacted deployed-response fixture from the handoff evidence; the handoff must name exact response locations, limits, nullability, and media policy.

- [ ] **Step 2: Write parser tests from that deployed fixture**

```ts
test('preserves published shelves, media, tags, and license facts', async () => {
  const wire = JSON.parse(await readFile(MERCHANDISING_FIXTURE, 'utf8'))
  const catalog = parseContentStoreCatalog(wire.response)
  assert.deepEqual(catalog.shelves.map(shelf => shelf.productIds), wire.expected_story_order)
  assert.equal(catalog.products[0]?.presentation.cover?.src, wire.expected_cover_url)
  assert.equal(catalog.products[0]?.presentation.licenseLabel, wire.expected_license_label)
})
```

Add malformed cases at the exact live bounds. Reject unknown placement products, duplicate placement, unsafe media, oversized copy/tags, and absent required detail facts. Preserve the reviewed optional `showcase_videos` parser.

- [ ] **Step 3: Run the backend tests and verify RED**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-store-routes.test.ts
```

Expected: FAIL because the catalog/public overview do not expose verified merchandising facts.

- [ ] **Step 4: Extend the exact wire parser and public DTO**

Add only names and validators proven by the handoff/fixture. Preserve `raw: CanonicalJsonObject`, cap collections/strings at live bounds, and map to normalized renderer names in `publicProduct()` and `loadContentStoreOverview()`. Do not expose pack-internal preview paths before entitlement.

- [ ] **Step 5: Run GREEN and commit**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/contentStore.test.ts
cd ..
npm run typecheck
git diff --check
git add electron/server/lib/genstudio-content-store.ts electron/server/services/content-store.ts \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/fixtures/mock-genstudio-service.ts \
  electron/server/__tests__/fixtures/content-store-merchandising-contract.json \
  frontend/composables/useContentStore.ts frontend/__tests__/contentStore.test.ts
git commit -m "feat: read GenStudio catalog merchandising"
```

- [ ] **Step 6: Obtain independent contract/security review**

Compare every accepted wire name with the deployed GenStudio schema. Reject guessed aliases, permissive URLs, signed-field projection, price derivation, and any change to quote/purchase retry or idempotency behavior.

### Task 3: Build catalog shelves, filters, covers, and proof/detail routing

**Files:**
- Create: `frontend/components/content-store/ContentStoreShelf.vue`
- Create: `frontend/components/content-store/ContentStoreFilters.vue`
- Create: `frontend/components/content-store/ContentProductCover.vue`
- Create: `frontend/components/content-store/ContentProductDetail.vue`
- Create: `frontend/pages/content-store/[productId].vue`
- Modify: `frontend/components/content-store/ContentProductCard.vue`
- Modify: `frontend/pages/content-store.vue`
- Modify: `frontend/content-store/catalog-presentation.ts`
- Modify: `frontend/__tests__/contentStore.test.ts`
- Create: `frontend/__tests__/contentStoreDetail.test.ts`

**Interfaces:**
- Consumes: Task 2's `overview.shelves`, `product.presentation`, existing `showcaseVideos`, `bundleComponents`, `currentRelease`, ownership, quote, and install actions.
- Produces: global `/content-store/:productId` proof route and promise-first shelf/card/detail components.

- [ ] **Step 1: Write renderer-contract tests**

```ts
test('renders shelves in server order and routes cards to proof', () => {
  assert.match(page, /v-for="shelf in visibleShelves"/)
  assert.match(card, /content-store.*productId/)
  assert.doesNotMatch(card, /included components<\/strong>/i)
})

test('detail renders proof and opens showcase links externally', () => {
  assert.match(detail, /Watch example videos/)
  assert.match(detail, /openExternalShowcase/)
  assert.doesNotMatch(detail, /iframe|autoplay|v-html/)
})
```

Cover title/summary/price/status, cover alt behavior, release compatibility, included component versions, publisher/changelog/license, counts derived from signed `componentSummary`, quote actions, and an unknown-product state that remains inside Content Store.

- [ ] **Step 2: Run focused frontend tests and verify RED**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/contentStoreDetail.test.ts
```

Expected: FAIL because the shelf/detail components and route do not exist.

- [ ] **Step 3: Implement promise-first cards and shelves**

Cards show cover, title, measurable promise line, transformation line, live Free/credit price, and text status. Component counts move to detail. Build filters from live fields/tags; never hardcode launch shelf titles/order.

- [ ] **Step 4: Implement detail and safe showcase links**

Resolve `productId` from current products. Use the existing safe external-link boundary for YouTube, add “Opens YouTube in your default browser,” and never embed remote content. Primary states are `Get free`, `See exact quote`, `Owned`, `Install`, `Installed`, or `Update`.

- [ ] **Step 5: Run GREEN and commit**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/contentStoreDetail.test.ts
npx nuxt typecheck
cd ..
git diff --check
git add frontend/components/content-store frontend/pages/content-store.vue \
  'frontend/pages/content-store/[productId].vue' frontend/content-store/catalog-presentation.ts \
  frontend/__tests__/contentStore.test.ts frontend/__tests__/contentStoreDetail.test.ts
git commit -m "feat: add Content Store shelves and proof"
```

- [ ] **Step 6: Obtain independent UX/accessibility review**

Review screenshots at 1440, 768, 420, and 320 CSS pixels plus keyboard-only navigation. Reject clipped cards, unreachable controls, ambiguous external links, technical-count-first cards, inferred data, and project-selection redirects.

### Task 4: Separate Owned, Installed, and Updates libraries

**Files:**
- Modify: `electron/server/services/content-store-install-state.ts`
- Modify: `electron/server/services/content-store.ts`
- Modify: `electron/server/__tests__/content-store-routes.test.ts`
- Modify: `frontend/composables/useContentStore.ts`
- Create: `frontend/components/content-store/ContentLibraryView.vue`
- Modify: `frontend/pages/content-store.vue`
- Modify: `frontend/__tests__/contentStore.test.ts`

**Interfaces:**
- Consumes: verified ownership, installed exact versions, current safe release, recalled versions, and public product data.
- Produces:

```ts
export type ContentStoreInstallState =
  | 'not_installed' | 'installing_dependencies' | 'installed_current'
  | 'installed_other_version' | 'update_available' | 'incomplete' | 'unavailable'
export interface ContentStoreClosureState {
  installState: ContentStoreInstallState
  installedVersion: string | null
  missingDependencies: Array<{ packId: string; version: string; reason: string }>
}
```

- [ ] **Step 1: Write closure and library tests**

```ts
test('never calls a partial kit Installed', async () => {
  const state = await resolveContentStoreInstallStates([kitRelease])
  assert.equal(state[0]?.installState, 'incomplete')
  assert.deepEqual(state[0]?.missingDependencies, [
    { packId: 'com.storystudio.pack.topic.missing', version: '1.0.0', reason: 'not installed' },
  ])
})
```

Cover owned-not-installed, installed current, pinned older version, update available, recalled installed version, incompatible release, and shared dependency present once. Renderer tests prove separate Owned/Installed/Updates tabs with correct counts and empty states.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/contentStore.test.ts
```

Expected: FAIL because current install state lacks incomplete-closure evidence and UI has only Discover/Owned.

- [ ] **Step 3: Implement truthful closure state and library derivation**

Reuse `verifyInstalledContentPackClosure()` and runtime state. Bound missing dependency output to 100 exact dependencies and public reasons; never expose paths. Derive library views without extra purchase/download calls.

- [ ] **Step 4: Run GREEN and commit**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts
cd frontend
npx tsx --import ./__tests__/setup.ts --test __tests__/contentStore.test.ts
cd ..
npm run typecheck
git diff --check
git add electron/server/services/content-store-install-state.ts electron/server/services/content-store.ts \
  electron/server/__tests__/content-store-routes.test.ts frontend/composables/useContentStore.ts \
  frontend/components/content-store/ContentLibraryView.vue frontend/pages/content-store.vue \
  frontend/__tests__/contentStore.test.ts
git commit -m "feat: separate Content Store libraries"
```

- [ ] **Step 5: Obtain independent lifecycle review**

Reject current-version substitution, partial Installed state, automatic install/update, hidden recall evidence, or ownership inferred from local bytes.

### Task 5: Add offline, empty, failure, and accessible interaction states

**Files:**
- Modify: `frontend/composables/useContentStore.ts`
- Modify: `frontend/pages/content-store.vue`
- Modify: `frontend/pages/content-store/[productId].vue`
- Modify: `frontend/components/content-store/ContentPurchaseDialog.vue`
- Modify: `frontend/components/content-store/ContentStoreFilters.vue`
- Modify: `frontend/__tests__/contentStore.test.ts`
- Modify: `frontend/__tests__/contentStoreDetail.test.ts`

**Interfaces:**
- Consumes: cached verified ownership/install state and exact `ContentStoreUiError` codes.
- Produces: explicit `fresh | cached | unavailable` catalog freshness and accessible tab/filter/dialog/status behavior.

- [ ] **Step 1: Write failure-matrix and accessibility tests**

Add table cases for missing scope, incompatible version, insufficient credits, expired/rejected quote, uncertain purchase, signing unavailable, ownership mismatch, grant expiry, archive limit, signature/hash/schema/asset/dependency failure, withdrawn, recalled 410, disk/staging/activation failure, empty authenticated catalog, and offline cache. Assert semantic tabs, roving arrows/Home/End, focus restoration, changed-state live regions, text status, and no `v-html`.

- [ ] **Step 2: Run focused tests and verify RED**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/contentStoreDetail.test.ts
```

Expected: FAIL on cached freshness and the expanded distinct-state matrix.

- [ ] **Step 3: Implement bounded cached/offline presentation**

Retain the last successfully loaded overview in renderer memory and use backend verified ownership/install facts; do not add a second catalog database. On refresh failure, show last-verified time, disable network actions, and keep installed content visible.

- [ ] **Step 4: Complete keyboard, focus, narrow-layout, and reduced-motion behavior**

Use roving focus, labeled filters, focus restoration, wrapping for components/numbers, and `prefers-reduced-motion`. The global route must never require a project slug.

- [ ] **Step 5: Run GREEN and commit**

```bash
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/contentStoreDetail.test.ts
npx nuxt typecheck
cd ..
git diff --check
git add frontend/composables/useContentStore.ts frontend/pages/content-store.vue \
  'frontend/pages/content-store/[productId].vue' frontend/components/content-store \
  frontend/__tests__/contentStore.test.ts frontend/__tests__/contentStoreDetail.test.ts
git commit -m "fix: harden Content Store experience states"
```

- [ ] **Step 6: Obtain independent rendered review**

Use the dev renderer with stubbed local responses; screenshot 1440/768/420/320 CSS pixels and keyboard-walk Shelf → detail → quote/claim → Owned → Install. Record overflow, cover cropping, focus visibility, dialog geometry, and long-copy results.

### Task 6: Run independent spec/compliance and code-quality gates

**Files:**
- Review: all files changed by Tasks 1–5
- Review: `docs/superpowers/specs/2026-08-14-content-store-launch-catalog-design.md`
- Review: `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`

**Interfaces:**
- Consumes: complete catalog-experience diff.
- Produces: GO/NO-GO report with Critical/Important findings resolved before content stocking relies on this work.

- [ ] **Step 1: Run complete focused and neighboring suites**

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/genstudio-content-store-delivery.test.ts \
  electron/server/__tests__/content-store-commerce-state.test.ts \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/content-pack-project-pins.test.ts
cd frontend
npx tsx --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/contentStorePresentation.test.ts \
  __tests__/contentStoreDetail.test.ts
cd ..
npm run lint -- --quiet
npm run typecheck
git diff --check
```

Expected: every command exits 0.

- [ ] **Step 2: Run independent specification/compliance review**

Map every acceptance criterion in design sections 13–18 and 23.2–23.6 to a test or rendered check. Any missing criterion is NO-GO.

- [ ] **Step 3: Run independent code-quality/security review**

Inspect parsing bounds, external-link isolation, one-attempt commerce, idempotency, signed evidence, route exposure, offline truth, dependency closure, and project-pin non-mutation. Critical/Important findings require RED/GREEN correction commits.

- [ ] **Step 4: Record the accepted boundary**

```bash
git status --short
git log --oneline --reverse --no-merges "$(git merge-base origin/main HEAD)"..HEAD
```

Expected: reviewed catalog-experience commits, clean worktree, no version/changelog change, pack artifact/key, or external mutation. Merge/push/package/install/restart/publish/stocking belong to the release plan.

## Self-review

- Spec coverage: contract gate, DTOs, shelves/order, cover/proof/detail, showcase links, Owned/Installed/Updates, exact closure, offline/empty/error, accessibility, and finance/idempotency are assigned.
- Placeholder scan: no production field is guessed; Task 2 deliberately stops at the external contract gate.
- Type consistency: normalized presentation and closure states are defined once and consumed without renaming.
