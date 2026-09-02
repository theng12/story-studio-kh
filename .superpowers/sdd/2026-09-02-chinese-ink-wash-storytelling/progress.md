# Chinese Ink-Wash Storytelling — authoring progress

## Completed

- Owner approved the standalone Visual Style contract and the 300-credit, no-discount stocking proposal.
- Registry revision 141 reserved the exact identity under receipt `authoring:544cc9ae4d80604d5a14b8683f3accb25c11d5386a63751947276d4ef4cc8353`.
- The expected identity passed `verify-receipt` before source authoring.
- The manifest and runtime Visual Style metadata are authored and independently reviewed.
- The authoring skill now explicitly accepts visually similar variants when their rendering contracts are visibly and distinctly differentiated; focused migration tests and installed-skill parity pass.
- The owner superseded the Studio Fleet quote path and explicitly selected GPT built-in image generation, which uses neither the owner's API key nor GenStudio credits. The stale quote request was moved to `<owner-home>/Developer/_handoff-trash/` before dispatch.
- GPT generated an original 1672x941 PNG with SHA-256 `6b190decc6365e95b2b0d6b29c7f5dc5f918aa981e177693c48d80dae5d14f10`; deterministic whole-image WebP encoding produced the declared 315978-byte asset with SHA-256 `b31459ec20c7e59c4907a04106b8c87b3f5e3cf8e39d91c4b2f94ed99a26e6e4`.
- Independent visual/originality certification passed, including card-size legibility, provenance, clean full-bleed edges, and absence of text, seals, signatures, logos, watermarks, UI, or copied composition.
- Source validation, two byte-identical Store-profile builds, archive validation, forbidden-mark scanning, and signed install/catalog/search/preview/prompt-persistence verification passed.
- Registry revision 142 promoted the exact record to `authored` under transition reference `lifecycle:964973fecffb6f8db1b1464c6652a8bdf421f3800ee47087e3a515bfe2d5fc32`.
- The original content change was integrated through Story Studio PR #14 at merge commit `eaa0dccfc6ba063ee1cf54eee880f73da786f7b1`.
- The canonical Store archive was rebuilt from that merged commit and verified at 317648 bytes with SHA-256 `4b5a4a07cfe4ec8d6b8e3260b6f209dc02b5657aac998db871d405705418d11a`.
- GenStudio stocking safety was integrated through GenStudio PR #3 at merge commit `89f9eaaf500d4b5f05ef0846c7bdfddb7215face`.
- The live standalone product was published at exactly 300 credits with no discount as product `cprod_b27fa76906f14b94987a0729e1a09f7d`, release `crel_e47f2d4ff58342a1a46d1c5507af36ba`.
- The content-release boundary correction was integrated through Story Studio PR #15 at merge commit `8e5b9b3760a67dd5c83f456cc49fb365d9d4fe02`: future compatible Content Packs do not require a Story Studio version bump, changelog entry, DMG, deployment, or restart.
- Canonical and installed Story authoring skills match: five packages and thirteen files.

## Closed and transferable

There is no remaining implementation, review, publication, commit, or push for this style. The source, preview asset, provenance, registry history, tests, and authoring/release rules are tracked in Git. A new machine should clone or fast-forward `main`, then run:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --install
node scripts/developer/sync-story-authoring-skills.mjs --check
npm run content-pack:registry -- validate
```

The exact final `.sspack` is a reproducible release artifact rather than a repository source file. On the original machine it is stored at:

`<owner-home>/Developer/_handoffs/artifacts/chinese-ink-wash-storytelling-2026-09-02-final/style-chinese-ink-wash-storytelling-1.0.0.sspack`

Its manifest is beside it. AirDrop that final artifact directory only if the receiving machine needs the exact already-published archive bytes; otherwise Git is sufficient because the archive can be rebuilt from merge commit `eaa0dccfc6ba063ee1cf54eee880f73da786f7b1` using the recorded build command and Store delivery profile. Do not put credentials, signing material, or machine-local secrets in Git or the handoff.
