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
import { resolveApiKeyForProvider } from '../providers/registry.js'
import { downloadImage } from '../lib/kie-client.js'
import { resolveEpisodePathsByCode } from '../services/utils.js'
import * as pm from '../services/project-manager.js'
import type { Job, ImageModelConfig } from '../models/types.js'

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
  let modelConfig: ImageModelConfig | undefined = config.image_models?.[model]
  if (!modelConfig) {
    // Local Image Studio models (`imagestudio:<repo>`) are dynamic and not in
    // config.image_models; synthesize a minimal config so they work here too.
    const { repoForModelId } = await import('../lib/imagestudio-client.js')
    const repo = repoForModelId(model)
    if (repo) {
      modelConfig = {
        label: repo, credits_per_image: 0, prompt_char_cap: 1000,
        endpoint: '', poll: '', type: 'local', api_model: repo,
        provider: 'imagestudio', supports_reference_images: true,
      } as any
    }
  }
  if (!modelConfig) throw new Error(`Unknown image model: ${model}`)

  const providerId = (modelConfig as any).provider || 'kie'
  const imageProvider = registry.getImageProvider(providerId)
  if (!imageProvider) throw new Error(`No image provider registered for: ${providerId}`)

  const providerParams = (modelConfig as any).provider_params || {
    endpoint: modelConfig.endpoint,
    poll: modelConfig.poll,
    type: modelConfig.type,
    api_model: modelConfig.api_model,
    aspect_field: (modelConfig as any).aspect_field,
  }
  const apiKey = await resolveApiKeyForProvider(job.project_slug, imageProvider.meta, {
    model,
    jobId: job.job_id,
  })
  if (!apiKey && providerId !== 'imagestudio') {
    throw new Error(
      `No API key configured for ${imageProvider.meta.name}. Add one in App Settings → API Keys.`,
    )
  }

  job.output_lines.push(`Composition template — ${imageProvider.meta.name} / ${model}`)
  job.output_lines.push(`Prompt: ${prompt.slice(0, 200)}${prompt.length > 200 ? '…' : ''}`)
  job.progress = 10

  const aspectRatio = params.aspect_ratio || '16:9'
  const result = await imageProvider.generateImage({
    prompt,
    apiKey,
    aspectRatio,
    modelId: model,
    providerParams,
  })

  job.progress = 70
  if (!result.urls.length) {
    throw new Error(`${imageProvider.meta.name} returned no image for the composition template.`)
  }

  const outDir = path.join(paths.episode_dir, 'img2img-references')
  await fs.mkdir(outDir, { recursive: true })
  const outPath = path.join(outDir, COMPOSITION_FILENAME)
  await downloadImage(result.urls[0]!, outPath)

  job.output_dir = outDir
  job.progress = 100
  job.output_lines.push(`Done → ${COMPOSITION_FILENAME}`)
}
