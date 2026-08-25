### Task 1: Atomically Reserve and Verify All Ten Identities

**Files:**
- Modify: `content-packs/authoring-registry.json`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-request.json`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.json`
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/expected-identities/*.json`

**Interfaces:**
- Consumes: the exact ten-row proposal matrix and the immediately current valid registry revision.
- Produces: one returned `{ revision, receipt_ref }`, ten persisted `reserved` records sharing that receipt, and ten successful exact receipt verifications.

- [ ] **Step 1: Establish the reservation baseline**

Run:

```bash
git status --short --branch
npm run content-pack:registry -- validate
test ! -e content-packs/authoring-registry.json.lock
```

Expected: clean worktree; valid registry; no lock. Search all current records for collisions in pack ID, item ID, source path, family, and SKU. Any collision stops the complete batch; do not rename automatically.

- [ ] **Step 2: Write the exact request against the live revision**

Create the ignored request as a complete JSON object. Set `expected_revision` to the numeric revision returned by the immediately preceding validation; set coordinator task to `thumbnail-recipe-expansion-ten`; set coordinator branch to `codex/content-expansion-portfolio`; set `proposal_ref` to `docs/superpowers/specs/2026-08-24-thumbnail-recipe-expansion-ten-design.md`; and materialize exactly the ten rows from the Exact Reservation Proposal Matrix with every fixed field from Global Constraints. Before calling reserve, parse the file and assert that `records.length === 10`, all ten slugs are unique, and no required value is empty.

- [ ] **Step 3: Submit once and verify every receipt identity**

Run:

```bash
npm run content-pack:registry -- reserve \
  --request .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-request.json \
  > .superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/reservation-result.json
```

Select the ten records carrying the returned receipt, remove only `receipt_ref`, write one expected-identity JSON per slug, and invoke `verify-receipt` separately for all ten. A stale-CAS, lock, mismatch, unexpected eleventh record, or missing row is a hard stop; reconstruct the entire request from current state rather than reserving subsets.

- [ ] **Step 4: Add durable reservation assertions**

Extend the registry test to assert exactly ten fixed source paths share one receipt and batch revision, every proposal field matches the matrix, all statuses are `reserved`, all dependencies are `[]`, and every family/SKU state is `proposed`. The test reads only committed registry data, not ignored SDD files.

- [ ] **Step 5: Verify and commit**

```bash
node --test scripts/content-packs/__tests__/authoring-registry.test.mjs
npm run content-pack:registry -- validate
git diff --check
git add content-packs/authoring-registry.json scripts/content-packs/__tests__/authoring-registry.test.mjs
git commit -m "chore(content-packs): reserve ten thumbnail recipes"
```

