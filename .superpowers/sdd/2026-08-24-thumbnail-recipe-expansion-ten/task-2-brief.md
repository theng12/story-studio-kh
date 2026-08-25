### Task 2: Author the Immutable Thirty-Preview Prompt Batch

**Files:**
- Create: `.superpowers/sdd/2026-08-24-thumbnail-recipe-expansion-ten/preview-batch.json`
- Create: `<owner-home>/Developer/_handoffs/2026-08-24_to-gpt-studiofleet_from-gpt-storystudio_thumbnail-expansion-ten-preview-quote.md`

**Interfaces:**
- Consumes: ten verified receipt records and the exact thirty preview rows in Spec section 5.
- Produces: one hash-addressed text-only/no-reference-image batch and one quote-only Studio Hub handoff. It produces no request/job or raster.

- [ ] **Step 1: Materialize exact target paths and batch authority**

Create one JSON object with `batch_format: "story-studio-preview-draft-prompt-batch-v1"`, `status: "draft-owner-approval-required"`, the exact reservation revision/receipt, and exactly thirty jobs in fixed recipe order. Each job includes:

```json
{
  "draft_job_id": "before-after-proof-panel-01",
  "pack_id": "com.storystudio.pack.thumbnail.before-after-proof-panel",
  "version": "1.0.0",
  "target_source_asset": "content-packs/thumbnail-recipe-expansion-ten/thumbnail/before-after-proof-panel/assets/before-after-proof-panel-1.webp",
  "aspect_ratio": "16:9",
  "target_dimensions": { "width": 1672, "height": 941, "unit": "px" },
  "reference_images": [],
  "headline": "FROM SEED TO SPROUT",
  "headline_line_count": 1,
  "prompt": "Create one completely original 1672x941 16:9 full-frame thumbnail render using the approved Before/After Proof Panel grammar and the exact Spec 5.1 preview-one visual brief. Render the exact complete headline FROM SEED TO SPROUT on one unbroken line inside the one reserved title-safe band. The headline must be native to the image, never a post-render overlay or title plate.",
  "negative_prompt": "No extra words, malformed or clipped text, fabricated measurement, false causality, unrelated subject, generic left-right title split, logo, trademark, creator likeness, UI, watermark, reference image, masking, compositing, or post-render typography."
}
```

Write the remaining 29 jobs by substituting the exact approved slug, asset index, headline text, required line count, defining grammar, preview brief, and exclusions from Spec sections 5.1–5.10. Every prompt must say `completely original`, `full-frame`, `exact complete headline`, `native to the image`, and `no post-render overlay or title plate`.

- [ ] **Step 2: Validate batch cardinality and semantic uniqueness**

Run a Node validation script that parses the batch and asserts:

```js
assert.equal(batch.jobs.length, 30)
assert.equal(new Set(batch.jobs.map(job => job.draft_job_id)).size, 30)
assert.equal(new Set(batch.jobs.map(job => job.target_source_asset)).size, 30)
for (const slug of approvedSlugs) {
  const jobs = batch.jobs.filter(job => job.draft_job_id.startsWith(`${slug}-`))
  assert.deepEqual(jobs.map(job => job.headline_line_count), [1, 2, 3])
  assert.ok(jobs.every(job => job.reference_images.length === 0))
}
```

Also reject creator/channel names, logos, trademarks, provider/model/route values, quote/cost values, and any authority flag set true.

- [ ] **Step 3: Hash the batch and write the quote-only handoff**

Record exact SHA-256 and bytes. The handoff requests receiver/controller, published provider/model or unavailable, count 30, exact unit credit cost, exact maximum credit/currency spend including overhead, text-only/no-reference capability, exact `1672x941` WebP capability, rights basis, and capacity. It explicitly prohibits queue, generation, job creation, worker selection, spend, repository change, stocking, upload, publication, deploy, tag, or push.

- [ ] **Step 4: Verify no execution occurred**

Assert batch authority is exactly:

```json
{
  "prompt_approved": false,
  "quote_approved": false,
  "job_submission_authorized": false,
  "generation_authorized": false
}
```

The repository remains clean because SDD working files are ignored and the handoff is external.

