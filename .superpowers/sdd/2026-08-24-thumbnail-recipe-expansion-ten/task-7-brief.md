### Task 7: Author Hero Payoff Companion and Iconic Result Close-Up

**Files:**
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/hero-payoff-companion/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Create: `content-packs/thumbnail-recipe-expansion-ten/thumbnail/iconic-result-closeup/{pack.json,content/thumbnail-recipe.json,assets/*.webp}`
- Modify: `electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts`

**Interfaces:**
- Consumes: exact receipts/evidence and Spec sections 5.5–5.6.
- Produces: two source roots or explicit blocked absences.

- [ ] **Step 1: Run pair RED**

```bash
npx tsx --test --test-name-pattern "Hero Payoff Companion|Iconic Result Close-Up" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
```

- [ ] **Step 2: Author exact grammars**

Hero Payoff requires one generic/rights-cleared host plus one separate tangible result object connected by contact/gaze/posture; no branded product or exaggerated outcome. Iconic Result requires one truthful finished outcome dominating the frame, minimal context, no required host, and no generic single-subject documentary fallback. Preserve one title band and direct in-image title.

- [ ] **Step 3: Run GREEN and commit**

```bash
npx tsx --test --test-name-pattern "Hero Payoff Companion|Iconic Result Close-Up" electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git diff --check
git add content-packs/thumbnail-recipe-expansion-ten electron/server/__tests__/thumbnail-recipe-expansion-ten-source.test.ts
git commit -m "feat(content-packs): add payoff and result recipes"
```

