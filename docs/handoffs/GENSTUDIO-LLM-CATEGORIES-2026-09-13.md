# GenStudio LLM category update — coordination handoff

Status at handoff, 2026-09-14: Story Studio 1.4.161 implementation, independent review, all local test lanes, and production build are verified. GenStudio 1.24.88 is independently reviewed and its full backend gate is running. Check the linked pull requests for subsequent integration status; this handoff does not assert API activation.

The owner asked GenStudio's session to keep the Story Studio session informed so it can prepare for model updates. This file is the cross-session handoff. Opening it in the Story Studio session does not imply that session has read or acknowledged it.

Coordinated pull requests: [GenStudio #149](https://github.com/theng12/genstudiokh/pull/149) and [Story Studio #120](https://github.com/theng12/story-studio-kh/pull/120). Both changes are independently reviewed. Story Studio is ready for integration; GenStudio awaits its full backend gate.

## Incoming contract

GenStudio's language model `cost_tier` will use these values, in this picker order:

| Value | Label | Classification |
| --- | --- | --- |
| `promotional` | Promotional | Existing relaxed/free provider routes (`queue_class: relaxed`), before numeric bands |
| `value` | Value | Published customer input + output credits per million tokens, at most 3,000 |
| `economy` | Economy | Combined rate above 3,000 and at most 10,000 |
| `premium` | Premium | Combined rate above 10,000 |

GenStudio computes the category. Story Studio must consume the published field and must not duplicate the price calculation. Other modalities retain `economy`, `balanced`, `premium`. Queue classes, prices, generation requests, product IDs, discounts, and billing remain unchanged. Promotional describes the picker category; it is not a new queue protocol or a promise of zero customer charges.

## Work already owned by this GenStudio session

- GenStudio worktree: `<owner-home>/Developer/genstudiokh/.worktrees/codex-llm-categories`, branch `codex/llm-categories`, base `54a4d4f3`, target version 1.24.88. Backend classification, schema/client types, owner control labels, and contract documentation are implemented.
- Story Studio worktree: `<owner-home>/Developer/story-studio-kh/.worktrees/llm-categories`, branch `codex/llm-categories`, base `b2795169`, target version 1.4.161. The delegated Story agent implemented the client boundary, LLM picker profile, and focused regressions in commit `4a6b52d3`. Catalog diagnostic labels and release notes are also updated in this worktree. This session owns review, verification, integration, and required local artifact work.
- Please avoid parallel edits to those same files. Preparation can use this contract now; release readiness and activation will be reported after verification.

Expected picker behavior: Promotional first when opening without a selected model; an existing selection opens its category; search spans all categories; keyboard order follows visible categories. An older/incompatible catalog stays visible as a flat list instead of silently losing models.

## Separate Token Harbor status

The provider connection is merged in GenStudio 1.24.87. The requested DeepSeek V4.1 Flash, DeepSeek V4 Flash, and MiMo V2.5 products with `[Tokenharbor]` suffix are not published yet. Authenticated provider metadata/limits, a saved key, and customer pricing still need resolution. Do not add guessed local products or announce those models as available.

## Verification so far

GenStudio: 72 focused backend tests passed; 337 customer and 706 admin web tests passed; typechecks, Ruff, and production builds passed. Its full backend gate is running after recovery from a host process-limit incident.

Story Studio: all 5,223 backend tests passed across 472 files, with the configured project root byte-identical. All 1,808 frontend tests passed across 197 files; all 36 release tests passed; Content Pack checks passed 366 tests with two skipped across all 38 files. Lint reported zero errors and existing warnings; Electron/Nuxt typechecks and the production build passed. Actual picker components passed desktop and 390px visual, keyboard, search, and focus checks. Independent review closed the original findings and verified the final mounted keyboard regression for both LLM and image categories.

Earlier failed/interrupted runs remain separate diagnostic receipts: host process exhaustion caused the initial backend failures, and the recovered frontend run exposed an obsolete three-category test fixture that was corrected before the final full frontend pass. No runtime fix or weakening of the release gates was required. The API was recovered on already-merged 1.24.87; this category contract requires 1.24.88 activation after integration.

## Follow-up

GenStudio's source contract is `docs/product/api-contract-changes-1.24.88.md`. This session will queue final integration, local artifact, and API activation evidence to Story Studio when available. The linked pull requests remain the source of truth for merge status.
