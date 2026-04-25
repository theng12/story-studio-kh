/**
 * fal.ai video generation client — submits to queue, polls, extracts video URL.
 * Works for Veo 3.1, Sora 2, Hailuo-02, Wan, and any other fal model that returns
 * a result containing `{ video: { url } }` or `{ video_url }` or similar.
 *
 * Auth: `Authorization: Key <key>` header (different from Bearer).
 * Flow: POST https://queue.fal.run/{slug} → { status_url, response_url } → poll until COMPLETED.
 */

import { pollForResult, readJsonOrThrow } from './http-retry.js'
import { redactSecrets } from './redact-secrets.js'

const POLL_INTERVAL = 5000
const MAX_WAIT = 600000 // 10 minutes

export interface FalVideoOptions {
  apiKey: string
  /** fal model slug, e.g. 'fal-ai/veo3.1' or 'fal-ai/sora-2/image-to-video' */
  modelSlug: string
  /** The JSON payload to submit — varies per model but always includes `prompt` */
  payload: Record<string, any>
  /** Probe for user cancel — aborts submit + stops polling immediately. */
  isCancelled?: () => boolean
}

export async function generateFalVideo(opts: FalVideoOptions): Promise<string[]> {
  const { apiKey, modelSlug, payload, isCancelled } = opts
  if (!apiKey) throw new Error('No fal.ai API key configured.')
  if (isCancelled?.()) throw new Error('Cancelled by user')

  const headers = {
    Authorization: `Key ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const submit = await fetch(`https://queue.fal.run/${modelSlug}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(60_000),
  })
  if (!submit.ok) {
    const err = await submit.text()
    throw new Error(`fal.ai video submit failed (${submit.status}): ${redactSecrets(err, apiKey).slice(0, 300)}`)
  }
  const submitResult = await readJsonOrThrow(submit, 'fal.ai video submit')

  // Direct result (rare for video — but handle it)
  if (submitResult.video || submitResult.video_url || submitResult.url) {
    return extractVideoUrls(submitResult)
  }

  const statusUrl = submitResult.status_url || submitResult.response_url
  const responseUrl = submitResult.response_url
  if (!statusUrl && !responseUrl) {
    throw new Error(`No status_url/response_url in fal.ai queue response: ${redactSecrets(JSON.stringify(submitResult), apiKey).slice(0, 300)}`)
  }

  // Status polling with consecutive-failure escalation + Retry-After. A
  // cascade of 429s from fal now fails the job with a clear rate-limit
  // message instead of silently timing out 10 minutes later.
  const finalResult = await pollForResult<any>({
    label: 'fal.ai video status',
    url: statusUrl,
    headers: { Authorization: `Key ${apiKey}` },
    deadline: Date.now() + MAX_WAIT,
    intervalMs: POLL_INTERVAL,
    redactKey: apiKey,
    isCancelled,
    onData: async (data: any) => {
      if (data.status === 'COMPLETED') {
        const resultResp = await fetch(responseUrl, {
          headers: { Authorization: `Key ${apiKey}` },
          signal: AbortSignal.timeout(30_000),
        })
        if (!resultResp.ok) return { fail: new Error(`Failed to fetch fal result: ${resultResp.status}`) }
        return { done: await readJsonOrThrow(resultResp, 'fal.ai video result') }
      }
      if (data.status === 'FAILED') {
        return { fail: new Error(`fal.ai video failed: ${data.error || 'unknown error'}`) }
      }
      return { continue: true }
    },
  })
  return extractVideoUrls(finalResult)
}

function extractVideoUrls(result: any): string[] {
  const urls: string[] = []

  // Common shapes: { video: { url } }, { video_url }, { videos: [{ url }] }, { url }
  if (result?.video?.url) urls.push(result.video.url)
  if (Array.isArray(result?.videos)) {
    for (const v of result.videos) if (v?.url) urls.push(v.url)
  }
  if (result?.video_url) urls.push(result.video_url)
  if (result?.url && /\.(mp4|webm|mov)/i.test(result.url)) urls.push(result.url)

  // Fallback: regex-search the whole response for video URLs
  if (!urls.length) {
    const raw = JSON.stringify(result)
    const matches = raw.match(/https?:\/\/[^\s"']+\.(mp4|webm|mov)[^\s"']*/gi)
    if (matches) urls.push(...matches)
  }

  if (!urls.length) throw new Error(`No video URL in fal.ai response: ${JSON.stringify(result).slice(0, 500)}`)
  return urls
}
