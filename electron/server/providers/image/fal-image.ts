/**
 * fal.ai image provider.
 *
 * Uses fal queue endpoints directly so cloud image models served by fal can
 * appear beside kie.ai/OpenAI/OpenRouter in the normal image model picker.
 */

import fs from 'fs/promises'
import { pollForResult, readJsonOrThrow } from '../../lib/http-retry.js'
import { redactSecrets } from '../../lib/redact-secrets.js'
import { registry } from '../registry.js'
import type { ImageProvider, ImageGenerationRequest, ImageGenerationResult } from '../types.js'

const POLL_INTERVAL = 3000
const MAX_WAIT = 300000

function falImageSize(aspectRatio: string, editing: boolean): string {
  if (editing) return 'auto'
  switch (aspectRatio) {
    case '16:9': case '21:9': return 'landscape_16_9'
    case '4:3': case '3:2': return 'landscape_4_3'
    case '9:16': return 'portrait_16_9'
    case '3:4': case '2:3': return 'portrait_4_3'
    case '1:1': return 'square'
    default: return 'landscape_4_3'
  }
}

function mimeFor(p: string): string {
  const e = p.toLowerCase()
  if (e.endsWith('.jpg') || e.endsWith('.jpeg')) return 'image/jpeg'
  if (e.endsWith('.webp')) return 'image/webp'
  return 'image/png'
}

async function dataUrlFor(p: string): Promise<string> {
  const buf = await fs.readFile(p)
  return `data:${mimeFor(p)};base64,${buf.toString('base64')}`
}

function extractImageUrls(result: any): string[] {
  const images = result?.images || result?.data?.images
  if (Array.isArray(images)) {
    const urls = images
      .map((img: any) => typeof img === 'string' ? img : img?.url || img?.image_url || '')
      .filter((url: string) => typeof url === 'string' && url)
    if (urls.length) return urls
  }
  const single = result?.image?.url || result?.image_url || result?.url || result?.data?.image?.url
  if (typeof single === 'string' && single) return [single]
  return []
}

async function pollFalImageStatus(
  statusUrl: string,
  responseUrl: string,
  apiKey: string,
  opts: { isCancelled?: () => boolean },
): Promise<any> {
  return pollForResult<any>({
    label: 'fal.ai image status',
    url: statusUrl,
    headers: { Authorization: `Key ${apiKey}` },
    deadline: Date.now() + MAX_WAIT,
    intervalMs: POLL_INTERVAL,
    redactKey: apiKey,
    isCancelled: opts.isCancelled,
    onData: async (data: any) => {
      if (data.status === 'COMPLETED') {
        const resultResp = await fetch(responseUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(30000),
        })
        if (!resultResp.ok) return { fail: new Error(`fal.ai image result fetch failed: ${resultResp.status}`) }
        return { done: await readJsonOrThrow(resultResp, 'fal.ai image result') }
      }
      if (data.status === 'FAILED') return { fail: new Error(`fal.ai image failed: ${data.error || 'Unknown error'}`) }
      return { continue: true }
    },
  })
}

const falImageProvider: ImageProvider = {
  meta: {
    id: 'fal-image',
    name: 'fal.ai',
    apiKeyField: 'fal_api_key',
    providerId: 'fal',
  },

  supportsModel(_modelId: string, providerParams: Record<string, any>): boolean {
    return providerParams?.provider === 'fal-image' || typeof providerParams?.slug === 'string'
  },

  async generateImage(request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const { prompt, apiKey, aspectRatio, providerParams, referenceImagePaths, isCancelled } = request
    if (!apiKey) throw new Error('No fal.ai API key configured. Add one in Settings → API Keys.')
    if (isCancelled?.()) throw new Error('Cancelled by user')

    const refs = (referenceImagePaths || []).filter(Boolean)
    const editing = refs.length > 0
    const slug = editing
      ? (providerParams?.edit_slug as string) || (providerParams?.slug_i2i as string) || (providerParams?.slug as string)
      : (providerParams?.slug as string)
    if (!slug) throw new Error('fal.ai image model is missing provider_params.slug')

    const input: Record<string, any> = {
      prompt,
      quality: providerParams?.quality || 'high',
      output_format: providerParams?.output_format || 'png',
    }
    if (editing) {
      input.image_urls = await Promise.all(refs.slice(0, 4).map(dataUrlFor))
      input.image_size = falImageSize(aspectRatio, true)
    } else {
      input.image_size = falImageSize(aspectRatio, false)
      input.num_images = 1
    }

    const submitResp = await fetch(`https://queue.fal.run/${slug}`, {
      method: 'POST',
      headers: { Authorization: `Key ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(60000),
    })
    if (!submitResp.ok) {
      const text = await submitResp.text().catch(() => '')
      throw new Error(`fal.ai image submit failed (${submitResp.status}): ${redactSecrets(text, apiKey).slice(0, 400)}`)
    }

    const submitted = await readJsonOrThrow(submitResp, 'fal.ai image submit')
    const directUrls = extractImageUrls(submitted)
    if (directUrls.length) return { urls: directUrls, taskId: submitted.request_id }

    const statusUrl = submitted.status_url || submitted.response_url
    const responseUrl = submitted.response_url
    if (!statusUrl || !responseUrl) {
      throw new Error(`No status_url or response_url in fal.ai response: ${redactSecrets(JSON.stringify(submitted), apiKey).slice(0, 300)}`)
    }

    const finalResult = await pollFalImageStatus(statusUrl, responseUrl, apiKey, { isCancelled })
    const urls = extractImageUrls(finalResult)
    if (!urls.length) throw new Error(`No image URL in fal.ai response: ${JSON.stringify(finalResult).slice(0, 500)}`)
    return { urls, taskId: submitted.request_id }
  },
}

registry.registerImage(falImageProvider)
