# Story Studio developer migration

See [SKILLS.md](SKILLS.md) for the complete useful-skill inventory, engineering
plugins, custom folders to transfer, and new-computer installation guidance.

The five complete Story Content Pack authoring skill packages in `codex-skills/` are the canonical,
Git-tracked copies. They include each `SKILL.md`, `agents/openai.yaml`, and every package reference.

On a new computer, clone this repository and install the canonical packages into
`~/.codex/skills`:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --install
```

Check an existing installation byte-for-byte, including its file inventory:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --check
```

Run `--install` again after the canonical packages change. It replaces only these five named skill
directories and does not touch other personal skills.

The same canonical packages serve other agent harnesses. Pass `--skills-root` to install or check a
second skills directory, for example Claude Code's:

```bash
node scripts/developer/sync-story-authoring-skills.mjs --install --skills-root ~/.claude/skills
node scripts/developer/sync-story-authoring-skills.mjs --check --skills-root ~/.claude/skills
```

Harnesses that do not read `agents/openai.yaml` ignore it, so every root receives the same bytes and
the same inventory check.
