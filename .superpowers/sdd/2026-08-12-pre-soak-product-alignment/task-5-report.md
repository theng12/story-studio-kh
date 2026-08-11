# Task 5 report — retired format contracts

## Result

- Removed the retired format-ID remap tables and uses one Continuity Engine fallback.
- Restricted the `Format.visualSource` contract to `timestamp-driven`, `continuity-chain`, and `narrated-scenes`.
- Enforced the same live-value boundary in effective-format resolution and frontend flow normalization; unknown values become `continuity-chain` with `sentence` alignment.
- Preserved B-Roll/Image Pool route, asset, preset, and workflow code. The one type-check consequence reads its route value as runtime data, without changing its behavior.
- Moved the obsolete format/niche plan to `_trash/` with a superseded header. Incoming handoffs were not moved.

## TDD evidence

- RED: the focused backend suite failed because an unknown `format_overrides.visualSource` resolved to `narrated-scenes`, not `continuity-chain`; the frontend suite failed for the same fallback mismatch.
- GREEN: both focused suites pass after the allowlist change.

## Saved-project verification

Started a disposable local Story Studio server with an isolated temporary data directory. Created two local saved-project fixtures, requested `GET /api/projects/:slug/effective-format`, and SHA-256 compared each `project.json` before and after the request.

| Saved ID | Effective `id` | `visualSource` | `sceneAlignment` | Project file rewritten |
| --- | --- | --- | --- | --- |
| `stock-footage` | `continuity-chain` | `continuity-chain` | `sentence` | No |
| `scenes` | `continuity-chain` | `continuity-chain` | `sentence` | No |

No generation, dependency, live-provider, or paid call was made.

## Verification

- `STORY_STUDIO_DISABLE_LISTEN=1 npx tsx --test --test-concurrency=1 --test-force-exit server/__tests__/format-loader.test.ts server/__tests__/pipeline-step-skip.test.ts` — 50 passed.
- `npx tsx --import ./__tests__/setup.ts --test __tests__/useProjectFlow.test.ts` — 11 passed.
- `npx tsc -p electron/tsconfig.json --noEmit` — passed.
- `npm --prefix frontend run typecheck` — passed.
- `git diff --check` — passed.

## Follow-up: format-contract documentation

- Replaced stale format-contract prose and frontend comments with the live `timestamp-driven` / `continuity-chain` / `narrated-scenes` union.
- Documented B-Roll and Image Pool as preserved independent route, asset, preset, and assembly workflows rather than `Format.visualSource` values.
- Scoped grep found no retired `visualSource` assignments in the corrected docs/comments; `npm --prefix frontend run typecheck` and `git diff --check` passed.

## Follow-up: format-contract consistency

- Replaced the obsolete multi-format quick-reference table and retired niche pairings with the single active Continuity Engine contract.
- Replaced the obsolete “add a format” checklist with current Formula/niche guidance and corrected `DEFAULT_FORMAT_ID` to `continuity-chain`.
- Broader scoped grep confirmed retired format identifiers are absent from current-contract prose while active B-Roll and Image Pool workflow nouns remain documented.
