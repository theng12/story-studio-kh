# Character Sheet timing cleanup and LLM coordination

Status: implementation, focused checks, and independent review complete; release integration pending. Worktree `.worktrees/character-sheet-timing-cleanup`, branch `codex/character-sheet-timing-cleanup`, base `b2795169` (1.4.160). Planned version 1.4.162 follows the other session's reserved 1.4.161; recheck main before integration.

## Owner request

Remove the remaining Visual timing & motion card from Character Sheet because Scene Plan owns it. Check the GenStudio handoff for a fourth language-model category and renamed groupings.

## Implemented

- Removed the static timing card, draft summary, link and unused local timing styles. The empty-state description now names anchors and channel look only.
- Preserved the explicitly authorized Character Sheet preset pacing contract. Its conditional notification sits immediately beneath the preset toolbar and correctly calls applied values a visual-setup draft rather than claiming the saved Scene Plan changed.
- Updated four existing frontend test files that previously required the retired card. Scene Plan controls and saved/generation data are unchanged.
- Version and changelog prepared as 1.4.162. When rebasing after 1.4.161, keep both changelog entries and advance the root package/lock version without dropping the other release.

## Verification

- Focused four-file frontend run: exit 0, 69 tests passed, 0 failures. The first attempt lacked generated Nuxt path aliases; `nuxi prepare` resolved the environment and the complete focused run passed.
- `npm run typecheck`: exit 0 (Electron and Nuxt).
- `npm run check:changelog`: exit 0.
- `git diff --check`: clean.
- Impeccable detector on the changed page: no findings.
- Isolated Electron render of the actual moved notice template: 900px and 390px, initial/applied/legacy states, no overflow, initial state empty. Narrow screenshot visually inspected. This checks the moved notice, not a full live-project walkthrough.
- Independent reviewer approved after unused `.cs-range-row` and `.input-inline` removal.
- No full release suite or DMG claimed for this branch. Evidence is under `logs/character-sheet-timing-cleanup/`; focused log copied there.

## LLM handoff acknowledged; avoid duplicate ownership

The other GenStudio session already owns Story PR #120 and `.worktrees/llm-categories` plus GenStudio PR #149. Its coordination source is `docs/handoffs/GENSTUDIO-LLM-CATEGORIES-2026-09-13.md` in that Story worktree; GenStudio source contract is `docs/product/api-contract-changes-1.24.88.md` in its category worktree.

The language picker groups are **Promotional, Value, Economy, Premium**, from GenStudio's published `cost_tier`. Story must not recalculate categories. Other modalities retain their existing groups. Promotional does not promise free customer usage. Existing selections, cross-group search, keyboard order, and legacy flat catalogs are covered by that branch. Its owner retains verification, merge and artifact ownership. At inspection PR #120 remained draft/unmerged; do not announce 1.4.161 as installed or released.

An inspector noted the generic `/v1/models` capability boundary drops `cost_tier`, but the actual language picker and diagnostic groups use the separately normalized `/v1/chat/models` list. No demonstrated category UI blocker or duplicate change is added here.

## Remaining release work

After the owner of PR #120 completes or explicitly hands over its release: rebase this branch onto updated main, resolve only release metadata and the existing modelMenus test edits, run required release verification once without competing suites, independently inspect conflict resolution, then merge under standing authorization and build/verify the unsigned DMG from canonical main. Do not install or restart the running customer app or alter jobs.
