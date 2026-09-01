# Story Studio developer migration

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
