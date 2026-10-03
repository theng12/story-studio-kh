/**
 * Dreamlands test, 2026-10-02: EP0001 and EP0002 both starred "Elara". The
 * script and idea prompts now carry "Do not reuse these main character names"
 * built from what recent episodes already stored — except on a Character
 * Continuity channel, where a recurring cast is the point.
 */
import { test, describe, before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'fs/promises'
import path from 'path'
import { useTempDataDir } from './_helpers.js'

const outline = (name: string, place: string) => Array.from({ length: 6 }, (_, i) => ({
  n: i + 1,
  title: `The ${place} ${i}`,
  synopsis: `${name} walks to the ${place.toLowerCase()} and the weaver rests. ${name} listens as the night falls.`,
  key_beats: [`${name} opens the door.`, `The air is calm; ${name} breathes slowly.`],
}))

let tmp: { dir: string; cleanup: () => Promise<void> }
let pm: typeof import('../services/project-manager.js')
let names: typeof import('../services/recent-character-names.js')

async function channelWithEpisodes(name: string, mode: 'independent-stills' | 'character-continuity', cast: Record<string, string>) {
  const project = await pm.createProject({ name, continuity_mode: mode } as any)
  const dir = pm.getProjectDir(project.slug)!
  const ideas = Object.keys(cast).map((code, i) => ({
    id: `idea-${i}`, title: `Story ${i}`, logline: '', themes: [], suggested_chapters: 6, suggested_length: '60',
    mood: '', status: 'accepted', episode_code: code, generated_at: '', accepted_at: '', batch_id: 'b', model_used: 'm',
  }))
  await fs.writeFile(path.join(dir, 'ideas.json'), JSON.stringify({ ideas, next_episode_number: 9, recycled_numbers: [] }))
  const { resolveEpisodePathsByCode } = await import('../services/utils.js')
  for (const [code, heroine] of Object.entries(cast)) {
    const paths = await resolveEpisodePathsByCode(project.slug, code)
    await fs.mkdir(paths.script_dir, { recursive: true })
    await fs.writeFile(path.join(paths.script_dir, `${code}_chunked-progress.json`), JSON.stringify({
      schema_version: 3, episode_id: code, mode: 'narrative', total_chapters: 6,
      outline: outline(heroine, 'Spire'), outline_completed_at: 'x', outline_approved_at: 'x', outline_edited_at: null,
      generation_params: null, chapters_done: [], params_hash: 'h', last_updated: 'x',
    }))
  }
  return project.slug
}

describe('recent main character names', () => {
  before(async () => {
    tmp = await useTempDataDir()
    pm = await import('../services/project-manager.js')
    names = await import('../services/recent-character-names.js')
  })
  after(async () => { await tmp.cleanup() })

  test('finds the main character, not places or common words', () => {
    const text = outline('Elara', 'Spire').map(e => `${e.title} ${e.synopsis} ${e.key_beats.join(' ')}`).join('\n')
    assert.deepEqual(names.extractMainCharacterNames(text), ['Elara'])
    assert.deepEqual(names.extractMainCharacterNames('The weaver rests. The night is calm.'), [])
  })

  test('the prompt line names them and asks for a fresh name', () => {
    const line = names.characterNamesAvoidance(['Elara', 'Mira'])
    assert.match(line, /Do not reuse these main character names/)
    assert.match(line, /Elara, Mira/)
    assert.equal(names.characterNamesAvoidance([]), '')
  })

  test('a channel avoids the names recent episodes used, but not its own current episode', async () => {
    const slug = await channelWithEpisodes('Names Channel', 'independent-stills', { EP0001: 'Elara', EP0002: 'Mira', EP0003: 'Odo' })
    const line = await names.recentCharacterNamesAvoidance(slug, 'EP0003')
    assert.match(line, /Mira, Elara/)
    assert.doesNotMatch(line, /Odo/)
  })

  test('a Character Continuity channel keeps its recurring cast (no avoidance line)', async () => {
    const slug = await channelWithEpisodes('Cast Channel', 'character-continuity', { EP0001: 'Elara', EP0002: 'Elara' })
    assert.equal(await names.recentCharacterNamesAvoidance(slug, 'EP0003'), '')
  })

  test('the script prompt rules and the idea prompts both carry the line', async () => {
    const slug = await channelWithEpisodes('Prompt Channel', 'independent-stills', { EP0001: 'Elara' })
    const { applyRecencyToFormat } = await import('../services/recency-tracker.js')
    const format = { script: { additionalRules: ['existing rule'] } } as any
    const out = await applyRecencyToFormat(format, slug, 'EP0002')
    assert.equal(out.script.additionalRules[0], 'existing rule')
    assert.match(out.script.additionalRules.join('\n'), /Do not reuse these main character names from this channel's recent episodes: Elara/)
    // Idea generation appends the same line (generators/idea-campaign.ts).
    const src = await fs.readFile(new URL('../generators/idea-campaign.ts', import.meta.url), 'utf-8')
    assert.equal((src.match(/withNamesAvoidance\(/g) ?? []).length, 3, 'definition + freeform + coverage prompts')
  })
})
