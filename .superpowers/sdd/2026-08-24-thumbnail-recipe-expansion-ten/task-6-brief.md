### Task 6: Author Reaction Evidence Inset and Cutaway Exploded Object

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/reaction-evidence-inset/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/cutaway-exploded-object/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.3–5.4.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Reaction Evidence Inset|Cutaway Exploded Object" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Reaction requires one generic/rights-cleared reaction subject, one natively rendered evidence window, gaze/gesture connection, no copied screenshot/UI/private data, and no creator likeness. Cutaway requires one object, ordered internal depth, few readable layers, no surrounding callout cloud, and no safety-critical invented internals. Preserve one title band, direct in-image title, and Style independence.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Reaction Evidence Inset|Cutaway Exploded Object" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add evidence and cutaway recipes"
```

