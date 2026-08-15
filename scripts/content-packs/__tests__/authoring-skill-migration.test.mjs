import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const migrationModule = new URL('../../developer/sync-story-authoring-skills.mjs', import.meta.url)
const repositoryRoot = new URL('../../..', import.meta.url)
const packageFiles = {
  'story-studio-channel-kit-authoring': ['SKILL.md', 'agents/openai.yaml', 'references/component-handoff-contract.md'],
  'story-studio-niche-adoption': ['SKILL.md', 'agents/openai.yaml', 'references/two-layer-model.md'],
  'story-studio-thumbnail-adoption': ['SKILL.md', 'agents/openai.yaml', 'references/recipe-schema.md'],
  'story-studio-visual-style-adoption': ['SKILL.md', 'agents/openai.yaml'],
}

test('installs and checks complete canonical Story authoring skill packages', async (t) => {
  const { checkAuthoringSkills, installAuthoringSkills } = await import(migrationModule)
  const skillsRoot = await mkdtemp(join(tmpdir(), 'story-authoring-skills-'))
  t.after(() => rm(skillsRoot, { recursive: true, force: true }))

  assert.deepEqual(await installAuthoringSkills({ skillsRoot }), { packages: 4, files: 11 })
  assert.deepEqual(await checkAuthoringSkills({ skillsRoot }), { packages: 4, files: 11 })

  for (const [packageName, files] of Object.entries(packageFiles)) {
    for (const file of files) {
      const canonical = await readFile(new URL(`developer-migration/codex-skills/${packageName}/${file}`, repositoryRoot))
      assert.deepEqual(await readFile(join(skillsRoot, packageName, file)), canonical)
    }
    const skill = await readFile(new URL(`developer-migration/codex-skills/${packageName}/SKILL.md`, repositoryRoot), 'utf8')
    assert.match(skill, /content-pack:registry -- verify-receipt --revision <revision> --receipt <receipt_ref> --expected-identity <path>/)
  }

  const changed = join(skillsRoot, 'story-studio-channel-kit-authoring', 'SKILL.md')
  await writeFile(changed, `${await readFile(changed, 'utf8')}tampered\n`, 'utf8')
  await assert.rejects(checkAuthoringSkills({ skillsRoot }), /differs from canonical migration package/i)
})
