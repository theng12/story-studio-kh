### Task 2: Natural World Animals

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/natural-world-animals-semantic-review.md`; `content-packs/free-starters/topic/natural-world-animals-v1.0.1/pack.json`; `content-packs/free-starters/topic/natural-world-animals-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json`; stop on any mismatch.
- [ ] Add only the `natural-world-animals` reviewed profile row (`tupleAdditions: 980`) and run its pattern test red.
- [ ] Author same-identity `1.0.1` manifest and 50 × 20 concrete animal tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: natural-world-animals" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

