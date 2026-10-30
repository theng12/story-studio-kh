import { createHash } from 'node:crypto'
import fs from 'node:fs/promises'
import path from 'node:path'
import type { ContextualCue, ScenePlan } from '../models/types.js'
import { analyzeImage } from './scene-vision-client.js'
import { analysisCopy } from '../services/scene-analysis.js'
import { findLabelDesign } from './label-design-render.js'
import { withLock, writeJsonAtomic } from './atomic-store.js'
import { mapWithConcurrency } from './map-with-concurrency.js'

type TargetResult = { x: number; y: number } | { reason: string }

/** Resolve once per cue, phrase and image bytes; a manual target always takes precedence. */
export async function resolveLabelTargets(input: {
  episodeDir: string; plan: ScenePlan; cues: ContextualCue[]; sceneImages: Map<string, string>;
  log: (message: string) => void
}): Promise<ContextualCue[]> {
  return mapWithConcurrency(input.cues, 3, async cue => {
    if (!cue.point_at?.trim() || !cue.template.startsWith('label:')
      || (cue.target_x_pct != null && cue.target_y_pct != null)) return cue
    try {
      if (!(await findLabelDesign(cue.template))?.pointing) return cue
      const scene = input.plan.scenes.find(item => item.id === cue.scene_id)
      if (!scene) throw new Error('the scene is missing from the plan')
      const still = input.sceneImages.get(scene.id)
      if (!still || /\.(mp4|mov|webm|mkv|m4v)$/i.test(still)) throw new Error(`scene ${scene.scene_index} has no image`)
      const bytes = await fs.readFile(still)
      const key = createHash('sha256').update(JSON.stringify([cue.id, cue.scene_id, cue.point_at.trim()])).update(bytes).digest('hex')
      const cachePath = path.join(input.episodeDir, '.label-targets', `${key}.json`)
      const result = await withLock(cachePath, async (): Promise<TargetResult> => {
        try {
          const cached = JSON.parse(await fs.readFile(cachePath, 'utf8')) as TargetResult
          if (('reason' in cached && ['no target found', 'the target box was invalid', 'the target covered too much of the image'].includes(cached.reason))
            || ('x' in cached && Number.isFinite(cached.x) && cached.x >= 0 && cached.x <= 100
              && Number.isFinite(cached.y) && cached.y >= 0 && cached.y <= 100)) return cached
        } catch { /* No usable cached result. */ }
        let found: TargetResult
        try {
          const jpeg = await analysisCopy(bytes)
          const { answer } = await analyzeImage({ tasks: ['subject'], image: { b64: jpeg.toString('base64'), mime: 'image/jpeg' }, text: cue.point_at!.trim() })
          const box = answer.subject?.source === 'grounding' ? answer.subject.box : null
          if (!Array.isArray(box) || box.length !== 4 || !box.every(Number.isFinite)) {
            found = { reason: 'no target found' }
          } else {
            const [x, y, w, h] = box
            if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1 || y + h > 1) found = { reason: 'the target box was invalid' }
            // The tested vines and riverbank failures covered over 70% of the frame; the valid river did not.
            else if (w * h > 0.7) found = { reason: 'the target covered too much of the image' }
            else found = { x: (x + w / 2) * 100, y: (y + h / 2) * 100 }
          }
        } catch (error) {
          return { reason: `the Gateway could not find the target (${error instanceof Error ? error.message : String(error)})` }
        }
        await writeJsonAtomic(cachePath, found)
        return found
      })
      if (!bytes.equals(await fs.readFile(still))) throw new Error('the scene image changed while finding the target')
      if ('reason' in result) {
        input.log(`Label "${cue.title}": ${result.reason}; drawing without a pointer.`)
        return cue
      }
      return { ...cue, target_x_pct: result.x, target_y_pct: result.y }
    } catch (error) {
      input.log(`Label "${cue.title}": ${error instanceof Error ? error.message : String(error)}; drawing without a pointer.`)
      return cue
    }
  })
}
