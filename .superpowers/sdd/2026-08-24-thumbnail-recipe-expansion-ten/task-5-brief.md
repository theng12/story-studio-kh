### Task 5: Author Before/After Proof Panel and Two-Option Criteria Split

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/two-option-criteria-split/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: verified receipts, accepted assets/provenance, Spec sections 5.1–5.2, and reviewed Formula compatibility candidates.
- Produces: two complete source roots or explicit blocked absences.

- [ ] **Step 1: Confirm RED is limited to these eligible sources**

Run:

```bash
npx tsx --test --test-name-pattern "Before/After Proof Panel|Two-Option Criteria Split" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author minimal receipt-bound documents**

Before/After must require the same subject in matched temporal states, baseline/outcome truth, one upper title band, and no false causality. Comparison must require two contemporaneous equal-weight options, shared criteria, one upper title band, and no implied winner. Each uses three exact `preview_assets` paths named `assets/before-after-proof-panel-1.webp` through `assets/before-after-proof-panel-3.webp` or `assets/two-option-criteria-split-1.webp` through `assets/two-option-criteria-split-3.webp`, respectively; title line flexibility is 1/2/3, active Style remains authoritative, and compatibility IDs are limited to those supported by a fresh review.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Before/After Proof Panel|Two-Option Criteria Split" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add transformation and comparison recipes"
```

