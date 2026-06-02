# refactors/

Plans for in-flight code restructures. Sits between a backlog item (too small) and a full audit (already done). Each file describes a refactor that's been scoped but isn't yet shipped — or is partway done.

## Contents

*No refactors currently in flight. Past completed ones live under [`../history/`](../history/) — see e.g. [`fal-model-audit-2026-04.md`](../history/fal-model-audit-2026-04.md).*

## Lifecycle

1. **Scope** — write the plan here when you decide to do the refactor.
2. **Execute** — update the file as you ship pieces; cross out completed sections.
3. **Retire** — when fully done, move the file to [`../history/`](../history/) with a date in the filename. It becomes a record of "we did this, here's what we found."

If a refactor is abandoned, move the file to [`../history/`](../history/) too with a note explaining the decision. Don't just delete it — the reasoning is reusable next time someone considers the same restructure.
