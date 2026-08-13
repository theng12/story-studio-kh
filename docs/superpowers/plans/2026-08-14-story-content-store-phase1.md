# Story Content Store Phase 1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add Story Studio's safe Phase 1 Content Store experience for GenStudio 1.4.0 / charging contract 0.21.0: account/catalog discovery, exact quotes, explicit idempotent purchases, permanent-ownership display, and an unverified local receipt cache, without downloading or installing paid content.

**Architecture:** A small strict GenStudio Content Store client owns the exact remote wire contract and canonical JSON preservation. A separate locked machine-local commerce store persists the signed quote, one stable idempotency key, purchase state, and receipt bytes before the UI can proceed. An orchestration service joins the active GenStudio credential with those two boundaries; renderer routes expose bounded product actions and never import or invoke the Content Pack installer. The Nuxt page renders remote ownership and local commerce state truthfully, with explicit Phase 1 boundaries.

**Tech Stack:** Electron main-process TypeScript, Express 5, Node `crypto`/`fs/promises`, Zod 3, existing `withLock`/`writeJsonAtomic`, Nuxt 4, Vue 3, `node:test`, Happy DOM, existing unsigned DMG release workflow.

## Global Constraints

- The remote source of truth is GenStudio KH release **1.4.0**, charging contract **0.21.0**, documented in `/build/Developer/genstudiokh/docs/product/api-contract-changes-1.4.0.md` and the four `2026-08-13_*content-store*.md` handoffs in `/build/Developer/_handoffs/`.
- Use exactly `content:read` for `GET /v1/content/account`, `GET /v1/content/products`, and `POST /v1/content/quotes`; use exactly `content:purchase` for `POST /v1/content/purchases`. Existing keys are immutable and do not gain these scopes.
- A key probe may prove `content:read` by reading `/v1/content/account`. Phase 1 exposes no non-debit endpoint that proves `content:purchase`, so Story must label that scope **required but not non-destructively verified** until an actual purchase is attempted.
- Use `content_spendable_credits`, never `available_credits`, for purchase affordability. The former excludes foundation-only credits; referral-reward credits remain spendable because GenStudio classifies them as general credits.
- A purchase is not a generation job: no Story Job Queue record, provider admission, reservation, reconciliation, cancellation, settlement, or automatic retry is allowed.
- A quote POST is read-only, but all Content Store POSTs still make **one network attempt per explicit user action**. Do not pass them through generic POST retry/admission helpers.
- Preserve the complete `quote` object without projecting or stripping fields. Persist its canonical JSON form using sorted keys, no insignificant whitespace, and UTF-8; reconstruct the purchase body only from those persisted canonical bytes. Never mutate, merge, or decorate the signed object.
- Generate and durably save one 8–128 character idempotency key before the first purchase POST. Reuse that exact key for every explicit retry of that exact quote, including after 402/404/409/503 refusals or an uncertain transport outcome. A new quote is a new request and receives a new key.
- Preserve exact GenStudio refusal semantics: `402 insufficient_credits` with `required_credits`, `available_credits`, and `shortfall_credits`; `404 product_unavailable|release_unavailable`; `409 already_owned|quote_rejected`; `503 signing_unavailable`. A 401 means the active key was not accepted for the required scope; do not claim whether it was invalid, expired, revoked, or merely under-scoped.
- `quoted_credits` is a ceiling. The completed response's `credits_charged` and `balance_after` are final. Never display the quote as a guaranteed final debit.
- Ownership is rooted in stable `account_id` / `content_account_id`, not the API key. Same-account key rotation may continue an attempt; a different account must not submit a saved quote.
- `GET /v1/content/products` returning `{ "products": [] }` is a valid deliberately empty catalog, not an outage or parsing error.
- Cache the receipt payload, signature, and key ID exactly, but label it **unverified**. Phase 1 has no public key, authorised download grant, restore endpoint, or offline receipt verification.
- Do not invent or display fields GenStudio does not publish in 0.21: no download URL, receipt public key, Buy Credits URL, preview gallery, artwork, license terms, download grant, restore status, or customer portal link.
- Do not download, import, verify, activate, pin, disable, roll back, or uninstall a Content Pack from the commerce routes. Phase 2 connects owned releases to the completed local runtime.
- Successful purchase copy must distinguish **Owned in GenStudio** from **Installed on this Mac**. Phase 1 purchase success does not imply installation.
- Store no API key, key fingerprint, credential hash, full server response log, or secret-derived account marker in commerce state. Store only the stable account ID and bounded commercial evidence.
- Apply TDD to every task: observe focused RED, implement the smallest root-cause behavior, run focused GREEN, commit, then obtain an independent requirements/security review. Every accepted review correction needs its own RED-to-GREEN regression.
- Customer-visible completion requires Story Studio **v1.0.835** in both package manifests and a newest-first matching `CHANGELOG.md` entry. Do not bump the version or changelog before Task 5.
- No push, publish, deploy, production purchase, customer credit mutation, or live catalog stocking is authorized by this plan.

---

## File map

| Path | Responsibility |
| --- | --- |
| `electron/server/lib/app-version.ts` | One generic Story Studio version resolver shared by Content Packs and the store catalog query. |
| `electron/server/lib/genstudio-content-store.ts` | Exact 0.21 remote types, bounded parsers, canonical JSON bytes, one-attempt HTTP calls, and typed refusal/transport errors. |
| `electron/server/content-store/commerce-state.ts` | Locked, strict, atomic quote/attempt/receipt cache and interrupted-submit recovery. |
| `electron/server/content-store/types.ts` | Zod schemas and durable state/result types; no remote networking. |
| `electron/server/services/content-store.ts` | Active-key/account orchestration and state transitions; never installs content. |
| `electron/server/routes/content-store.ts` | Authenticated local read/quote/purchase endpoints and exact status mapping. |
| `electron/server/routes/app-settings.ts` | Adds the safe `content:read` key probe and reports that `content:purchase` cannot be probed without spending. |
| `frontend/composables/useContentStore.ts` | Store page state and user-triggered quote/purchase actions. |
| `frontend/pages/content-store.vue` | Discover/Owned Phase 1 storefront with honest empty, scope, incompatible, insufficient, unavailable, uncertain, and success states. |
| `frontend/components/content-store/ContentProductCard.vue` | Bounded descriptive product and bundle presentation. |
| `frontend/components/content-store/ContentPurchaseDialog.vue` | Exact quote confirmation, permanent-ownership copy, remaining balance, and explicit confirm. |
| `frontend/components/ThisMacSettings.vue` | Required Content Store scopes and truthful key-test result. |
| `frontend/pages/index.vue`, `frontend/layouts/dashboard.vue` | Global and project navigation to the Content Store. |

## Task 1: Implement the exact GenStudio 0.21 client and safe scope probe

**Files:**

- Create: `electron/server/lib/app-version.ts`
- Create: `electron/server/lib/genstudio-content-store.ts`
- Create: `electron/server/__tests__/genstudio-content-store-client.test.ts`
- Modify: `electron/server/content-packs/installer.ts`
- Modify: `electron/server/__tests__/content-pack-installer.test.ts`
- Modify: `electron/server/routes/app-settings.ts`
- Modify: `electron/server/__tests__/app-settings-isolation.test.ts`

**Interfaces:**

- Consumes: `getGenStudioUrl()`, bearer API key, GenStudio 1.4 schemas, and current package/Electron version metadata.
- Produces:

```ts
export type GenStudioContentProductKind =
  | 'series_formula'
  | 'topic_pack'
  | 'visual_style'
  | 'thumbnail_recipe'
  | 'niche_bundle'

export interface CanonicalJsonObject {
  value: Record<string, unknown>
  canonicalJson: string
  canonicalBytes: Uint8Array
}

export class GenStudioContentStoreApiError extends Error {
  readonly status: number
  readonly code: string | null
  readonly detail: string
  readonly refusal: Record<string, unknown>
}

export class GenStudioContentStoreTransportError extends Error {
  readonly outcome: 'not-sent' | 'uncertain'
}

export function canonicalizeContentStoreObject(value: unknown): CanonicalJsonObject
export function parseContentStoreAccount(value: unknown): GenStudioContentAccount
export function parseContentStoreCatalog(value: unknown): GenStudioContentCatalog
export function parseContentStoreQuote(value: unknown): GenStudioContentQuote
export function parseContentStorePurchase(value: unknown): GenStudioContentPurchase
export async function getGenStudioContentAccount(apiKey: string): Promise<GenStudioContentAccount>
export async function listGenStudioContentProducts(apiKey: string, storyVersion: string): Promise<GenStudioContentCatalog>
export async function quoteGenStudioContentProduct(
  apiKey: string,
  request: { product_id: string; release_id: string | null },
): Promise<GenStudioContentQuote>
export async function purchaseGenStudioContentProduct(
  apiKey: string,
  request: { quoteCanonicalJson: string; quoteSignature: string; idempotencyKey: string },
): Promise<GenStudioContentPurchase>
export async function resolveStoryStudioVersion(): Promise<string>
```

- `GenStudioContentQuote` contains every exact summary field plus `signedQuote: CanonicalJsonObject`; `GenStudioContentPurchase` contains exact purchase fields plus a canonical receipt payload. Both keep raw bounded JSON snapshots where the GenStudio schema intentionally says `dict[str, Any]`.

- [ ] **Step 1: Write exact response and canonicalisation tests**

Create table-driven tests from the examples and Pydantic source in `apps/cloud-api/app/modules/content_store/schemas.py`. Cover:

```ts
test('preserves the complete signed quote while canonicalising recursively', () => {
  const parsed = parseContentStoreQuote({
    quote: { z: 3, nested: { beta: 'é', alpha: [2, { y: false, x: null }] }, a: 1 },
    quote_signature: validSignature,
    quote_id: 'cq_test', key_id: 'key-1', expires_at: '2026-08-14T10:15:00Z',
    account_id: 'acct_a', product_id: 'cprod_a', entitlement_family: 'com.storystudio.test',
    release_id: 'crel_a', base_credit_price: 400, discount_credits: 100,
    quoted_credits: 300, balance_before: 5000, balance_after: 4700,
    owned_components: [], sufficient_credits: true, insufficient_reason: null,
    shortfall_credits: 0,
  })
  assert.equal(parsed.signedQuote.canonicalJson,
    '{"a":1,"nested":{"alpha":[2,{"x":null,"y":false}],"beta":"é"},"z":3}')
  assert.deepEqual(JSON.parse(parsed.signedQuote.canonicalJson), parsed.signedQuote.value)
})
```

Also assert: all five product kinds; nullable current releases; empty `products`; owned retired product; `free: true` at price zero; compatibility reason; bundle ownership discount; `content_spendable_credits`; unaffordable quote; free and paid purchase; nullable ledger key; `replayed`; canonical receipt; malformed/oversized/unbounded objects fail closed; non-finite numbers and forbidden JSON values fail; unknown fields inside signed `quote`, `receipt`, `product`, `release`, and `component_summary` remain present instead of being stripped. Assert the signed quote carries `typ: 'genstudio.content.quote.v1'` and the signed receipt carries `typ: 'genstudio.content.receipt.v1'`; each signed payload's `key_id` must match its envelope. Assert quote ID/account/product/family/release/expiry/price/discount/owned-components fields match between the signed quote and its display envelope so Story can never confirm one object after displaying another.

- [ ] **Step 2: Run the focused parser test and observe RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/genstudio-content-store-client.test.ts
```

Expected: FAIL with `ERR_MODULE_NOT_FOUND` for `genstudio-content-store.js`.

- [ ] **Step 3: Implement bounded canonical JSON and exact parsers**

Implement a recursive JSON validator/canonicaliser that:

```ts
function canonicalJson(value: JsonValue): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'number' && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
}
```

Reject prototypes other than `Object.prototype`/`null`, dangerous keys (`__proto__`, `prototype`, `constructor`), depth over 32, more than 4,096 nodes, strings over 256 KiB, and canonical payloads over 1 MiB. Use field readers that require all exact 0.21 fields and types while returning the original signed dictionaries. Enforce the signed/envelope coherence checks from Step 1 and non-negative integer credit/size fields. Do not use a schema transform that strips signed fields.

- [ ] **Step 4: Write one-attempt HTTP tests and observe RED**

Stub `global.fetch` and assert exact paths, methods, bearer header, `story_version`, request bodies, and `Idempotency-Key`. For each POST, simulate 503 and a socket error and assert `fetch` was called exactly once. Assert the purchase body is created only with:

```ts
body: JSON.stringify({
  quote: JSON.parse(request.quoteCanonicalJson),
  quote_signature: request.quoteSignature,
})
```

Assert exact typed errors for 402/404/409/503; 402 retains the three published credit figures. Assert a network failure before a response on purchase becomes `outcome: 'uncertain'`; a synchronous input/URL failure becomes `outcome: 'not-sent'`. Do not classify a returned GenStudio refusal as uncertain.

- [ ] **Step 5: Implement the four HTTP calls without generic retry/admission**

Use the active `getGenStudioUrl()` and one `fetch` per call with an 8-second timeout for GET/catalog/quote and a 30-second timeout for purchase. Parse response text once so invalid JSON, status, code, detail, and refusal fields are preserved. GET calls may be refreshed by the caller, but this client performs no internal loop. Never call `requestJsonWithRetry`, `withGenStudioAdmission`, the Job Queue, or any generation helper.

- [ ] **Step 6: Extract the generic app-version resolver**

Move the existing package/Electron version logic from `content-packs/installer.ts` to `lib/app-version.ts`. Keep `resolveContentPackAppVersion()` as a compatibility wrapper so existing imports and tests do not change behavior. Add a focused test proving both Content Packs and Content Store see `1.0.834` before the release task and the injected packaged version in packaged-mode tests.

- [ ] **Step 7: Add a truthful Content Store key probe**

Extend the existing API-key test route with one safe probe:

```ts
{ path: '/v1/content/account', scope: 'content:read', label: 'Content Store account', expected: 200 }
```

Return structured probe facts in addition to the existing message:

```ts
content_store: {
  read_scope: 'verified',
  purchase_scope: 'required_unverified',
}
```

If the read call returns 401, preserve the existing invalid-or-missing-scope wording and name `content:read`. Never probe `/v1/content/purchases`, never create a quote, and never claim `content:purchase` passed.

- [ ] **Step 8: Run focused and neighboring GREEN checks**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/app-settings-isolation.test.ts \
  electron/server/__tests__/genstudio-client-boundary.test.ts
npm run typecheck:electron
npm run lint -- --quiet
git diff --check
```

Expected: all tests pass, typecheck/lint exit 0, and no whitespace errors.

- [ ] **Step 9: Commit and obtain an independent review**

```bash
git add electron/server/lib/app-version.ts electron/server/lib/genstudio-content-store.ts \
  electron/server/content-packs/installer.ts electron/server/routes/app-settings.ts \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-pack-installer.test.ts \
  electron/server/__tests__/app-settings-isolation.test.ts
git commit -m "feat: read GenStudio content store contract"
```

Ask a fresh reviewer to compare the implementation with GenStudio's Pydantic source, router, signing canonicaliser, and 0.21 contract. It must reject any generic POST retry, signed-field projection, invented scope result, or renamed refusal. Apply every Critical/Important correction with a focused failing test and a follow-up commit before Task 2.

## Task 2: Persist quotes, stable idempotency, restart state, and unverified receipts

**Files:**

- Create: `electron/server/content-store/types.ts`
- Create: `electron/server/content-store/commerce-state.ts`
- Create: `electron/server/__tests__/content-store-commerce-state.test.ts`

**Interfaces:**

- Consumes: canonical quote/receipt strings from Task 1, `getContentPackRuntimePaths().root`, `withLock`, `writeJsonAtomic`, and `assertWriteIsolatedInTests`.
- Produces:

```ts
export type ContentPurchaseAttemptStatus =
  | 'quoted'
  | 'submitting'
  | 'uncertain'
  | 'refused'
  | 'completed'

export interface CachedContentQuote {
  quote_id: string
  account_id: string
  product_id: string
  release_id: string
  entitlement_family: string
  expires_at: string
  quote_canonical_json: string
  quote_signature: string
  key_id: string
  idempotency_key: string
  status: ContentPurchaseAttemptStatus
  created_at: string
  updated_at: string
  last_refusal?: CachedContentRefusal
  completed_purchase?: CachedContentPurchase
}

export function getContentStoreStatePath(): string
export async function readContentStoreCommerceState(): Promise<ContentStoreCommerceState>
export async function saveQuotedAttempt(quote: GenStudioContentQuote): Promise<CachedContentQuote>
export async function beginPurchaseAttempt(quoteId: string, accountId: string): Promise<CachedContentQuote>
export async function recordPurchaseUncertain(quoteId: string, detail: string): Promise<CachedContentQuote>
export async function recordPurchaseRefusal(
  quoteId: string,
  refusal: CachedContentRefusal,
): Promise<CachedContentQuote>
export async function recordCompletedPurchase(
  quoteId: string,
  purchase: GenStudioContentPurchase,
): Promise<CachedContentQuote>
export async function recoverInterruptedContentPurchases(): Promise<number>
```

- `CachedContentPurchase.receipt` stores `receipt_canonical_json`, `receipt_signature`, `key_id`, and literal `verification: 'unverified_phase1'`. There is no verified/valid boolean.

- [ ] **Step 1: Write state, transition, and crash-recovery tests**

Using an isolated `STORY_STUDIO_DATA_DIR`, assert:

1. saving a quote creates `content-packs/commerce-state.json` mode `0600` and a random `story-content-<uuid>` key between 8 and 128 characters;
2. two concurrent saves of the same `quote_id` return the same key and bytes;
3. the same `quote_id` with different canonical quote bytes/signature/account is refused as identity drift;
4. `quoted → submitting → refused → submitting → completed` reuses one key;
5. each exact 402/404/409/503 refusal shape is bounded and retained without changing the key;
6. a `submitting` record from a prior process becomes `uncertain` on explicit boot/read recovery, with no network action;
7. `uncertain → submitting` is permitted only by an explicit caller;
8. a completed purchase is immutable and repeat reads return the same receipt bytes;
9. receipt verification is always `unverified_phase1`;
10. account mismatch refuses before changing status;
11. malformed/oversized state is quarantined using the existing safe direct-child pattern;
12. parallel mutations do not lose records; runtime-root/state/lock/quarantine symlinks fail closed;
13. no API key or masked key field is accepted by the strict schema.

- [ ] **Step 2: Run the state suite and observe RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-store-commerce-state.test.ts
```

Expected: FAIL because `content-store/commerce-state.js` does not exist.

- [ ] **Step 3: Define a strict bounded schema**

Use a strict `schema_version: 1` document and record only the fields above. Enforce:

- at most 200 quote records;
- 1 MiB maximum canonical quote or receipt payload;
- 2 KiB maximum detail strings;
- known refusal status/code pairings only;
- ISO datetimes and exact account/product/release IDs as bounded opaque strings;
- idempotency key length 8–128;
- no unrecognised fields.

When the record count exceeds 200, prune oldest expired `quoted`/`refused` and then oldest `completed` records; never prune `submitting` or `uncertain`. If safe pruning cannot get below the limit, refuse the new quote rather than losing in-flight evidence.

- [ ] **Step 4: Implement atomic transitions under one lock**

Reuse the Content Pack runtime root safety checks and lock ordering, but use a separate `commerce-state.json.lock`. Generate the idempotency key inside the first locked save so concurrent callers cannot mint alternatives. Write mode `0600`, fsync through `writeJsonAtomic`, and never write a state that says `submitting` after a synchronous preflight failure.

`recordCompletedPurchase()` must compare purchase `account_id` with the cached quote, ensure the entitlement family includes the quoted family, and preserve GenStudio's exact `credits_charged`, `balance_before`, `balance_after`, `replayed`, product snapshot, release snapshot, and receipt. It does not infer installation or verify the signature.

- [ ] **Step 5: Run focused and shared-state GREEN checks**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-commerce-state.test.ts \
  electron/server/__tests__/content-pack-state.test.ts \
  electron/server/__tests__/atomic-store.test.ts
npm run typecheck:electron
npm run lint -- --quiet
git diff --check
```

- [ ] **Step 6: Commit and obtain an independent review**

```bash
git add electron/server/content-store/types.ts electron/server/content-store/commerce-state.ts \
  electron/server/__tests__/content-store-commerce-state.test.ts
git commit -m "feat: persist content store purchase evidence"
```

The reviewer must trace concurrent quote saves, every state edge, interruption between durable `submitting` and HTTP response, refusal retry with the same key, quarantine/symlink behavior, secret absence, and receipt wording. Fix all Critical/Important findings with RED-to-GREEN tests before Task 3.

## Task 3: Add backend Content Store orchestration and exact route semantics

**Files:**

- Create: `electron/server/services/content-store.ts`
- Create: `electron/server/routes/content-store.ts`
- Create: `electron/server/__tests__/content-store-routes.test.ts`
- Modify: `electron/server/routes/index.ts`
- Modify: `electron/server/__tests__/fixtures/mock-genstudio-service.ts`

**Interfaces:**

- Consumes: Task 1 client, Task 2 commerce state, `getApiKey('genstudio')`, `resolveStoryStudioVersion()`, and `humanizeBackendError` only for non-contract local failures.
- Produces local routes:

```text
GET  /api/content-store
POST /api/content-store/quotes
POST /api/content-store/quotes/:quoteId/purchase
```

```ts
export interface ContentStoreOverview {
  phase: 'commerce_core'
  account: GenStudioContentAccount
  products: GenStudioContentProduct[]
  attempts: PublicContentPurchaseAttempt[]
  capabilities: {
    purchase: true
    receipt_verification: false
    download: false
    install_after_purchase: false
    restore: false
  }
}

export async function loadContentStoreOverview(): Promise<ContentStoreOverview>
export async function createContentStoreQuote(input: {
  product_id: string
  release_id: string | null
}): Promise<PublicContentPurchaseAttempt>
export async function confirmContentStorePurchase(quoteId: string): Promise<PublicContentPurchaseAttempt>
```

- Public attempts expose bounded IDs, price/balance/status, refusal summary, and `owned_not_installed`; they do not expose canonical quote/receipt JSON or signatures to the renderer.

- [ ] **Step 1: Write route REDs against a controlled mock GenStudio**

Cover:

- no saved key returns local 400 and sends no remote request;
- `GET /content-store` sends `story_version=1.0.834`, returns exact account/products, and accepts `products: []` as 200;
- a 401 from account/catalog remains an actionable scope failure and does not fall back to cached ownership from another key;
- quote takes only `product_id`/nullable `release_id`, saves canonical evidence, and does not debit;
- purchase checks the current `/v1/content/account` first and refuses a different `account_id` locally before POST;
- same-account key rotation succeeds because equality is by account ID, not key bytes;
- concurrent double-click allows one purchase network request; the other receives the same in-progress/finished local attempt rather than a new key;
- a transport drop after purchase begins returns local 502 with `status: 'uncertain'`, makes one POST, and retains the key;
- an explicit second local purchase call reuses the key; if GenStudio returns `replayed: true`, Story stores completion;
- 402, 404, 409, and 503 preserve exact upstream status/code and published fields, mark `refused`, and retain the key;
- `409 quote_rejected` directs the UI to obtain a new quote; it never silently requotes;
- `409 already_owned` remains ownership truth, not a failed installation;
- 503 `signing_unavailable` is a normal “store not open yet” state;
- success stores `owned_not_installed`, `credits_charged`, and unverified receipt, performs no local import/install, and creates no Job Queue entry;
- a completed local attempt is returned from cache without another purchase POST;
- source dependency assertions reject imports from `content-packs/installer`, `content-packs/lifecycle`, `job-queue`, or GenStudio admission/generation modules.

- [ ] **Step 2: Run route tests and observe RED**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 electron/server/__tests__/content-store-routes.test.ts
```

Expected: FAIL with missing route/service modules.

- [ ] **Step 3: Implement orchestration with account and identity guards**

`loadContentStoreOverview()` reads the active key, then account and catalog. It never serves stale remote ownership after an authentication/scope failure. It calls `recoverInterruptedContentPurchases()` to relabel only local state; this function performs no remote call.

`createContentStoreQuote()` validates that the product exists in the latest catalog and is compatible/not owned/not retired before making the one explicit quote call. GenStudio remains authoritative: a race may still return exact 404/409/503. Save the quote before returning it.

`confirmContentStorePurchase()` performs this order:

1. read the saved attempt;
2. read current remote account with the active key;
3. require current `account_id === saved account_id`;
4. atomically move the record to `submitting` and retrieve its existing key;
5. make exactly one purchase POST from persisted canonical quote bytes;
6. record completed, exact refusal, or uncertain transport state;
7. return a renderer-safe projection.

Do not begin a new quote, alter the key, retry, install, or enqueue anything in a catch block.

- [ ] **Step 4: Implement thin Express routes and exact mappings**

Accept JSON bodies no larger than 16 KiB. Quote request fields are strict. Quote ID parameters are bounded. For known `GenStudioContentStoreApiError`s, respond with the upstream status and exact code/detail/credit fields. For a purchase transport ambiguity, use local HTTP 502 with:

```json
{
  "code": "CONTENT_PURCHASE_OUTCOME_UNCERTAIN",
  "detail": "Story Studio did not receive GenStudio's answer. No replacement purchase was sent. Retry this exact purchase to replay its saved idempotency key.",
  "status": "uncertain"
}
```

This is a local transport classification, not a claim that GenStudio accepted or rejected the purchase.

Do not expose quote/receipt signatures, canonical JSON, API keys, filesystem paths, or local install roots in route output or logs.

- [ ] **Step 5: Run focused, contract, and negative-boundary GREEN checks**

Run:

```bash
STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 \
  electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/genstudio-content-store-client.test.ts \
  electron/server/__tests__/content-store-commerce-state.test.ts \
  electron/server/__tests__/content-pack-routes.test.ts \
  electron/server/__tests__/error-boundary.test.ts
npm run typecheck:electron
npm run lint -- --quiet
git diff --check
```

- [ ] **Step 6: Commit and obtain an independent review**

```bash
git add electron/server/services/content-store.ts electron/server/routes/content-store.ts \
  electron/server/routes/index.ts electron/server/__tests__/content-store-routes.test.ts \
  electron/server/__tests__/fixtures/mock-genstudio-service.ts
git commit -m "feat: orchestrate GenStudio content purchases"
```

The reviewer must audit financial ambiguity, account switching, idempotency reuse, POST count, crash state, exact status/code preservation, response redaction, route auth, and absence of installer/Job Queue calls. Correct all Critical/Important findings before any UI is built.

## Task 4: Build the Content Store UI, navigation, and scope guidance

**Required skill:** Read and use `impeccable` before editing the frontend. Run its context pass once, not repeatedly, and use visual QA rather than source tests as proof of geometry.

**Files:**

- Create: `frontend/composables/useContentStore.ts`
- Create: `frontend/pages/content-store.vue`
- Create: `frontend/components/content-store/ContentProductCard.vue`
- Create: `frontend/components/content-store/ContentPurchaseDialog.vue`
- Create: `frontend/__tests__/contentStore.test.ts`
- Modify: `frontend/components/ThisMacSettings.vue`
- Modify: `frontend/pages/index.vue`
- Modify: `frontend/layouts/dashboard.vue`
- Modify: `frontend/__tests__/settingsWorkspace.test.ts`
- Modify: `frontend/__tests__/genstudioOnboardingBoundary.test.ts`

**Interfaces:**

- Consumes: Task 3 renderer-safe DTOs through `useApi()`.
- Produces:

```ts
export function useContentStore(): {
  account: Readonly<Ref<ContentStoreAccount | null>>
  products: Readonly<Ref<ContentStoreProduct[]>>
  attempts: Readonly<Ref<PublicContentPurchaseAttempt[]>>
  loading: Readonly<Ref<boolean>>
  error: Readonly<Ref<ContentStoreUiError | null>>
  refresh: () => Promise<void>
  requestQuote: (productId: string, releaseId?: string | null) => Promise<PublicContentPurchaseAttempt>
  confirmPurchase: (quoteId: string) => Promise<PublicContentPurchaseAttempt>
}
```

- [ ] **Step 1: Write frontend behavior tests and observe RED**

Test the composable and source-visible accessibility contract for:

- initial load and explicit refresh only; no polling purchase endpoint;
- exact `content_spendable_credits` display beside total available credits;
- empty catalog copy: “The Content Store is ready, but no packs have been published yet.”;
- Discover and Owned filters; an owned retired product remains in Owned;
- all five product-kind labels and bundle component/owned-discount facts;
- incompatible products have no quote button and show `compatibility_reason`;
- free pack uses “Get permanently” and still requires an explicit quote/confirm;
- paid pack uses “See exact quote,” never a locally computed price;
- quote dialog shows base price, owned discount, quoted ceiling, spendable balance before/after, expiry, and “Permanent ownership for this GenStudio account”;
- confirm button is disabled for `sufficient_credits: false` and the page shows `shortfall_credits` plus a **View credits** link to `/usage`, not an invented Buy Credits URL;
- quote copy says final charge may be lower and purchase success uses `credits_charged`;
- 503 signing unavailable says the store is not open yet without an alarming failure banner;
- uncertain purchase copy says no replacement was sent and explicit Retry uses the saved attempt;
- 401 names the required `content:read` or `content:purchase` scope without claiming which credential defect caused it;
- success says “Owned in GenStudio · not installed on this Mac” and does not show Download/Install/Restore;
- receipt copy says “Receipt cached · verification arrives with Phase 2,” never verified;
- no product cards for an empty catalog; no fake starter entries, artwork, gallery, license, download, or portal URL;
- navigation links from home and project dashboard;
- Settings lists `content:read` and `content:purchase`, reports read scope verified, and labels purchase scope required/not safely testable.

- [ ] **Step 2: Run the focused frontend test and observe RED**

Run:

```bash
npm --prefix frontend exec tsx -- --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/settingsWorkspace.test.ts \
  __tests__/genstudioOnboardingBoundary.test.ts
```

Expected: FAIL because the page/composable/components do not exist.

- [ ] **Step 3: Implement the composable as a small explicit state machine**

Keep network calls behind `refresh`, `requestQuote`, and `confirmPurchase`. A failed quote never opens the confirmation dialog. A refused/uncertain purchase keeps the same public attempt and surfaces the backend's exact state. Do not automatically requote on expiry, retry a purchase on mount, or derive ownership from local state.

- [ ] **Step 4: Implement the page and components with deliberate hierarchy**

Use one restrained store header, two primary tabs (`Discover`, `Owned`), a compact account strip, and cards whose primary facts are title, kind, publisher, exact published credit price, ownership, compatibility, and current release. Avoid a dashboard of ornamental metric cards. Use text labels plus icons; color is supplemental.

The confirmation dialog must:

- trap focus through the existing `Modal` component;
- place initial focus on Close/Cancel, not the spending action;
- state exact deduction ceiling and remaining content-spendable balance;
- require one deliberate confirm click;
- remain open with actionable 402/404/409/503/uncertain copy;
- close only after acknowledged completion or explicit cancel.

- [ ] **Step 5: Add navigation and truthful Settings scope UX**

Add `Content Store` to the global home actions and the project Manage group. Preserve mobile navigation focus/close behavior. Update `ThisMacSettings.vue` required scopes and test-result rendering so `content:read` can be verified while `content:purchase` remains visibly required but unproven until a real purchase.

- [ ] **Step 6: Run frontend GREEN checks**

Run:

```bash
npm --prefix frontend exec tsx -- --import ./__tests__/setup.ts --test \
  __tests__/contentStore.test.ts __tests__/settingsWorkspace.test.ts \
  __tests__/genstudioOnboardingBoundary.test.ts
npm --prefix frontend run typecheck
npm run build:frontend
git diff --check
```

- [ ] **Step 7: Perform visual and accessibility QA**

Run the dev app against the controlled mock Content Store fixture, never production purchase. Capture and inspect:

1. 1440×900 populated Discover page;
2. 1440×900 empty catalog;
3. 390×844 Discover and Owned tabs;
4. sufficient paid quote dialog;
5. insufficient quote state;
6. owned-not-installed success;
7. signing unavailable and uncertain outcome;
8. Settings scope test result.

Verify zero page/dialog horizontal overflow, reachable card/list tails, visible focus, Escape/Close behavior, keyboard tab order, 200% zoom, mobile sidebar focus return, readable long titles/descriptions, and that the spending action never receives initial focus. Inspect the built CSS if any scoped style loses specificity.

- [ ] **Step 8: Commit and obtain an independent UX/contract review**

```bash
git add frontend/composables/useContentStore.ts frontend/pages/content-store.vue \
  frontend/components/content-store/ContentProductCard.vue \
  frontend/components/content-store/ContentPurchaseDialog.vue \
  frontend/components/ThisMacSettings.vue frontend/pages/index.vue \
  frontend/layouts/dashboard.vue frontend/__tests__/contentStore.test.ts \
  frontend/__tests__/settingsWorkspace.test.ts frontend/__tests__/genstudioOnboardingBoundary.test.ts
git commit -m "feat: add Content Store commerce UI"
```

The reviewer compares every label/action with the 0.21 fields and Phase 1 absences, then checks accessibility and both viewport captures. Any Critical/Important issue gets a failing behavior test or reproducible visual case before correction.

## Task 5: Whole-range review, release v1.0.835, package, and packaged QA

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Modify: `CHANGELOG.md`
- Modify: `.superpowers/sdd/2026-08-14-story-content-store-phase1/progress.md`
- Test: all files added or changed in Tasks 1–4

**Interfaces:**

- Consumes: independently approved Task 1–4 commits.
- Produces: local Story Studio v1.0.835 commit and unsigned arm64 DMG evidence. No push/deploy/publish/purchase.

- [ ] **Step 1: Run an independent whole-range financial/security review**

Give a fresh reviewer the approved design, all four GenStudio handoffs, exact API contract/source, this plan, and `git diff 94c6578..HEAD`. Require an explicit verdict on:

- exact response fields and refusal codes;
- `content_spendable_credits` versus total credits;
- canonical quote preservation and receipt non-verification;
- one-attempt POST behavior and persistent idempotency;
- restart/uncertain/replay behavior;
- same-account key rotation and different-account refusal;
- no installer, Job Queue, reservation, or generation coupling;
- no signed bytes/secrets/path leakage to renderer/logs;
- empty catalog and missing Phase 2/3 fields;
- no false owned/installed/download/verified claims;
- accessibility and narrow-screen evidence.

Fix every Critical/Important item using focused RED-to-GREEN regressions. Do not version until the reviewer returns GO.

- [ ] **Step 2: Bump the complete release to v1.0.835**

Update `package.json` and root `package-lock.json` to `1.0.835`. Add the newest changelog section:

```markdown
## v1.0.835

- Added the GenStudio Content Store commerce core: browse published packs, see the exact content-spendable balance, request a signed quote, and confirm a permanent account purchase with durable idempotency.
- Added restart-safe purchase evidence and an unverified receipt cache. Story Studio never repeats a purchase automatically and clearly separates GenStudio ownership from installation on this Mac.
- Added Content Store scope checks and honest empty, insufficient-credit, incompatible, unavailable, and uncertain-outcome guidance. Downloads, restore, and receipt verification remain disabled until GenStudio Phase 2 publishes their contracts.
```

- [ ] **Step 3: Run full verification and audits**

Run:

```bash
npm run check:changelog
npm run verify
npm audit --omit=dev --audit-level=low
npm --prefix frontend audit --omit=dev --audit-level=low
git diff --check
git status --short
```

Report test counts and audit output exactly. Do not claim the development dependency tree is clean unless a separate full audit says so.

- [ ] **Step 4: Build and verify the unsigned package**

Run:

```bash
npm run dist:smoke
```

Verify the DMG mounts read-only, the app/ASAR/resources pass the existing artifact checks, the bundled recovery Content Pack still exists, and a fresh-data packaged boot serves 200 for `/api/health`, `/api/content-packs`, and `/api/content-store` against the safe mock/empty catalog. Do not send a live quote or purchase.

- [ ] **Step 5: Repeat packaged visual QA**

In the packaged app, verify the deliberate empty catalog, missing-scope Settings copy, home/project navigation, and 390×844 layout. Populated quote/purchase states remain mock-only so packaging verification cannot mutate a real balance.

- [ ] **Step 6: Finalize the ledger and commit locally**

Record every task commit, review verdict, RED/GREEN command, test count, audit result, artifact path, and known Phase 2 boundary in the SDD ledger, then:

```bash
git add package.json package-lock.json CHANGELOG.md \
  .superpowers/sdd/2026-08-14-story-content-store-phase1/progress.md
git commit -m "chore: release Content Store commerce core"
```

The final handoff must say:

- what Phase 1 can do;
- that the live GenStudio catalog may correctly be empty;
- that successful purchases are owned but not installed;
- that receipts are cached but unverified;
- that download/install/restore/public-key/portal work remains Phase 2/3;
- exact verification and artifact evidence;
- exact local branch/commit;
- that no push, deployment, catalog publication, or live purchase occurred.

## Self-review

- **Spec coverage:** Tasks 1–4 cover exact catalog/account/quote/purchase fields, scopes, content-spendable credits, account-rooted ownership, one-click explicit purchase, durable idempotency, refusal/restart behavior, receipt caching, empty catalog, navigation, and Phase 1 UI. Task 5 covers release integrity, whole-range review, packaging, and visual QA.
- **Explicit Phase boundary:** No task downloads, verifies, installs, restores, updates, or disables a purchased pack; no task claims receipt verification or a customer portal. These require GenStudio Phase 2/3 contracts.
- **No invented contract:** The plan adds no Buy Credits URL, gallery, artwork, license, public key, download token, restore endpoint, or portal link. The only local-only code introduced is `CONTENT_PURCHASE_OUTCOME_UNCERTAIN`, clearly labelled as Story's transport classification.
- **Type consistency:** `GenStudioContentQuote.signedQuote.canonicalJson` feeds `CachedContentQuote.quote_canonical_json`; `beginPurchaseAttempt()` returns the stable `idempotency_key`; `purchaseGenStudioContentProduct()` consumes both; `recordCompletedPurchase()` stores `receipt_canonical_json` with `verification: 'unverified_phase1'`; renderer projections omit both canonical payloads and signatures.
- **Placeholder scan:** No TBD/TODO/“similar to” steps remain. Every task names exact files, interfaces, RED/GREEN commands, commit, and independent review gate.
