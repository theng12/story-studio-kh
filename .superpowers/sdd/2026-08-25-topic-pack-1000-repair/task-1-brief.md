## Task 1: Coordinator reservation durability and shared capacity harness

**Files:**
- Create: `electron/server/__tests__/topic-pack-1000-successors.test.ts`
- Modify after root coordinator reserves: `content-packs/authoring-registry.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-request.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-result.json`
- Create and retain through Task 19: `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/`

**Interfaces:** Consumes exact mapping in `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/registry-mapping.md`. Produces empty `REVIEWED_ROWS`, one persisted 16-record receipt batch, and 16 verified identity files.

The exact expected-identity files are `ancient-humans-survival.json`, `deep-time-earth-systems.json`, `economics-businesses.json`, `everyday-calm.json`, `habits-momentum.json`, `historical-wars-treaties-world-order.json`, `human-behavior-social-dynamics.json`, `natural-world-animals.json`, `night-journeys.json`, `pov-historical-occupations.json`, `audience-question-seeder.json`, `empires-trade-extraction.json`, `infrastructure-commodities-corporate-power.json`, `money-debt-financial-institutions.json`, `states-revolutions-collapse.json`, and `wars-treaties-world-order.json` under `.superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/`.

- [ ] Add `readTopicSource`, `assertImmutablePredecessor`, `assertIdentity`, `assertProfileShape`, `assertIndependentShape`, and `assertPlannerCapacity` helpers. Keyless candidate assertions remain exclusively in Task 19’s MJS archive test.
- [ ] Add the all-16 identity test; assert every mapped `pack_id@1.0.1` is missing initially and run red:

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
```

- [ ] Validate the live registry, use its printed revision in a request with exactly the 16 mapping-report records, then reserve once:

```bash
npm run content-pack:registry -- validate
npm run content-pack:registry -- reserve --request .superpowers/sdd/2026-08-25-topic-pack-1000-repair/reservation-request.json
```

- [ ] Persist the returned `{ revision, receipt_ref }` in `reservation-result.json`; write the returned record fields minus `receipt_ref` into all 16 expected-identity files and verify each against the one returned revision/receipt:

```bash
npm run content-pack:registry -- verify-receipt --revision "$TOPIC1000_REVISION" --receipt "$TOPIC1000_RECEIPT" --expected-identity .superpowers/sdd/2026-08-25-topic-pack-1000-repair/expected-identities/natural-world-animals.json
```

- [ ] Make the identity test assert exactly 16 reserved records share `$TOPIC1000_RECEIPT`, then run green. Keep the reservation request/result and all expected identity files through Task 19 so every leaf and the final candidate gate can verify its exact receipt-bound identity:

```bash
npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts
npm run content-pack:registry -- validate
```

## Profile leaf tasks

Each task below modifies only the shared test plus the two named successor files. It consumes the Task 1 receipt identity and produces one reviewed 50-subject, cap-20 profile source. It preserves inherited exclusions, compatibility, evidence posture, and prompt/vocabulary facts that remain truthful.

