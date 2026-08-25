### Task 3: Human Behavior Social Dynamics

**Files:** `electron/server/__tests__/topic-pack-1000-successors.test.ts`; `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reviews/human-behavior-social-dynamics-semantic-review.md`; `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1/pack.json`; `content-packs/free-starters/topic/human-behavior-social-dynamics-v1.0.1/content/topic-pack.json`.

- [ ] First run `verify-receipt` for `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/human-behavior-social-dynamics.json`; stop on any mismatch.
- [ ] Add only the `human-behavior-social-dynamics` reviewed row (`tupleAdditions: 980`) and run red.
- [ ] Author same-identity 50 × 20 subject-specific social-dynamics tuples.
- [ ] Run green:

```bash
npx tsx --test --test-name-pattern "capacity: human-behavior-social-dynamics" electron/server/__tests__/topic-pack-1000-successors.test.ts
npx tsx --test electron/server/__tests__/free-starter-signed-source-golden.test.ts
```

