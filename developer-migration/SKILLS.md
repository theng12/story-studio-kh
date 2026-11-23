# Skills to restore on the new computer

Inventory and recommendations for Story Studio KH, 2026-09-20.

**[MEASURED]** Names below were present in this session's installed skill catalog
and, for custom/third-party bundles, inspected on disk. Recommendations about
which to install first are the orchestrator's judgment. Installed versions are
a reproducibility record, not a claim that they are the newest releases.

## Install first for this repository

| Skill or bundle | Use | Restore |
|---|---|---|
| **Ponytail** | Smallest secure changes, reuse, removal of proven dead code, review of unnecessary complexity. | Reinstall the Ponytail plugin. Measured local version 4.10.0; manifest source [DietrichGebert/ponytail](https://github.com/DietrichGebert/ponytail), MIT. |
| **Superpowers** | Debugging, focused TDD, implementation/review, worktree discipline, verification. Use focused skills without duplicating this repo's accepted plan. | Reinstall the Superpowers plugin. Measured local version 6.4.1; manifest source [obra/superpowers](https://github.com/obra/superpowers), MIT. |
| **Graphify** | Existing code graph, caller/impact and reachability investigation. Confirm deletion against real callers. | Transfer the complete custom `graphify/` directory, or reinstall from its verified source when identified. Local marker 0.9.63; no authoritative install URL was established here. The graph itself is ignored/generated. |
| **Impeccable** | Frontend design, UX/accessibility, rendered layout review and polish. | Transfer complete `impeccable/`; measured metadata version 4.0.4. No authoritative upstream install URL was established here. |
| **planning-with-files** | Durable plans, findings, progress across sessions. Reuse the existing handoff rather than creating competing plans. | Transfer complete `planning-with-files/`; measured metadata version 3.17.2. Hooks/runtime helpers need their own supported installation; copying a skill alone is not proof hooks are registered. |
| **OpenAI Docs** | Current Codex/OpenAI setup and product guidance. | Available here as a system skill. Check the new Codex installation's catalog; use official docs if absent. |
| **skill-installer / skill-creator / plugin-creator** | Install or maintain personal skills/plugins. | Available here as system skills; check the new installation before adding duplicates. |

**[MEASURED]** The local custom source directories on the old Mac are:

```text
~/.codex/skills/graphify/
~/.codex/skills/impeccable/
~/.codex/skills/planning-with-files/
```

Copy whole directories, including references, templates, scripts, assets, and
licenses, rather than only `SKILL.md`. Recreate any external developer tooling
they require and verify availability; these are development aids, never app
dependencies. Do not copy the whole `~/.codex` directory, credentials, sessions,
or plugin caches as a substitute for installation.

## Story Content Pack authoring — already backed up in this Git repository

**[MEASURED]** All five canonical packages and their 13 files are tracked in
`developer-migration/codex-skills/`. The old installed copies matched byte for
byte when the existing check was run, exit 0.

| Exact skill name | Purpose |
|---|---|
| `story-studio-content-pack-authoring` | Standalone, independently purchasable `.sspack` products. Start here for new content products. |
| `story-studio-niche-adoption` | Channel niche, Series Formula, and Topic Pack authoring. |
| `story-studio-thumbnail-adoption` | Standalone Thumbnail Recipe authoring and reference adoption. |
| `story-studio-visual-style-adoption` | Standalone Visual Style pack, original preview, registry identity and metadata. |
| `story-studio-channel-kit-authoring` | Legacy history/validation and routing to standalone packs. It does **not** authorize creating new Channel Kits. |

On a new computer, from the repository root:

```sh
node scripts/developer/sync-story-authoring-skills.mjs --install --skills-root "$HOME/.agents/skills"
node scripts/developer/sync-story-authoring-skills.mjs --check --skills-root "$HOME/.agents/skills"
```

Expected output: `5 packages, 13 files`. The installer replaces only those five
named destination directories. Back up changes to those names first if the new
computer already has modified copies. The script's default remains
`~/.codex/skills`; `--skills-root` is an existing supported option. Avoid keeping
multiple discovered copies with the same skill name.

**[MEASURED — official documentation]** Codex documents `~/.agents/skills` for
user-level local skills and `.agents/skills` for repository-local skills. It
supports full skill directories and symlinked directories; duplicate names are
not merged. `$skill-installer` can install curated skills or skills from a
specified repository. If a skill is absent after installation, restart Codex.
[Official skill installation and discovery guide](https://learn.chatgpt.com/docs/build-skills).

## Other custom skills worth preserving

**[MEASURED]** These are installed outside this Git repository. Cloning Story
Studio does not restore them. Preserve the listed full directories privately;
their upstream restore commands were not established in the inspected input.

| Skill | When useful | Old-computer directory |
|---|---|---|
| `genstudio-add-model` | Researching/adding/pricing/routing a model in GenStudio; companion repository work. | `~/.codex/skills/genstudio-add-model/` |
| `genstudio-route-onboarding` | GenStudio operation-specific routes, provider/aggregator comparison and owner-approved route workflow. | `~/.codex/skills/genstudio-route-onboarding/` |
| `sleep-story-script` | Sleep-story script, image-prompt sheet and YouTube metadata production. | `~/.codex/plugins/cache/claude-cowork/anthropic-skills/1.0.0/skills/sleep-story-script/` |
| `pinokio` | Discovering and launching local Pinokio tools. | `~/.agents/skills/pinokio/` |
| `gepeto` | Creating Pinokio launchers. | `~/.agents/skills/gepeto/` |

**[MEASURED]** The sleep-story entry lives inside a cached bundle whose manifest
records `creatorType: "user"` for it. Do not assume a generic Anthropic/plugin
reinstall will recover that custom skill. Gepeto/Pinokio metadata points to
local `~/pinokio/skills/...` sources; the skill folders alone do not install
Pinokio or its applications. The two GenStudio skills do not clone or configure
the GenStudio/gateway repository.

## Exact engineering bundle skill names

**[MEASURED]** Superpowers 6.4.1 contains these 15 skills:

- `using-superpowers`
- `brainstorming`
- `writing-plans`
- `executing-plans`
- `subagent-driven-development`
- `dispatching-parallel-agents`
- `systematic-debugging`
- `test-driven-development`
- `requesting-code-review`
- `receiving-code-review`
- `verification-before-completion`
- `using-git-worktrees`
- `finishing-a-development-branch`
- `writing-skills`
- `diagnosing-superpowers`

**[MEASURED]** Ponytail 4.10.0 contains:

- `ponytail` — minimal implementation discipline.
- `ponytail-review` — inspect a diff for unnecessary complexity.
- `ponytail-audit` — inspect a repository for unnecessary complexity.
- `ponytail-debt` — collect deliberate `ponytail:` limitations.
- `ponytail-gain` — benchmark scoreboard.
- `ponytail-help` — command reference.

## Optional content, document, and analysis tooling

Install these when the work needs them; they are not prerequisites for building
Story Studio.

| Installed skill/plugin family | Useful work |
|---|---|
| `imagegen` | Original visual-style previews, thumbnails, illustrations and image edits. Generation may have separate cost/authorization requirements. |
| `visualize:visualize` | Interactive explanations, diagrams and comparisons. |
| `documents:documents` | Word documents with render-and-inspect validation. |
| `pdf:pdf` | PDF extraction, creation, rendering and validation. |
| `presentations:Presentations` | PowerPoint/Google Slides-targeted decks. |
| `spreadsheets:Spreadsheets` | Spreadsheet files, formulas, charts and validation. |
| `spreadsheets:excel-live-control` | A connected live Excel session; not needed for file-only work. |
| `data-analytics` | Source-backed analysis, KPI reports, data quality, dashboards and charts. |
| `template-creator:template-creator` | Reusable personal artifact templates. |
| `plugin-management:plugin-management` | Discovering/connecting/managing plugins. |
| `anthropic-skills` document skills | Alternate `docx`, `pdf`, `pptx`, `xlsx` workflows; avoid installing duplicates merely for coverage. |
| `anthropic-skills:skill-creator`, `consolidate-memory`, `setup-cowork` | Skill evaluation, memory maintenance, and Cowork setup when that environment is used. |

**[MEASURED]** Data Analytics exposes: `index`, `analyze-data-quality`,
`build-dashboard`, `build-report`, `create-data-context`, `design-kpis`,
`gather-business-context`, `jupyter-notebooks`, `kpi-reporting`, `market-sizing`,
`metric-diagnostics`, `product-business-analysis`, `publish-artifact-to-sites`,
`validate-data`, and `visualize-data`. These are optional analytical workflows,
not part of the app's runtime or release gate.

**[MEASURED — official documentation]** Plugins can bundle skills, MCP tools,
and hooks. Reinstall the plugin itself when those integrations matter; copying
only its skill text does not restore its tools or executable hooks.
[Official plugin architecture](https://developers.openai.com/plugins/concepts/plugins).

For rendered app/browser verification, restore the **Computer Use** plugin
available on the new machine. For GitHub work, the authenticated `gh` CLI used
in this recovery is sufficient; the GitHub connector was listed as available
but not installed. Installing Slack/Gmail/Drive and unrelated connectors is not
required for this repository. Reconnect only accounts actually needed.

## Related developer tools, separate from skills

**[MEASURED]** Context7 and Serena MCP tools are available in this session's
tool inventory. The owner's workflow uses Context7 for current third-party
documentation when local evidence is insufficient, and Serena for semantic
references/diagnostics in large cross-file work. Configure these integrations
separately on the new computer; installing a similarly named skill is not proof
that the MCP tools work. Keep Serena's dashboard/onboarding/memory features off
per the recorded workflow.

**[MEASURED — recorded workflow]** Spec Kit is an optional aid for substantial,
ambiguous multi-stage features. Its installed executable/version was not
established by this inventory. Do not initialize it for this already-planned
recovery. Graphify's executable and generated graph are likewise separate from
its skill text. None of these belongs in application dependencies or packaging.

## Before retiring the old computer

- Confirm the five Story packages are present in the cloned Git branch.
- Transfer every custom directory above that you want to keep. A skill-name
  list is not a backup of a locally customized skill.
- Reinstall the selected plugin bundles and verify their skill names/tools
  appear in the new Codex session.
- Check referenced developer executables separately (for example Graphify or
  Pinokio), and correct machine-specific paths.
- Keep API keys, login tokens, Keychain material, and developer credentials out
  of skill folders and Git. Use the private OS/credential migration separately.
