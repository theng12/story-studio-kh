# Story Content Store Phase 1 — SDD Progress

## Source of truth

- Approved design: `docs/superpowers/specs/2026-08-13-content-pack-store-design.md`
- Implementation plan: `docs/superpowers/plans/2026-08-14-story-content-store-phase1.md`
- GenStudio exact contract: `/build/Developer/genstudiokh/docs/product/api-contract-changes-1.4.0.md`
- GenStudio live release: 1.4.0, charging contract 0.21.0
- Starting Story Studio release: v1.0.834 at `94c6578cff6cb8bb19a0fea0b95173df3e87291d`
- Branch/worktree: `codex/content-pack-platform` at `/build/Developer/story-studio-kh/.worktrees/content-pack-platform`

## Execution rules

- Use a fresh implementation agent per task and a separate fresh reviewer after its focused GREEN checks.
- Every Critical/Important review correction gets a focused RED-to-GREEN regression before acceptance.
- Record exact commands and counts; never replace evidence with “tests pass.”
- Do not push, deploy, publish a product, issue a production quote, or make a live purchase.
- Phase 1 ends at commerce ownership plus an unverified receipt cache. It does not download, install, restore, or verify a purchased pack.

## Tasks

- [ ] Task 1 — exact GenStudio 0.21 client, canonical payload preservation, generic app-version resolver, and safe `content:read` scope probe
- [ ] Task 1 independent contract/security review — GO with zero Critical/Important findings
- [ ] Task 2 — atomic commerce state, stable idempotency, interrupted-submit recovery, exact refusal cache, and unverified receipt bytes
- [ ] Task 2 independent concurrency/security review — GO with zero Critical/Important findings
- [ ] Task 3 — active-account orchestration and local read/quote/purchase routes with exact status semantics and no installer/Job Queue dependency
- [ ] Task 3 independent financial/security review — GO with zero Critical/Important findings
- [ ] Task 4 — Content Store UI, explicit confirmation, navigation, Settings scope UX, Impeccable pass, and desktop/narrow visual QA
- [ ] Task 4 independent UX/contract review — GO with zero Critical/Important findings
- [ ] Task 5 — whole-range review, v1.0.835 release, full verification/audits, unsigned package, and packaged QA

## Contract facts to re-check at every gate

- Account balance used for purchases: `content_spendable_credits`.
- Quote price: `quoted_credits` is a ceiling.
- Purchase truth: `credits_charged`, `balance_after`, and `replayed`.
- Purchase key: caller `Idempotency-Key`, 8–128 characters, same key for exact-request retries.
- Refusals: 402 `insufficient_credits`; 404 `product_unavailable|release_unavailable`; 409 `already_owned|quote_rejected`; 503 `signing_unavailable`.
- Ownership root: `account_id` / `content_account_id`, never API key.
- Empty `{ "products": [] }`: healthy and intentional.
- Receipt: cached, not verified in Phase 1.
- Downloads/install/restore/public key/portal: absent by contract.

## Task evidence

Add one section per task with:

- implementation commit(s);
- initial RED command and failure;
- focused GREEN command and count;
- typecheck/lint/build result;
- independent reviewer verdict and correction commits;
- any deliberate deferral that remains inside the approved Phase 1 boundary.

