### Task 5: Habits and Momentum

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/habits-momentum-semantic-review.md`; `content-packs/free-starters/topic/habits-momentum-v1.0.1/pack.json`; `content-packs/free-starters/topic/habits-momentum-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/habits-momentum.json`; stop on any mismatch.
- [ ] Add only the `habits-momentum` reviewed row (`tupleAdditions: 970`) and run red.
- [ ] Author 50 × 20 concrete practice tuples; retain only the existing documented `a water bottle|cue design` exception if current tests still permit it.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: habits-momentum" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

