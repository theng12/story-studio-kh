/**
 * Per-channel idea-generator upgrades (1.4.285), stored as `idea_upgrades` in the channel's
 * config.json. Every switch is OFF unless set; an absent or unreadable value means off, so a
 * channel that never opens the setting behaves exactly as before.
 *
 * The models are the owner's picks from the live Gateway catalog. Nothing here names a model.
 */
import path from 'path'
import fs from 'fs/promises'
import { existsSync } from 'fs'
import * as pm from './project-manager.js'

export interface IdeaUpgrades {
  /** Text model for the small helper calls (covered-topics map). Empty = helper features skip. */
  helper_model: string
  /** #1: keep a covered-topics map of the whole history and show it to the idea model. */
  covered_map: boolean
  /** #2: `shadow` logs what a meaning check would reject; it never rejects. (`on` is a later phase.) */
  semantic_dedupe: 'off' | 'shadow'
  /** #2: Gateway embeddings model. Empty = the improved word check is used instead. */
  embedding_model: string
  /**
   * #2: cosine at or above this counts as a repeat. 0.78 for BGE-small (its scores bunch together:
   * a paraphrase of one subject scores ~0.84-0.86, a different subject ~0.43-0.58; see
   * __tests__/fixtures/idea-meaning-calibration.json). To be tuned from the pilot's logged scores.
   */
  semantic_threshold: number
  /** #6: Telegram/desktop alert when this channel's idea supply runs low. */
  supply_alerts: boolean
  /** #6: "running low" below this many unused Topic Pack subjects. */
  low_unused_subjects: number
  /** #6: "running low" when waiting ideas cover fewer days than this. */
  low_days_of_ideas: number
}

export const IDEA_UPGRADE_DEFAULTS: IdeaUpgrades = {
  helper_model: '',
  covered_map: false,
  semantic_dedupe: 'off',
  embedding_model: '',
  semantic_threshold: 0.78,
  supply_alerts: false,
  low_unused_subjects: 30,
  low_days_of_ideas: 14,
}

const SWITCHES = ['covered_map', 'supply_alerts'] as const

export function readIdeaUpgrades(config: unknown): IdeaUpgrades {
  const raw = (config as any)?.idea_upgrades
  const value = raw && typeof raw === 'object' ? raw : {}
  const text = (key: 'helper_model' | 'embedding_model') => typeof value[key] === 'string' ? value[key].trim() : ''
  const number = (key: keyof IdeaUpgrades, min: number, max: number) =>
    typeof value[key] === 'number' && Number.isFinite(value[key]) && value[key] >= min && value[key] <= max
      ? value[key] as number : IDEA_UPGRADE_DEFAULTS[key] as number
  return {
    helper_model: text('helper_model'),
    covered_map: value.covered_map === true,
    semantic_dedupe: value.semantic_dedupe === 'shadow' ? 'shadow' : 'off',
    embedding_model: text('embedding_model'),
    semantic_threshold: number('semantic_threshold', 0.5, 0.999),
    supply_alerts: value.supply_alerts === true,
    low_unused_subjects: number('low_unused_subjects', 0, 100_000),
    low_days_of_ideas: number('low_days_of_ideas', 0, 3650),
  }
}

export async function getIdeaUpgrades(slug: string): Promise<IdeaUpgrades> {
  return readIdeaUpgrades(await pm.getConfig(slug).catch(() => null))
}

/** Validate a partial update. Returns the error sentence, or the merged settings. */
export function mergeIdeaUpgrades(current: IdeaUpgrades, patch: unknown): IdeaUpgrades | string {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'Send a JSON object of idea_upgrades fields.'
  const next: Record<string, unknown> = { ...current }
  for (const [key, value] of Object.entries(patch)) {
    if (!(key in IDEA_UPGRADE_DEFAULTS)) return `${key}: not an idea upgrade setting.`
    if (key === 'semantic_dedupe') {
      if (value !== 'off' && value !== 'shadow') return 'semantic_dedupe: "off" or "shadow" (watch-only). Rejecting by meaning is not switched on in this release.'
    } else if (typeof value !== typeof IDEA_UPGRADE_DEFAULTS[key as keyof IdeaUpgrades]) {
      return `${key}: expected a ${typeof IDEA_UPGRADE_DEFAULTS[key as keyof IdeaUpgrades]}.`
    }
    next[key] = typeof value === 'string' ? value.trim() : value
  }
  const merged = readIdeaUpgrades({ idea_upgrades: next })
  for (const key of ['semantic_threshold', 'low_unused_subjects', 'low_days_of_ideas'] as const) {
    if (next[key] !== merged[key]) return `${key}: out of range.`
  }
  return merged
}

function anySwitchOn(value: IdeaUpgrades): boolean {
  return SWITCHES.some(key => value[key]) || value.semantic_dedupe !== 'off'
}

/**
 * Save, taking a one-time backup of ideas.json and config.json the first time any switch turns on
 * for this channel (`_backups/idea-upgrades-<ISO>/`). Nothing is deleted or rewritten.
 */
export async function saveIdeaUpgrades(slug: string, next: IdeaUpgrades): Promise<{ backup_dir: string | null }> {
  const projectDir = pm.getProjectDir(slug)
  if (!projectDir) throw Object.assign(new Error('Project not found'), { statusCode: 404 })
  const before = await getIdeaUpgrades(slug)
  let backup_dir: string | null = null
  const neverBackedUp = !existsSync(path.join(projectDir, '_backups'))
    || !(await fs.readdir(path.join(projectDir, '_backups'))).some(name => name.startsWith('idea-upgrades-'))
  if (anySwitchOn(next) && !anySwitchOn(before) && neverBackedUp) {
    backup_dir = path.join(projectDir, '_backups', `idea-upgrades-${new Date().toISOString().replace(/[:.]/g, '-')}`)
    await fs.mkdir(backup_dir, { recursive: true })
    for (const name of ['ideas.json', 'config.json']) {
      if (existsSync(path.join(projectDir, name))) await fs.copyFile(path.join(projectDir, name), path.join(backup_dir, name))
    }
  }
  await pm.updateConfig(slug, { idea_upgrades: next } as any)
  return { backup_dir }
}
