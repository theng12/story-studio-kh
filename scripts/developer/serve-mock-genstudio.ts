#!/usr/bin/env npx tsx
/**
 * Run the in-process mock GenStudio service as a standalone HTTP server, so a
 * real Story Studio app can be pointed at it for cross-workflow acceptance
 * (ACCEPT-01) with **zero network, zero spend**.
 *
 * The mock is the same fixture the backend suites use
 * (`electron/server/__tests__/fixtures/mock-genstudio-service.ts`), so its
 * models, credits, artifacts and failure scenarios are the ones the tests
 * already pin.
 *
 * It is deliberately **long-lived**: provider job ids recorded in a project's
 * manifests must still resolve after the app restarts, which is exactly what
 * ACCEPT-01's restart/resume leg needs to observe.
 *
 * Usage:
 *   npx tsx scripts/developer/serve-mock-genstudio.ts [--port 8799]
 *
 * Control surface (loopback only, for the acceptance driver):
 *   POST /__control/scenario  {operation, scenario}  queue one provider response
 *   POST /__control/clear     {operation}            drop queued responses
 *   POST /__control/chat-models {models}             publish an alternate language catalogue
 *   GET  /__control/state                            submissions, credits, recent requests
 *
 * Then, in the app: Settings → GenStudio URL → the printed URL, and the printed
 * key as the API key (or PUT both through the app's own API — see
 * `docs/handoffs/deepseek-reports/ACCEPT-01.md`).
 */
import http, { type AddressInfo } from 'node:http'
import { MockGenStudioService, MOCK_GENSTUDIO_FULL_KEY } from '../../electron/server/__tests__/fixtures/mock-genstudio-service.js'

const args = process.argv.slice(2)
const portFlag = args.indexOf('--port')
const port = portFlag === -1 ? 8799 : Number(args[portFlag + 1])

if (!Number.isInteger(port) || port <= 0 || port > 65535) {
  console.error(`serve-mock-genstudio: --port must be a TCP port number, got ${args[portFlag + 1]}`)
  process.exit(2)
}

// The fixture keeps its own ephemeral server; a thin proxy in front of it carries
// the fixed port and the control routes, so the fixture is never modified.
const fixture = new MockGenStudioService()

/**
 * A rename trap for the Audio page's voice picker.
 *
 * The product is published under `voxcpm2-v1` and still answers to `voxcpm2`,
 * so a saved preset or remembered form holding the superseded id exercises the
 * alias path — the one that used to leave the model unresolved, the picker
 * blank and the saved voice stranded. Opted in HERE rather than in the fixture's
 * defaults so the ~840 backend suites that share `MockGenStudioService` are
 * unaffected.
 */
fixture.ttsModels = [...fixture.ttsModels, {
  id: 'voxcpm2-v1', display_name: 'VoxCPM2', provider_id: 'vox-provider', provider_name: 'VoxProvider',
  description: 'VoxCPM2 TTS model with Khmer support.', credits_per_1000_characters: 2, minimum_credits: 2,
  maximum_input_characters: 20_000, supports_speed: true, minimum_speed: 0.5, maximum_speed: 2.0,
  supports_voice_cloning: true, preview_policy: '', generation_enabled: true,
  provider_submit_concurrency: null, controls: [], supported_languages: ['km', 'en'],
  legacy_ids: ['voxcpm2'],
}]
fixture.ttsVoicesByModel = {
  'voxcpm2-v1': [
    { id: 'yim-mengly', display_name: 'Yim Mengly', language: 'km', provider: 'VoxProvider', engine_id: 'voxcpm2-v1', engine_name: 'VoxCPM2', model_revision_id: 'v1', model_family: 'vox', voice_tier: 'standard', catalog_status: 'published', generation_enabled: true },
    { id: 'christopher', display_name: 'Christopher', language: 'en', provider: 'VoxProvider', engine_id: 'voxcpm2-v1', engine_name: 'VoxCPM2', model_revision_id: 'v1', model_family: 'vox', voice_tier: 'standard', catalog_status: 'published', generation_enabled: true },
  ],
}

await new Promise<void>((resolve, reject) => {
  fixture.server.once('error', reject)
  fixture.server.listen(0, '127.0.0.1', resolve)
})
const fixturePort = (fixture.server.address() as AddressInfo).port
const publicUrl = `http://127.0.0.1:${port}`
fixture.baseUrl = publicUrl

const readBody = async (req: http.IncomingMessage): Promise<any> => {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try { return JSON.parse(text) } catch { return {} }
}

const proxy = http.createServer((req, res) => {
  const url = req.url || '/'
  if (url.startsWith('/__control/')) {
    void (async () => {
      const json = (status: number, body: unknown) => {
        const text = JSON.stringify(body)
        res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(text)) })
        res.end(text)
      }
      if (req.method === 'POST' && url.startsWith('/__control/scenario')) {
        const body = await readBody(req)
        if (!body?.operation || !body?.scenario) return json(400, { detail: 'operation and scenario are required' })
        fixture.queueScenario(body.operation, body.scenario)
        return json(200, { ok: true, queued: body.operation })
      }
      if (req.method === 'POST' && url.startsWith('/__control/clear')) {
        const body = await readBody(req)
        fixture.clearQueuedScenarios(body?.operation)
        return json(200, { ok: true })
      }
      if (req.method === 'POST' && url.startsWith('/__control/chat-models')) {
        const body = await readBody(req)
        if (!Array.isArray(body?.models)) return json(400, { detail: 'models[] is required' })
        fixture.chatModels = body.models
        return json(200, { ok: true, models: body.models.map((row: any) => row?.id) })
      }
      if (req.method === 'GET' && url.startsWith('/__control/state')) {
        const live = fixture.submissions.filter(s => !s.replay)
        const byOp = (op: string) => live.filter(s => s.operation === op).length
        return json(200, {
          submissions: live.length,
          by_operation: {
            chat: byOp('chat'), tts: byOp('tts'), transcription: byOp('transcription'),
            image: byOp('image'), video: byOp('video'), music: byOp('music'),
          },
          credits_charged: fixture.totalCreditsCharged,
          requests: fixture.requests.map(r => `${r.method} ${r.path}`),
        })
      }
      return json(404, { detail: `unknown control route ${url}` })
    })()
    return
  }

  const upstream = http.request(
    { host: '127.0.0.1', port: fixturePort, method: req.method, path: url, headers: req.headers },
    up => {
      res.writeHead(up.statusCode || 502, up.headers)
      up.pipe(res)
    },
  )
  upstream.on('error', error => {
    res.writeHead(502, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ detail: `mock upstream failed: ${error.message}` }))
  })
  req.pipe(upstream)
})
proxy.listen(port, '127.0.0.1')
await new Promise<void>((resolve, reject) => {
  proxy.once('listening', resolve)
  proxy.once('error', reject)
})

console.log(`MOCK_GENSTUDIO_URL=${publicUrl}`)
console.log(`MOCK_GENSTUDIO_KEY=${MOCK_GENSTUDIO_FULL_KEY}`)
console.log('mock GenStudio ready — Ctrl-C to stop (nothing is charged, nothing leaves this machine)')

const stop = async () => {
  console.log('\nserve-mock-genstudio: closing')
  proxy.close()
  await fixture.close().catch(() => {})
  process.exit(0)
}
process.on('SIGINT', () => void stop())
process.on('SIGTERM', () => void stop())
