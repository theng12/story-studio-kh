### Task 9: Author Macro Mystery Detail and Hands-On POV Moment

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/macro-mystery-detail/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hands-on-pov-moment/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.9–5.10.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Macro Mystery Detail|Hands-On POV Moment" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Macro Mystery requires one ambiguous macro detail plus one honest edge clue, no reaction host, separate inset, or false reveal. Hands-On POV requires first-person/over-shoulder hands performing one legible non-harmful action, one task context, no portrait/result-only fallback, extra/malformed hands, or unsafe instruction.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Macro Mystery Detail|Hands-On POV Moment" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add macro and POV recipes"
```

