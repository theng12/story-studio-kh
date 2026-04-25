/**
 * kie.ai video generation client — Sora 2, Kling 3.0, etc. via /jobs/createTask + /jobs/recordInfo.
 * Piggybacks on the existing "jobs" endpoint pattern but looks for video URLs in the response.
 *
 * Auth: Bearer <key>.
 */

import { pollForResult } from './http-retry.js'
import { redactSecrets } from './redact-secrets.js'

const KIE_BASE_URL = 'https://api.kie.ai/api/v1'
const POLL_INTERVAL = 6000
const MAX_WAIT = 600000 // 10 minutes (video takes longer than images)

export type KieVideoEndpointType = 'jobs' | 'veo' | 'runway'

export interface KieVideoOptions {
  apiKey: string
  /** Which kie endpoint family to call — default 'jobs'. */
  type?: KieVideoEndpointType
  /** kie model slug (for 'jobs' and 'veo'): e.g. 'sora-2-text-to-video', 'veo3_fast'. Unused by 'runway'. */
  apiModel?: string
  /** Payload for 'jobs' — goes inside { model, input: {...} }.
   *  For 'veo' and 'runway' this is the FLAT payload sent as the request body (merged with prompt/aspect/etc. populated by the provider). */
  input: Record<string, any>
  /** Probe for user cancel — stops polling immediately. */
  isCancelled?: () => boolean
}

export async function generateKieVideo(opts: KieVideoOptions): Promise<string[]> {
  const { apiKey, type = 'jobs', apiModel, input, isCancelled } = opts
  if (!apiKey) throw new Error('No kie.ai API key configured.')
  if (isCancelled?.()) throw new Error('Cancelled by user')

  // Endpoint + request body + poll path differ by type
  let submitPath: string
  let pollPath: string
  let body: Record<string, any>

  if (type === 'veo') {
    if (!apiModel) throw new Error('kie.ai Veo requires provider_params.api_model (e.g. "veo3_fast")')
    submitPath = '/veo/generate'
    pollPath = '/veo/record-info'
    body = { ...input, model: apiModel }
  } else if (type === 'runway') {
    submitPath = '/runway/generate'
    pollPath = '/runway/record-info'
    body = { ...input }
  } else {
    if (!apiModel) throw new Error('kie.ai jobs endpoint requires provider_params.api_model')
    submitPath = '/jobs/createTask'
    pollPath = '/jobs/recordInfo'
    body = { model: apiModel, input }
  }

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  }

  const submitResp = await fetch(`${KIE_BASE_URL}${submitPath}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  })
  if (!submitResp.ok) {
    const text = await submitResp.text()
    throw new Error(`kie.ai ${type} submit failed (${submitResp.status}): ${redactSecrets(text, apiKey).slice(0, 300)}`)
  }
  const submitData = await submitResp.json() as any
  const taskId = submitData?.data?.taskId || submitData?.taskId || submitData?.data?.task_id || submitData?.task_id
  if (!taskId) throw new Error(`No task ID in kie.ai response: ${redactSecrets(JSON.stringify(submitData), apiKey).slice(0, 300)}`)

  return pollForResult<string[]>({
    label: `kie.ai ${type} poll`,
    url: `${KIE_BASE_URL}${pollPath}?taskId=${taskId}`,
    headers: { Authorization: `Bearer ${apiKey}` },
    deadline: Date.now() + MAX_WAIT,
    intervalMs: POLL_INTERVAL,
    redactKey: apiKey,
    isCancelled,
    onData: (data: any) => {
      const taskData = data.data || data
      const successFlag = taskData.successFlag
      const status: string = successFlag === 1 ? 'success'
        : successFlag >= 2 ? 'failed'
        : String(taskData.state || taskData.status || '').toLowerCase()

      if (['success', 'completed', 'finished', 'succeed'].includes(status)) {
        const urls = extractVideoUrls(taskData)
        if (urls.length) return { done: urls }
        return { fail: new Error(`kie.ai task succeeded but no video URLs found: ${redactSecrets(JSON.stringify(taskData), apiKey).slice(0, 400)}`) }
      }
      if (['failed', 'error', 'fail'].includes(status)) {
        return { fail: new Error(`kie.ai video failed: ${taskData.failReason || taskData.error || 'unknown'}`) }
      }
      return { continue: true }
    },
  })
}

function extractVideoUrls(taskData: any): string[] {
  const urls: string[] = []
  const response = taskData.response || {}

  // Primary shapes from kie.ai video endpoints
  const candidateFields = [
    response.resultUrls, response.videoUrls, response.videos, response.outputUrls,
    taskData.resultUrls, taskData.videoUrls, taskData.videos, taskData.outputUrls,
  ]
  for (const list of candidateFields) {
    if (Array.isArray(list)) {
      for (const u of list) {
        if (typeof u === 'string') urls.push(u)
        else if (u?.url) urls.push(u.url)
      }
    }
  }

  // Single-URL fallback fields
  const singles = [response.resultVideoUrl, response.videoUrl, taskData.videoUrl, taskData.resultVideoUrl, taskData.outputUrl]
  for (const s of singles) if (typeof s === 'string') urls.push(s)

  // resultJson string fallback (Grok-style nested encoding)
  if (!urls.length && taskData.resultJson) {
    try {
      const rj = typeof taskData.resultJson === 'string' ? JSON.parse(taskData.resultJson) : taskData.resultJson
      const list = rj.resultUrls || rj.videoUrls || []
      for (const u of list) {
        if (typeof u === 'string') urls.push(u)
        else if (u?.url) urls.push(u.url)
      }
    } catch {}
  }

  // Last resort: regex the whole blob for mp4 URLs
  if (!urls.length) {
    const raw = JSON.stringify(taskData)
    const matches = raw.match(/https?:\/\/[^\s"']+\.(mp4|webm|mov)[^\s"']*/gi)
    if (matches) urls.push(...matches)
  }

  return [...new Set(urls)]
}
