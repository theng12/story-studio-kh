import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import ts from 'typescript'
import type { GenerateVideoRequest, Job } from '../models/types.js'
import type { CompositionOpts } from '../generators/video.js'
import type { FinalRenderCapabilities } from '../lib/final-render-gateway-client.js'
import { describeFinalRenderExport } from '../lib/final-render-export.js'
import { listBackgrounds, resolveBackground } from '../services/background-catalog.js'
import { isPortablePath, resolveAssetPath } from '../services/path-resolver.js'

// Run the generator's real resolution boundary without loading its render workers.
const source = ts.createSourceFile('video.ts', readFileSync(new URL('../generators/video.ts', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true)
const boundary = source.statements.find(statement => ts.isFunctionDeclaration(statement) && statement.name?.text === 'resolveAssetPathsInPlace')
assert.ok(boundary)
const compiled = ts.transpileModule(boundary.getText(source).replace(/^export /, ''), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
const resolveRequest = new Function('resolveAssetPath', 'isPortablePath', `${compiled}; return resolveAssetPathsInPlace`)(resolveAssetPath, isPortablePath) as (
  req: GenerateVideoRequest, outputRoot: string, job: Pick<Job, 'output_lines'>,
) => void

const discovery: FinalRenderCapabilities = {
  format: 'studio.render.gateway-capabilities.v1', private: true, chargeable: false,
  owner_scope: '11111111-1111-4111-8111-111111111111',
  gateway_instance_id: '22222222-2222-4222-8222-222222222222',
  story_instance_id: '33333333-3333-4333-8333-333333333333',
  eligible: 0, idle: 0, server_time: 1_797_113_600,
  profile_descriptor_utf8: '{"format":"studio.render.profile.v1","production_eligible":false}',
  profile_digest: '1'.repeat(64),
  tools: { descriptor_utf8: '{"format":"studio.render.tools.v1"}', digest: '2'.repeat(64) },
  compiler: { descriptor_utf8: '{"format":"studio.render.compiler.v1"}', digest: '3'.repeat(64) },
}

test('every catalog ID resolves at all background render inputs without channel copies', () => {
  for (const background of listBackgrounds()) {
    const req = {
      frame: { background_path: background.reference },
      title_card: { background_media_path: background.reference },
      outro_card: { background_media_path: background.reference },
      background_plate: { source_path: background.reference },
    } as GenerateVideoRequest
    const job = { output_lines: [] as string[] }
    resolveRequest(req, path.resolve('/test/channel/episodes'), job)
    const expected = resolveBackground(background.id)
    assert.equal(req.frame?.background_path, expected)
    assert.equal(req.title_card?.background_media_path, expected)
    assert.equal(req.outro_card?.background_media_path, expected)
    assert.equal(req.background_plate?.source_path, expected)
    assert.deepEqual(job.output_lines, [])
  }
})

test('an unknown chosen background fails instead of becoming None', () => {
  const req = { frame: { background_path: '${BACKGROUND}/unknown-background' } } as GenerateVideoRequest
  assert.throws(() => resolveRequest(req, path.resolve('/test/channel/episodes'), { output_lines: [] }), /background/i)
  assert.equal(req.frame?.background_path, '${BACKGROUND}/unknown-background')
})

test('a selected app background enters the existing remote frame asset contract', () => {
  for (const background of listBackgrounds()) {
    const sourcePath = resolveAssetPath(background.reference)
    const opts = {
      videoInputPath: '/schema/assets/base.mp4', premixedAudioPath: '/schema/assets/audio.wav',
      targetDuration: 2, w: 128, h: 96,
      quality: { crf: 23, preset: 'ultrafast', fps: 5 }, format: 'mp4',
      outputFile: '/schema/output/final.mp4', encodingEffort: 'ultrafast', codec: 'h264',
      frame: { enabled: true, background_path: sourcePath, inset_pct: 0.1, border_width: 0,
        corner_radius: 0, border_color: '#FFFFFF', background_color: '#000000', fit: 'cover' },
    } as CompositionOpts
    const result = describeFinalRenderExport(opts, discovery)
    assert.equal(result.kind, 'exportable')
    assert.deepEqual(result.source_requirements.find(asset => asset.logical_id === 'frame'), {
      logical_id: 'frame', role: 'frame_background', source_path: sourcePath,
    })
    assert.deepEqual(result.recipe.operations[0]?.background, {
      kind: 'asset', asset: { type: 'asset_ref', logical_id: 'frame' },
      input_mode: { kind: 'loop_still', decoder: null },
    })
  }
})
