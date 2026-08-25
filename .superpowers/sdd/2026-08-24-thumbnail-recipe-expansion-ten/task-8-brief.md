### Task 8: Author Scale Journey and Numbered Lineup

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/scale-journey/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/numbered-lineup/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.7–5.8.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Scale Journey|Numbered Lineup" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Scale Journey requires exactly three related forms through continuous depth/scale, no factual route, no numerals, and no equal-size lineup. Numbered Lineup requires three to five equal-status entries, correct native numerals/count agreement, no tiny labels, and no implied ranking without evidence. Numbered preview/title correctness is fail-closed.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Scale Journey|Numbered Lineup" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add scale and lineup recipes"
```

