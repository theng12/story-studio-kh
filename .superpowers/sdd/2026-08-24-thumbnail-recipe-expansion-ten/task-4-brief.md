### Task 4: Intake and Qualify Returned Preview Evidence

**Files:**
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/returned-evidence.json`
- Create: `content-packs/thumbnail-recipe-expansion-ten/PREVIEW-PROVENANCE.md`
- Create: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: thirty untouched returned rasters and complete job/provenance/cost/rightsholder evidence from the separately authorized batch.
- Produces: a fixed accepted/quarantined inventory and RED source expectations for eligible recipes.

- [ ] **Step 1: Verify the execution envelope**

Hash-match the original batch and approval, then require every return row to contain job/request ID, named worker, submitted prompt and hash, provider/model, timestamp, seed or explicit unavailable, cost receipt, published rights basis, no-reference/no-compositing attestation, returned-byte SHA-256, bytes, type, dimensions, decode result, exact-title transcription, and line count.

- [ ] **Step 2: Decode and review every untouched raster**

Use Sharp with `failOn: 'error'`; require WebP `1672x941`, byte count greater than `20_000`, exact title and line count, one title-safe area, recipe invariant, and material within-recipe diversity. Reject malformed anatomy, bad numerals, false claims, pasted-looking inset/title, logo, watermark, UI, creator likeness, copied trade dress, or near duplicate.

- [ ] **Step 3: Create a fail-closed inventory**

For each slug set status `eligible` only when all three rows pass. A single failed row makes that recipe `blocked`; preserve rejected bytes under an external quarantine path and do not create its source directory. Record exact reasons, hashes, and recoverability.

- [ ] **Step 4: Write provenance and RED source tests**

Write one immutable provenance row per accepted raster. The test pins the accepted hashes, dimensions, bytes, title text, line count, prompt hash, rights basis, and receipt. Add one source test per eligible slug that fails because its receipt-authorized source does not yet exist; blocked slugs assert source absence and reserved registry status.

- [ ] **Step 5: Commit only durable intake tests/provenance**

```bash
npx tsx --test electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

Expected: RED only for eligible missing source paths. Do not commit a globally failing test; continue immediately through Tasks 5–9 and commit each GREEN pair with its tests/provenance rows.

