# SDD ledger — plan: docs/superpowers/plans/2026-08-25-topic-pack-1000-repair.md

- Branch: `codex/content-expansion-portfolio`
- Start commit: `ddf8a42b`
- Controller: `/root`
- Owner authorization: all 16 canonical Topic Pack repairs; local implementation and commits; one complete GenStudio handoff only after verification
- External boundary: no push, deploy, publish, product mutation, pricing mutation, Kit mutation, or partial handoff

## Preflight consistency scan

| Task | Owns | Consumes | Proves completion | Status |
| --- | --- | --- | --- | --- |
| 1 | registry reservation + shared TS capacity harness | revision 33 mapping, plan/spec | one 16-record receipt; 16 verified identities; TS harness green | complete |
| 2 | Natural World Animals 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | complete |
| 3 | Human Behavior Social Dynamics 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | complete |
| 4 | Night Journeys 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | complete |
| 5 | Habits Momentum 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 6 | Everyday Calm 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 7 | Ancient Humans Survival 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 8 | History Wars/Treaties 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 9 | Historical Occupations 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 10 | Deep Time Earth Systems 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 11 | Economics Businesses 1.0.1 | Task 1 receipt/harness | named capacity + golden tests green; semantic review | pending |
| 12 | Audience Question Seeder 1.0.1 | Task 1 receipt/harness | named capacity + reusable test green; report + matrix | pending |
| 13 | Archival Empires 1.0.1 + successor inventory refactor | Task 1 receipt/harness | named capacity + paid inventory green; report + matrix | pending |
| 14 | Archival Infrastructure 1.0.1 + inventory row | Task 13 inventory interface | named capacity + paid inventory green; report + matrix | pending |
| 15 | Archival Money 1.0.1 + inventory row | Task 13 inventory interface | named capacity + paid inventory green; report + matrix | pending |
| 16 | Archival States 1.0.1 + inventory row | Task 13 inventory interface | named capacity + paid inventory green; report + matrix | pending |
| 17 | Archival Wars 1.0.1 + inventory row | Task 13 inventory interface | named capacity + paid inventory green; report + matrix | pending |
| 18 | integrated review, Free Starter inventory, lifecycle transitions | all 16 green rows and one receipt | count 66/lineages 46; all 16 authored; integrated gates green | pending |
| 19 | paired candidates, durable evidence, staging, handoff | all 16 authored records and reviews | paired equality; 16 archives; retained evidence; broad gates; one handoff | pending |

## Shared-interface order

1. Task 1 alone establishes `electron/server/__tests__/topic-pack-1000-successors.test.ts`, the one receipt, and the 16 expected-identity files.
2. Tasks 2–17 append exactly one reviewed row and one successor; implementation agents are serialized because they share the TS test.
3. Tasks 13–17 additionally serialize writes to `content-packs/paid/archival-ledger/registry.mjs` and its inventory test, retaining the eight-source 1.0.0 baseline separately.
4. Task 18 alone performs lifecycle transitions and the final Free Starter inventory update.
5. Task 19 alone extends the staging helper and creates external candidate/artifact/handoff files after every source gate passes.

## Watchdog record

For each dispatch record agent, start commit, expected report/commit, proof command, last concrete progress, review result, and process cleanup below. Silence is not treated as a stall without checking worktree changes, messages, processes, and advancing logs.

### Task 1 implementer

- Agent: `/root/topic_pack_task_1`
- Start commit: `ddf8a42b`
- First deliverable: shared TS harness plus recorded failing identity test; no registry mutation and no commit yet
- First proof: `npx tsx --test electron/server/__tests__/topic-pack-1000-successors.test.ts` fails only because the 16 reserved identities do not exist
- First phase: complete; root reproduced the exact 16-identity RED
- Coordinator checkpoint: complete at registry revision `34`; receipt `authoring:c9ab5bbdb15dfd8dc1d63e83478d0d9ccded2309453eb0a516392cc1c37c5eb3`; 16 expected identity files independently verified; registry validates at 108 records
- Initial green commit: `af5ad8e1`; root independently reproduced focused green plus 35/35 registry tests
- Independent review: findings — planner tuple/material/exhaustion proof, uniform lifecycle phase, and entitlement binding must be strengthened
- Fix commits: `aa6b8de1`, `4c8df44e`; planner/identity/lifecycle findings closed
- Independent final review: PASS (`task-1-review.md`)
- Final Task 1 HEAD: `4c8df44e`; focused test, 35/35 registry tests, registry validate, Electron typecheck, and diff check pass; no task child process remains

### Task 2 implementer

- Agent: `/root/topic_pack_task_2`
- Start commit: `4c8df44e`
- Deliverable: Natural World Animals same-identity `1.0.1`, one reviewed-row addition, hash-bound semantic report
- Proof: exact receipt preflight; named RED before source; named GREEN after source; signed-source golden test; clean commit/report
- Progress: 50/50 subjects and 1,000 tuples authored; mechanical uniqueness/source checks reached planner split assertion
- Debugging checkpoint: new harness incorrectly treated the planner's intentional retry pool as an exact count. Existing production callers/tests slice the pool. Production planner remains unchanged; Task 2 resumes with only `slice(0, 500)` at each 500-reservation boundary.
- Initial implementation commit: `28a8d6a9`; two repair commits `c25b71e0`, `497a583c`; first independent audits rejected generic scope/evidence templates.
- Rescue commits: `437a9d50`, then exhaustive-v2 repair `0a59e9fe`; exact v2 inventory covered 251 coordinates / 274 failed dimensions, preserved 1,726 passing dimensions, and included 56 conservative-borderline rows.
- Final source: SHA-256 `a24092d8180a69ab147fdc12b4005efbf7bf1e12ecb02b492b8bfcd561758f15`, 670,346 bytes; 50 subjects × 20 coherent tuples; semantic review 50 rows / 1,000 verdicts, ignored and untracked for Task 19 retention.
- Independent final review: PASS (`task-2-review.md`) after evidence-backed rejection of two breadth-only objections that were factually compatible with the design criterion.
- Final Task 2 HEAD: `0a59e9fe`; capacity 1/1, signed-source golden 8/8, exact receipt revision 34, registry validation 108 records, Electron typecheck, and diff checks pass; tracked worktree clean.

### Task 3 implementer

- Start commit: `0a59e9fe`
- Deliverable: Human Behavior Social Dynamics same-identity `1.0.1`, one reviewed-row addition, hash-bound semantic report
- Semantic acceptance: apply the two-question rubric to all 1,000 tuples before commit: scope materially fits the actual event; evidence method measures an indispensable variable/comparison. Broad-but-correct context is acceptable; contradictions and generic ordinal substitution are not.
- Proof: exact receipt preflight; named RED before source; named GREEN after source; signed-source golden test; 1,000-tuple semantic audit; clean commit/report
- Agent: `/root/topic_pack_task_3`
- Commit: `2915b319`; source SHA-256 `90e40ed860c49008cd88d8669b15ec15623a715b5d12727304ffeffd2b3d20c7`, 525,933 bytes.
- Semantic evidence: 50 subject rows, 1,000 scope verdicts, 1,000 evidence verdicts, and 1,000 tuple verdicts; ignored/untracked through Task 19.
- Independent review: PASS (`task-3-review.md`) after exhaustive 50×20 audit.
- Gates: shared capacity 3/3, signed-source golden 8/8, exact receipt, registry validation, Electron typecheck, and diff checks pass; tracked worktree clean.

### Task 4 implementer

- Start commit: `2915b319`
- Deliverable: Night Journeys same-identity `1.0.1`, one reviewed-row addition, hash-bound semantic report
- Proof: exact receipt preflight; named RED before source; named GREEN after source; signed-source golden; exhaustive two-question semantic audit; clean commit/report
- Initial commit: `4c6cbf29`; repair series culminated in accepted commit `2b3c31b3` after corpus-wide evidence and broad-synonym audits.
- Final source: SHA-256 `d865ab3b355044725fac5f0eaa390d3aadc6c09e5da245e4cd9a25448405b9ba`, 1,004,686 bytes; 50 × 20 / +970; 1,000 unique mechanisms, evidence lenses, and complete pairs.
- Semantic evidence: 50 rows / 1,000 scope, evidence, and tuple verdicts; review SHA-256 `38cdde94b5391f27f5f07fd49144ba42ca906b2fbde72906764592bd39f8c42f`.
- Independent final review: PASS (`task-4-review.md`) after full 499,500-pair broad-normalization audit, exact-object review, evidence/material/grammar checks, and sleep-safety audit.
- Gates: named 1/1, shared capacity 4/4, golden 8/8, exact receipt, registry validation, Electron typecheck, size, predecessor, and diff/process checks pass; tracked worktree clean.

### Task 5 implementer

- Start commit: `2b3c31b3`
- Deliverable: Habits Momentum same-identity `1.0.1`, one reviewed-row addition, hash-bound semantic report
- Proof: exact receipt preflight; named RED before source; named GREEN after source; signed-source golden; exhaustive scope/evidence and semantic-pair audit; clean commit/report
