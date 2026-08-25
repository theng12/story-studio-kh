# SDD ledger — plan: <owner-home>/Developer/story-studio-kh/.worktrees/content-store-launch-catalog-spec/docs/superpowers/plans/2026-08-14-paid-component-catalog.md

Base: 441d178a61170f152dfe2f255ffd6ef26dc070fa
Execution branch: codex/paid-component-catalog
Task 1: fix round 1/5 (1 addressed, 0 open — ordinary-source `minAppVersion` rejection and output preservation; commits badbf381..8e65f1dd)
Task 1: complete (commits 441d178a..8e65f1dd, review clean)
Task 2: minor resolved (404b2d5e adds filesystem discovery and a ninth-source regression; registry/source inventory must match)
Task 2: complete (commits 8e65f1dd..1578dcd8, review clean; deferred minor resolved by 404b2d5e)
Task 3: complete (commits 1578dcd8..82488395, review clean)
Task 4: complete (commit 23869979, review clean; explicit HMH migration is preview-token-bound, exact-version-pinned, and never automatic)
Task 6: complete (23 focused boundary/publisher tests; no later paid product, price, identity, publication, or commerce implementation)
Pre-Task5 aggregate gate: GO (C0/I0). Evidence: 404b2d5e publisher/source 32/32, migration/runtime 32/32, Electron typecheck, focused lint, production-security, and diff check; no Task5 commerce, pricing, UI, version, key, artifact, or external-state changes.

Owner clarification adopted 2026-08-15: Archival Ledger uses a 2,000-credit list price and an
operator-set 90% discount for every customer through an optional 2026-12-31 end date. GenStudio
deducts owned component value before applying that discount to the missing-component remainder;
Story renders signed quote facts and performs no eligibility or account-history check. Task 5
still waits for GenStudio's field-exact deployed reply; no wire names are invented here.
