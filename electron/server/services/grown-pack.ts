/**
 * #3 Self-growing Topic Packs (1.4.293): storage for a channel's own "grown" pack.
 *
 * `${projectsRoot}/.topic-packs/grown-<slug>.json` is an ordinary legacy user Topic Pack, so every
 * loader and the planner read it unchanged. It is never added to the project's `topic_pack_ids`;
 * with `idea_upgrades.grow_packs` on, the campaign and the supply counter append it after the
 * normal composition (`withGrownPack`), so turning the switch off simply ignores the file.
 * Original packs are never touched. Removing a subject moves it to `grown.rejected` — never a hard
 * delete — and a rejected subject is never proposed again.
 */
import { existsSync } from 'fs'
import { readJsonOr, withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { Niche, TopicPack } from '../models/types.js'
import { ensureTopicPacksDir, invalidateTopicPackCache, topicPackFilePath } from './topic-pack-loader.js'

export interface GrownEntry { subject: string; added_at: string; source: string; source_url?: string; model: string; why?: string }
export interface GrownPack extends TopicPack {
  grown: { channel: string; entries: GrownEntry[]; rejected: Array<{ subject: string; rejected_at: string }> }
}

export function grownPackId(slug: string): string {
  return `grown-${slug}`
}

export async function readGrownPack(slug: string): Promise<GrownPack | null> {
  const file = topicPackFilePath(grownPackId(slug))
  if (!existsSync(file)) return null
  const pack = await readJsonOr<GrownPack | null>(file, null)
  return pack && Array.isArray(pack.subjects) && pack.grown && Array.isArray(pack.grown.entries) ? pack : null
}

/** Append the channel's grown pack to an already-composed Topic Pack niche. Freeform channels stay freeform. */
export async function withGrownPack<T extends Niche | null>(niche: T, slug: string): Promise<T> {
  if (!niche?.activeTopicPacks?.length) return niche
  const grown = await readGrownPack(slug)
  if (!grown?.subjects.length || niche.activeTopicPacks.some(pack => pack.id === grown.id)) return niche
  return { ...niche, activeTopicPacks: [...niche.activeTopicPacks, grown] }
}

/** Add-only write of new subjects (atomic, under the file lock). */
export async function addGrownSubjects(slug: string, options: { formulaId: string; channelName: string; entries: GrownEntry[] }): Promise<GrownPack> {
  await ensureTopicPacksDir()
  const id = grownPackId(slug)
  const file = topicPackFilePath(id)
  return withLock(file, async () => {
    const current = await readGrownPack(slug)
    const pack: GrownPack = current || {
      id,
      name: `Grown subjects — ${options.channelName}`,
      description: `Subjects Story added for ${options.channelName} when its Topic Packs ran low. Review them on the Ideas page; Remove stops one being used.`,
      builtin: false,
      schemaVersion: 1,
      compatibleNicheIds: [options.formulaId],
      maxSiblingsPerSubject: 2,
      subjects: [],
      grown: { channel: slug, entries: [], rejected: [] },
    }
    const have = new Set(pack.subjects.map(subject => subject.toLowerCase()))
    const fresh = options.entries.filter(entry => !have.has(entry.subject.toLowerCase()))
    const next: GrownPack = {
      ...pack,
      subjects: [...pack.subjects, ...fresh.map(entry => entry.subject)],
      grown: { ...pack.grown, entries: [...pack.grown.entries, ...fresh] },
    }
    await writeJsonAtomic(file, next)
    invalidateTopicPackCache(id)
    return next
  })
}

/** "Remove": the subject stops being used and moves to `rejected`; its history entry stays. */
export async function rejectGrownSubject(slug: string, subject: string): Promise<GrownPack | null> {
  const file = topicPackFilePath(grownPackId(slug))
  return withLock(file, async () => {
    const pack = await readGrownPack(slug)
    const match = pack?.subjects.find(value => value.toLowerCase() === subject.trim().toLowerCase())
    if (!pack || !match) return null
    const next: GrownPack = {
      ...pack,
      subjects: pack.subjects.filter(value => value !== match),
      grown: { ...pack.grown, rejected: [...pack.grown.rejected, { subject: match, rejected_at: new Date().toISOString() }] },
    }
    await writeJsonAtomic(file, next)
    invalidateTopicPackCache(pack.id)
    return next
  })
}
