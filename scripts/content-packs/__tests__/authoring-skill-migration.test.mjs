import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

const migrationModule = new URL('../../developer/sync-story-authoring-skills.mjs', import.meta.url)
const repositoryRoot = new URL('../../..', import.meta.url)
const packageFiles = {
  'story-studio-content-pack-authoring': ['SKILL.md', 'agents/openai.yaml', 'references/component-handoff-contract.md'],
  'story-studio-channel-kit-authoring': ['SKILL.md', 'agents/openai.yaml'],
  'story-studio-niche-adoption': ['SKILL.md', 'agents/openai.yaml', 'references/two-layer-model.md'],
  'story-studio-thumbnail-adoption': ['SKILL.md', 'agents/openai.yaml', 'references/recipe-schema.md'],
  'story-studio-visual-style-adoption': ['SKILL.md', 'agents/openai.yaml'],
}

test('installs and checks complete canonical Story authoring skill packages', async (t) => {
  const { checkAuthoringSkills, installAuthoringSkills } = await import(migrationModule)
  const skillsRoot = await mkdtemp(join(tmpdir(), 'story-authoring-skills-'))
  t.after(() => rm(skillsRoot, { recursive: true, force: true }))

  assert.deepEqual(await installAuthoringSkills({ skillsRoot }), { packages: 5, files: 13 })
  assert.deepEqual(await checkAuthoringSkills({ skillsRoot }), { packages: 5, files: 13 })

  for (const [packageName, files] of Object.entries(packageFiles)) {
    for (const file of files) {
      const canonical = await readFile(new URL(`developer-migration/codex-skills/${packageName}/${file}`, repositoryRoot))
      assert.deepEqual(await readFile(join(skillsRoot, packageName, file)), canonical)
    }
  }

  const parent = await readFile(
    new URL('developer-migration/codex-skills/story-studio-content-pack-authoring/SKILL.md', repositoryRoot),
    'utf8',
  )
  assert.match(parent, /Every new product is one standalone Content Pack/i)
  assert.match(parent, /Do not create, extend, reserve, price, or stock a Channel Kit/i)
  assert.match(parent, /withdrawn.*terminal/i)
  assert.match(parent, /exact authored registry identities.*historical rebuild/i)
  assert.match(parent, /content-pack:registry -- verify-receipt --revision <revision> --receipt <receipt_ref> --expected-identity <path>/)

  const legacyRouter = await readFile(
    new URL('developer-migration/codex-skills/story-studio-channel-kit-authoring/SKILL.md', repositoryRoot),
    'utf8',
  )
  assert.match(legacyRouter, /legacy compatibility/i)
  assert.match(legacyRouter, /story-studio-content-pack-authoring/)

  for (const packageName of [
    'story-studio-niche-adoption',
    'story-studio-thumbnail-adoption',
    'story-studio-visual-style-adoption',
  ]) {
    const skill = await readFile(new URL(`developer-migration/codex-skills/${packageName}/SKILL.md`, repositoryRoot), 'utf8')
    assert.match(skill, /story-studio-content-pack-authoring/)
    assert.doesNotMatch(skill, /Channel Kit component lane/)
  }

  const visualStyleSkill = await readFile(
    new URL('developer-migration/codex-skills/story-studio-visual-style-adoption/SKILL.md', repositoryRoot),
    'utf8',
  )
  assert.match(visualStyleSkill, /visibly and distinctly differentiated/i)
  assert.match(visualStyleSkill, /visual similarity is acceptable/i)
  assert.match(visualStyleSkill, /reject only indistinguishable duplicates or mere renames/i)
  assert.match(visualStyleSkill, /similarity alone as a correction request/i)
  assert.doesNotMatch(visualStyleSkill, /otherwise propose a correction to the closest existing style/i)
  for (const preservedGate of ['originality', 'composition-copy', 'identity', 'safety', 'commercial']) {
    assert.match(visualStyleSkill, new RegExp(`preserve[^\\n]*${preservedGate}[^\\n]*gates?`, 'i'))
  }

  const changed = join(skillsRoot, 'story-studio-content-pack-authoring', 'SKILL.md')
  await writeFile(changed, `${await readFile(changed, 'utf8')}tampered\n`, 'utf8')
  await assert.rejects(checkAuthoringSkills({ skillsRoot }), /differs from canonical migration package/i)
})
