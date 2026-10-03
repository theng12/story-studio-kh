/**
 * "Do not reuse these main character names" — so a channel's stories stop
 * all starring the same Elara.
 *
 * The names are read back from what recent episodes already stored (their
 * script outline, else the finished narration), not from a new field. A main
 * character is the capitalised word that is never written in lower case and
 * is repeated far more than anything else; places and objects show up much
 * less often, so they are left out.
 *
 * A channel that uses Character Continuity WANTS a recurring cast, so it gets
 * no avoidance line at all.
 */

import fs from 'fs/promises'
import path from 'path'
import * as pm from './project-manager.js'
import { getIdeas } from './idea-manager.js'
import { resolveEpisodePathsByCode } from './utils.js'
import { readSidecar } from '../lib/chunked-narration.js'

/** Episodes looked at, newest first. */
const RECENT_EPISODES = 8
/** A name must be written at least this often, and at least this share of the top name's count. */
const MIN_MENTIONS = 4
const MIN_SHARE_OF_TOP = 0.4
const MAX_NAMES_PER_EPISODE = 3

export function extractMainCharacterNames(text: string): string[] {
  const counts = new Map<string, number>()
  for (const [word] of text.matchAll(/\b[A-Z][a-z]{2,}\b/g)) counts.set(word, (counts.get(word) ?? 0) + 1)
  // A word that also appears in lower case ("the", "silence") is not a name.
  const lower = new Set(text.match(/\b[a-z]{3,}\b/g) ?? [])
  const names = [...counts].filter(([word, n]) => n >= MIN_MENTIONS && !lower.has(word.toLowerCase()))
    .sort((a, b) => b[1] - a[1])
  const top = names[0]?.[1] ?? 0
  return names.filter(([, n]) => n >= top * MIN_SHARE_OF_TOP).slice(0, MAX_NAMES_PER_EPISODE).map(([word]) => word)
}

export function characterNamesAvoidance(names: string[]): string {
  return names.length
    ? `Do not reuse these main character names from this channel's recent episodes: ${names.join(', ')}. Give this episode's main character a different, fresh name.`
    : ''
}

async function episodeText(slug: string, code: string): Promise<string> {
  const paths = await resolveEpisodePathsByCode(slug, code)
  const sidecar = await readSidecar(paths.script_dir, code)
  if (sidecar?.outline?.length) {
    return sidecar.outline.map(e => [e.title, e.synopsis, ...(e.key_beats ?? [])].filter(Boolean).join(' ')).join('\n')
  }
  return fs.readFile(path.join(paths.script_dir, `${code}_Script_Narration.md`), 'utf-8').then(t => t.slice(0, 60000), () => '')
}

/** The prompt line for this channel's next episode / idea, or '' when none applies. */
export async function recentCharacterNamesAvoidance(slug: string, currentEpisodeId?: string): Promise<string> {
  try {
    const project = await pm.getProject(slug)
    if (!project || project.continuity_mode === 'character-continuity') return ''
    const number = (code: string) => Number(code.match(/\d+/)?.[0] ?? 0)
    const codes = [...new Set((await getIdeas(slug)).map(i => i.episode_code).filter((c): c is string => !!c && c !== currentEpisodeId))]
      .sort((a, b) => number(b) - number(a)).slice(0, RECENT_EPISODES)
    const names = new Set<string>()
    for (const code of codes) for (const name of extractMainCharacterNames(await episodeText(slug, code))) names.add(name)
    return characterNamesAvoidance([...names])
  } catch {
    return '' // a hint, never a reason to fail a generation
  }
}
