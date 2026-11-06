/**
 * The draft rules EpisodeEffectsEditor runs on: what makes a draft dirty,
 * which queued side-writes survive into an apply and in what order, and how a
 * not-yet-uploaded outline's placeholder becomes the mask name the server
 * gave it.
 *
 * Nothing here writes or reads the network. The component turns these into
 * requests only inside `apply()`; cancel is dropping the state these functions
 * read. The file shape, its compaction and its endpoint stay episode-effects'
 * own — this module never changes what gets saved, only when.
 */

import { compactFile, type EpisodeEffectsFile } from './effects-library'

/** Placeholder mask names the draft file carries until apply uploads them. */
const OUTLINE_PREFIX = 'draft-outline-'
export interface EpisodeEffectsOutlineOp {
  kind: 'outline'
  /** The mask name used inside the draft file until the server answers. */
  placeholder: string
  scene_id: string
  label: string
  data_base64?: string
  shapes?: unknown[]
  feather_px?: number
}

export interface EpisodeEffectsSwitchesOp {
  kind: 'switches'
  switches: { depth: boolean; vision: boolean }
}

export interface EpisodeEffectsAnalyseOp { kind: 'analyse' }

export interface EpisodeEffectsPresetSaveOp {
  kind: 'preset-save'
  name: string
  effects: Array<{ id: string; params?: Record<string, unknown> }>
}

export interface EpisodeEffectsPresetDeleteOp {
  kind: 'preset-delete'
  preset_id: string
  name: string
}

export type EpisodeEffectsWriteOp =
  | EpisodeEffectsSwitchesOp
  | EpisodeEffectsAnalyseOp
  | EpisodeEffectsPresetSaveOp
  | EpisodeEffectsPresetDeleteOp

export type EpisodeEffectsOp = EpisodeEffectsOutlineOp | EpisodeEffectsWriteOp

/**
 * The placeholder must satisfy the scene-effects mask contract
 * (`OUTLINE_MASK_NAME`, a `.png` file name): the draft carries it inside
 * `region.mask`, and that schema drops any name it cannot accept.
 */
export function outlinePlaceholder(seq: number): string {
  return `${OUTLINE_PREFIX}${seq}.png`
}

export function cloneEffectsFile(file: EpisodeEffectsFile): EpisodeEffectsFile {
  return JSON.parse(JSON.stringify(file)) as EpisodeEffectsFile
}

/** Dirty = the file differs from the loaded baseline, or a side-write is queued. */
export function isDraftDirty(
  baseline: EpisodeEffectsFile,
  file: EpisodeEffectsFile,
  ops: readonly EpisodeEffectsOp[],
): boolean {
  if (ops.length) return true
  return JSON.stringify(file) !== JSON.stringify(baseline)
}

/** Every mask name the file actually references, by exact identity — `draft-outline-1` is not `draft-outline-10`. */
function referencedMasks(file: EpisodeEffectsFile): Set<string> {
  const names = new Set<string>()
  const scan = (effects: EpisodeEffectsFile['episode']): void => {
    for (const effect of effects) {
      const mask = (effect.params as { region?: { mask?: unknown } } | undefined)?.region?.mask
      if (typeof mask === 'string') names.add(mask)
    }
  }
  scan(file.episode)
  for (const theme of file.themes) scan(theme.effects)
  for (const scene of file.scenes) scan(scene.effects)
  return names
}

/**
 * The apply split: outline uploads first (the file references their masks by
 * placeholder), then the file PUT, then the remaining writes in a fixed order
 * so a queued analysis always runs after the switches it reads. An outline the
 * file no longer references is dropped rather than uploaded for nothing —
 * a placeholder counts as referenced only when it is one of the file's own
 * mask names, matched exactly.
 */
export function planOps(
  file: EpisodeEffectsFile,
  ops: readonly EpisodeEffectsOp[],
): { outlines: EpisodeEffectsOutlineOp[]; writes: EpisodeEffectsWriteOp[] } {
  const masks = referencedMasks(file)
  const outlines = ops.filter((op): op is EpisodeEffectsOutlineOp => op.kind === 'outline' && masks.has(op.placeholder))
  const rank: Record<EpisodeEffectsWriteOp['kind'], number> = { switches: 0, analyse: 1, 'preset-save': 2, 'preset-delete': 3 }
  const writes = ops
    .filter((op): op is EpisodeEffectsWriteOp => op.kind !== 'outline')
    .sort((a, b) => rank[a.kind] - rank[b.kind])
  return { outlines, writes }
}

/** The PUT body: the draft file, compacted — byte-for-byte what the page sends. */
export function applyFilePayload(file: EpisodeEffectsFile): EpisodeEffectsFile {
  return compactFile(cloneEffectsFile(file))
}

/**
 * After an outline upload answers, its real mask name replaces the placeholder
 * in the draft file and in the outline list. Returns the new list; the file is
 * updated in place so a later PUT carries the real name.
 */
export function adoptMasks(file: EpisodeEffectsFile, outlines: readonly string[], masks: Record<string, string>): string[] {
  const entries = Object.entries(masks)
  if (!entries.length) return [...outlines]
  let text = JSON.stringify(file)
  for (const [placeholder, mask] of entries) text = text.split(JSON.stringify(placeholder)).join(JSON.stringify(mask))
  Object.assign(file, JSON.parse(text))
  return outlines.map(name => masks[name] ?? name)
}
