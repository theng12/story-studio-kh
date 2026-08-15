# Content Pack Authoring Registry Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a strict, collision-safe Story Content Pack identity registry and make every Story pack-authoring skill consume its committed receipts.

**Architecture:** A single Git-tracked JSON registry holds current authored identities and future coordinator reservations. A dependency-free Node tool validates the registry, reconciles authored sources, and performs compare-and-swap batch reservations through atomic file replacement. Personal skills name the concrete authority and fail closed when it is unavailable.

**Tech Stack:** Node.js ESM, `node:test`, JSON, existing Story Content Pack source manifests, Markdown skills.

## Global Constraints

- Story may issue only Story content identities and family/SKU stocking proposals.
- GenStudio wire, commerce, price, discount, shelf, release, account, and grant identities are forbidden.
- No production key, archive, network request, generation, publication, purchase, install, or customer mutation.
- Current authored baseline is exactly 55 packs: 46 Free Starter plus nine Archival Ledger packs.
- Future paid-wave directions remain unreserved proposals until their own admission review.

---

### Task 1: Strict registry and authored-source reconciliation

**Files:**
- Create: `content-packs/authoring-registry.json`
- Create: `scripts/content-packs/authoring-registry.mjs`
- Create: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Modify: `package.json`

**Interfaces:**
- Consumes: every `content-packs/free-starters/**/pack.json` and `content-packs/paid/archival-ledger/**/pack.json`.
- Produces: `validateAuthoringRegistry({ registryPath, repositoryRoot })` and CLI `npm run content-pack:registry -- validate`.

- [ ] **Step 1: Write RED tests for the 55-pack baseline, uniqueness, strict fields, exact source reconciliation, and forbidden GenStudio fields.**
- [ ] **Step 2: Run the focused test and confirm it fails because the registry/tool do not exist.**
- [ ] **Step 3: Add the strict validator and initial canonical registry without dependencies or network access.**
- [ ] **Step 4: Run the focused test, Content Pack publisher tests, Electron typecheck, security check, and diff check.**
- [ ] **Step 5: Commit the bounded registry foundation.**

### Task 2: Compare-and-swap batch reservations and receipts

**Files:**
- Modify: `scripts/content-packs/authoring-registry.mjs`
- Modify: `scripts/content-packs/__tests__/authoring-registry.test.mjs`
- Modify: `scripts/content-packs/README.md`

**Interfaces:**
- Consumes: strict registry plus request JSON containing `expected_revision`, coordinator task/branch, proposal reference, and complete Story identity records.
- Produces: `reserveAuthoringBatch(...)` and CLI `npm run content-pack:registry -- reserve --request <path>` returning `{ revision, receipt_ref }`.

- [ ] **Step 1: Write RED tests for accepted atomic batch, stale revision, replay, every identity collision, dependency failure, unknown/GenStudio field rejection, and byte-for-byte unchanged failure paths.**
- [ ] **Step 2: Run the focused test and observe the missing reservation function failures.**
- [ ] **Step 3: Implement canonical request hashing, deterministic receipts, compare-and-swap revision checking, full pre-write validation, and same-directory atomic replacement.**
- [ ] **Step 4: Run focused tests twice, including concurrent calls proving at most one succeeds from the same revision.**
- [ ] **Step 5: Document coordinator-first branching/rebase behavior and commit.**

### Task 3: Bind the four Story authoring skills to the registry

**Files:**
- Modify: `/build/.codex/skills/story-studio-channel-kit-authoring/SKILL.md`
- Modify: `/build/.codex/skills/story-studio-niche-adoption/SKILL.md`
- Modify: `/build/.codex/skills/story-studio-thumbnail-adoption/SKILL.md`
- Modify: `/build/.codex/skills/story-studio-visual-style-adoption/SKILL.md`
- Create: `.superpowers/sdd/2026-08-15-content-pack-authoring-registry/skill-verification.md`

**Interfaces:**
- Consumes: concrete registry path, validate command, reservation command, revision, and receipt reference.
- Produces: fail-closed skill instructions that leaf agents can execute without inventing identities.

- [ ] **Step 1: Add registry-path/command assertions to a temporary verification harness and observe current skills fail them.**
- [ ] **Step 2: Update all four skills with the same authority boundary, coordinator/leaf split, receipt requirement, and `Registry task required` failure.**
- [ ] **Step 3: Verify the skills contain no GenStudio identity creation, pricing, publication, signing, or control-Mac generation instruction.**
- [ ] **Step 4: Run registry tests, Content Pack source suites, typecheck, lint, security, and diff checks; record evidence.**
- [ ] **Step 5: Request independent specification/security review and resolve all Critical/Important findings before closing.**

