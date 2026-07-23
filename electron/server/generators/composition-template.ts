/**
 * Composition-template generator (v1.0.260).
 *
 * Renders ONE explainer "layout template" image from a text prompt and saves it
 * to <episode_dir>/img2img-references/composition.png — the same slot the user
 * can upload to manually. The continuity renderer then feeds this image as an
 * img2img structure reference on every scene (when references.composition is
 * on), so the recurring layout — subject framed as the centrepiece, guide
 * character at the side — stays consistent across the whole episode.
 *
 * Mirrors scene-image.ts's provider/model resolution (incl. the local Image
 * Studio synthesis), but with NO reference images (pure text2img) and a fixed
 * output filename.
 */

import fs from 'fs/promises'
import path from 'path'
import { registry } from '../providers/registry.js'
import { saveGenStudioImage } from '../lib/genstudio-artifacts.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import { requireJobCompletion } from '../services/job-completion.js'
import { hashInput, recordTask } from '../services/task-manifest.js'
import type { Job } from '../models/types.js'
import { resolveImageModelConfig } from '../services/image-model-resolver.js'
import { getApiKey } from '../services/app-secrets-store.js'

const COMPOSITION_FILENAME = 'composition.png'

interface CompositionGenerateParams {
  episode_id: string
  title?: string
  /** Text prompt describing the layout template (guide at the side gesturing at
   *  an empty framed window/portal where each scene's subject will go). */
  prompt: string
  /** Image model id — a key in config.image_models, or a local
   *  `imagestudio:<repo>` id. */
  model: string
  aspect_ratio?: string
}

export async function generateCompositionTemplateJob(job: Job): Promise<void> {
  const params = job.params as CompositionGenerateParams
  const { episode_id, model } = params
  const prompt = (params.prompt || '').trim()
  if (!episode_id) throw new Error('episode_id is required')
  if (!model) throw new Error('model is required')
  if (!prompt) throw new Error('prompt is required')

  const paths = await resolveEpisodePathsByCode(job.project_slug, episode_id)

  // Resolve the configured image model + its provider (mirrors scene-image.ts).
  const config = await pm.getConfig(job.project_slug)
  if (!config) throw new Error('Project config not found')
  const modelConfig = resolveImageModelConfig(config, model)
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  if (modelConfig.provider !== 'genstudio-image') {
    throw new Error(`Image model "${model}" is not routed through GenStudio KH.`)
  }
  const imageProvider = registry.getImageProvider('genstudio-image')
  if (!imageProvider) throw new Error('GenStudio KH image provider is unavailable.')

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await getApiKey('genstudio')
  if (!apiKey) throw new Error('Add the GenStudio API key in Settings before generating images.')

  job.output_lines.push(`Composition template — ${imageProvider.meta.name} / ${model}`)
  job.output_lines.push(`Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  const aspectRatio = params.aspect_ratio || '16:9'
  const outDir = path.join(paths.episode_dir, 'img2img-references')
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, COMPOSITION_FILENAME)
  const result = await imageProvider.generateImage({
    prompt,
    apiKey,
    aspectRatio,
    modelId: modelConfig.api_model || model,
    providerParams,
    idempotencyIdentity: `${job.job_id}:composition-template`,
    onJobAccepted: async (taskId) => {
      await recordTask(outDir, COMPOSITION_FILENAME, {
        provider: imageProvider.meta.providerId || imageProvider.meta.id,
        task_id: taskId,
        submitted_at: new Date().toISOString(),
        input_hash: hashInput(prompt),
      })
    },
  })

  job.progress = 70
  if (!result.urls.length) {
    throw new Error(`${imageProvider.meta.name} returned no image for the composition template.`)
  }

  if (result.taskId) {
    await recordTask(outDir, COMPOSITION_FILENAME, {
      provider: imageProvider.meta.providerId || imageProvider.meta.id,
      task_id: result.taskId,
      submitted_at: new Date().toISOString(),
      input_hash: hashInput(prompt),
    })
  }
  await saveGenStudioImage(result.urls[0]!, outPath)
  const outputStat = await fs.stat(outPath)
  if (!outputStat.isFile() || outputStat.size <= 0) throw new Error('Downloaded composition template is empty.')

  job.output_dir = outDir
  job.progress = 100
  requireJobCompletion(job, {
    label: 'Composition template generation', expected: 1, completed: 1,
    retry_hint: 'The provider task was recorded; use Repair before Retry if the download was interrupted.',
  })
  job.output_lines.push(`Done → ${COMPOSITION_FILENAME}`)
}
