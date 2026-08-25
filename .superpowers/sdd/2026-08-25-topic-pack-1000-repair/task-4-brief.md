### Task 4: Night Journeys

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/night-journeys-semantic-review.md`; `content-packs/free-starters/topic/night-journeys-v1.0.1/pack.json`; `content-packs/free-starters/topic/night-journeys-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/night-journeys.json`; stop on any mismatch.
- [ ] Add only the `night-journeys` reviewed row (`tupleAdditions: 970`) and run red.
- [ ] Author 50 × 20 non-alarming, safe sleep-story tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: night-journeys" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

