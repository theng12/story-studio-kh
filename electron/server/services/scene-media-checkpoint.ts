import fs from 'fs/promises'

import { withLock, writeJsonAtomic } from '../lib/atomic-store.js'
import type { ScenePlan } from '../models/types.js'

async function assertUsableFile(filePath: string, label: string): Promise<void> {
  const stat = await fs.stat(filePath).catch(() => null)
  if (!stat?.isFile() || stat.size <= 0) {
    throw new Error(`${label} was not saved as a usable file: ${filePath}`)
  }
}

export async function checkpointSceneImage(
  planPath: string,
  sceneId: string,
  imagePath: string,
  renderedPrompt: string,
): Promise<ScenePlan> {
  await assertUsableFile(imagePath, `Image for ${sceneId}`)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its image could be registered.`)

    scene.image_path = imagePath
    scene.rendered_prompt = renderedPrompt
    scene.image_version = new Date().toISOString()
    scene.motion_choice = 'pending'
    scene.approved = false
    await writeJsonAtomic(planPath, plan)
    return plan
  })
}

export async function checkpointSceneClip(
  planPath: string,
  sceneId: string,
  clipPath: string,
  renderedMotionPrompt: string,
  sourceImageVersion: string | undefined,
  approveClip: boolean,
): Promise<ScenePlan> {
  await assertUsableFile(clipPath, `Motion clip for ${sceneId}`)
  return withLock(planPath, async () => {
    const plan = JSON.parse(await fs.readFile(planPath, 'utf-8')) as ScenePlan
    const scene = plan.scenes.find(item => item.id === sceneId)
    if (!scene) throw new Error(`Scene ${sceneId} disappeared before its motion clip could be registered.`)

    scene.clip_path = clipPath
    scene.rendered_motion_prompt = renderedMotionPrompt
    scene.clip_source_image_version = sourceImageVersion
    scene.motion_choice = approveClip ? 'clip' : 'pending'
    await writeJsonAtomic(planPath, plan)
    return plan
  })
}
