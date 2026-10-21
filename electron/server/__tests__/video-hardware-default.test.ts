/**
 * Owner, 2026-10-09: "set up the hardware encoder for video assembly." The final
 * encode ran libx264 ultrafast at about 0.9× realtime on the mini (a TerraNash
 * episode took ~1 h 56 min). With no saved encoding effort it now uses the Media
 * Engine; a saved effort is the owner's and wins; libx264 takes over by itself if
 * VideoToolbox cannot start; the length check still runs on the result.
 */
import { before, after, test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { useTempDataDir } from './_helpers.js'
import { buildFinalEncodeTiers } from '../lib/final-render-core.js'

let cleanup: () => Promise<void>
let video: typeof import('../generators/video.js')
const SOURCE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'generators', 'video.ts')

before(async () => {
  cleanup = (await useTempDataDir()).cleanup
  video = await import('../generators/video.js')
})
after(async () => { await cleanup() })

test('hardware is the default only when no effort was saved and VideoToolbox exists', () => {
  const hw = { h264: true }
  assert.equal(video.defaultEncodingEffort({}, hw), 'hardware')
  assert.equal(video.defaultEncodingEffort({ codec: 'h264', format: 'mp4' }, hw), 'hardware')
  assert.equal(video.defaultEncodingEffort({ encoding_effort: 'ultrafast' }, hw), undefined, 'a saved CPU preset is honoured')
  assert.equal(video.defaultEncodingEffort({ encoding_effort: 'slow' }, hw), undefined)
  assert.equal(video.defaultEncodingEffort({ codec: 'h265' }, hw), undefined, 'HEVC keeps libx265')
  assert.equal(video.defaultEncodingEffort({ format: 'webm' }, hw), undefined, 'WebM keeps VP9')
  assert.equal(video.defaultEncodingEffort({}, { h264: false }), undefined, 'no VideoToolbox in this FFmpeg: CPU as before')
  assert.equal(video.defaultEncodingEffort({}, undefined), undefined)
})

test('the hardware argv: videotoolbox at the quality tier\'s q:v, no silent Apple software encoder, same audio/container', () => {
  const args = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  assert.deepEqual(args, [
    '-c:v', 'h264_videotoolbox', '-q:v', String(video.crfToVideotoolboxQ(28)),
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.equal(video.crfToVideotoolboxQ(28), 50)
})

test('a failed VideoToolbox encode falls back to libx264 with the full graph, then the result is checked', async () => {
  const expectedHardware = [
    'FULL', '-c:v', 'h264_videotoolbox', '-q:v', '50',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', '2', '/schema/final.mp4',
  ]
  const expectedSoftware = [
    'FULL', '-c:v', 'libx264', '-crf', '28', '-preset', 'ultrafast',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    '-t', '2', '/schema/final.mp4',
  ]
  const tiers = buildFinalEncodeTiers({
    format: 'mp4',
    codec: 'h264',
    effort: 'hardware',
    quality: { crf: 28, preset: 'ultrafast' },
    preEncoderArgs: ['FULL'],
    videoInputPath: '/schema/base.mp4',
    premixedAudioPath: '/schema/audio.wav',
    targetDuration: 2,
    outputFile: '/schema/final.mp4',
  })
  const ran: string[][] = []
  const log: string[] = []
  let validated = 0
  let cancellationChecks = 0
  const result = await video.runEncodeTierChain(tiers, {
    run: async args => {
      ran.push(args)
      if (args.includes('h264_videotoolbox')) throw Object.assign(new Error('FFmpeg exited with code 1'), { stderr: 'Error while opening encoder: VTCompressionSessionCreate failed' })
    },
    validate: async () => { validated++ },
    log: line => log.push(line),
    logCmd: () => {},
    isCancelled: () => { cancellationChecks++; return false },
  })
  assert.equal(result.succeededTier?.label, 'H.264 · libx264 ultrafast (hardware fallback, full effects)')
  assert.deepEqual(ran, [expectedHardware, expectedSoftware], 'full args survive the hardware-to-software fallback; minimal recovery never runs')
  assert.equal(validated, 1, 'the successful software output is checked')
  assert.ok(cancellationChecks >= 2, 'cancellation is checked across fallback attempts')

  // The local composition passes its prepared values to the shared tier owner,
  // then runs exactly that result through the existing cancellation-aware chain.
  const source = await readFile(SOURCE, 'utf8')
  const sourceFile = ts.createSourceFile(SOURCE, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const composition = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'runFinalComposition')
  assert.ok(composition?.body)
  const tierCalls: ts.CallExpression[] = []
  const chainCalls: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'buildFinalEncodeTiers') tierCalls.push(node)
      if (node.expression.text === 'runEncodeTierChain') chainCalls.push(node)
    }
    ts.forEachChild(node, visit)
  }
  visit(composition.body)
  assert.equal(tierCalls.length, 1)
  assert.equal(chainCalls.length, 1)
  const tierCall = tierCalls[0]!
  assert.ok(ts.isVariableDeclaration(tierCall.parent) && tierCall.parent.name.getText(sourceFile) === 'tiers')
  const options = tierCall.arguments[0]
  assert.ok(options && ts.isObjectLiteralExpression(options))
  const wiring = Object.fromEntries(options.properties.map(property => {
    assert.ok(ts.isShorthandPropertyAssignment(property) || ts.isPropertyAssignment(property))
    return [property.name.getText(sourceFile), ts.isShorthandPropertyAssignment(property)
      ? property.name.getText(sourceFile)
      : property.initializer.getText(sourceFile)]
  }))
  assert.deepEqual(wiring, {
    format: 'format',
    codec: 'codec',
    effort: 'effort',
    quality: 'quality',
    bitrateKbps: 'videoBitrateKbps',
    preEncoderArgs: 'preEncoderArgs',
    videoInputPath: 'videoInputPath',
    premixedAudioPath: 'premixedAudioPath',
    targetDuration: 'targetDuration',
    outputFile: 'outputFile',
  })
  assert.equal(chainCalls[0]!.arguments[0]?.getText(sourceFile), 'tiers')
  assert.match(source, /if \(defaultEncodingEffort\(req, ffmpegCheck\.hw_encoders\)\) \{\s*req\.encoding_effort = 'hardware'/)

  // Post-encode verification is scoped to the compilation branch (the enclosing
  // block of the awaited runFinalComposition call), not the entire generateVideo
  // function. This catches a dropped post-encode check or an unrelated verify
  // call elsewhere satisfying the test.
  const generator = sourceFile.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === 'generateVideo')
  assert.ok(generator?.body)
  const compositionCalls: ts.CallExpression[] = []
  const visitCompositionCalls = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'runFinalComposition') {
      compositionCalls.push(node)
    }
    ts.forEachChild(node, visitCompositionCalls)
  }
  visitCompositionCalls(generator.body)
  assert.ok(compositionCalls.length >= 1, 'generateVideo contains at least one runFinalComposition call')
  const compositionCall = compositionCalls[0]!
  assert.ok(ts.isAwaitExpression(compositionCall.parent), 'runFinalComposition is awaited')
  // Walk up to find the enclosing block
  let enclosingBlock: ts.Block | undefined
  let current: ts.Node | undefined = compositionCall.parent
  while (current && !enclosingBlock) {
    if (ts.isBlock(current) && !ts.isTryStatement(current.parent)) {
      enclosingBlock = current
    }
    current = current.parent
  }
  assert.ok(enclosingBlock, 'runFinalComposition call has an enclosing block')
  const blockPostCalls: ts.CallExpression[] = []
  const visitBlockPost = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      if (node.expression.text === 'finalCheckFinalVideo' || node.expression.text === 'verifyFinalVideo') {
        blockPostCalls.push(node)
      }
    }
    ts.forEachChild(node, visitBlockPost)
  }
  visitBlockPost(enclosingBlock)
  const finalCheckCalls = blockPostCalls.filter(c => ts.isIdentifier(c.expression) && c.expression.text === 'finalCheckFinalVideo')
  const verifyCalls = blockPostCalls.filter(c => ts.isIdentifier(c.expression) && c.expression.text === 'verifyFinalVideo')
  assert.ok(finalCheckCalls.length >= 1, 'enclosing block contains finalCheckFinalVideo call')
  assert.ok(verifyCalls.length >= 1, 'enclosing block contains verifyFinalVideo call')
  const finalCheckCall = finalCheckCalls[0]!
  const verifyCall = verifyCalls[0]!
  assert.ok(ts.isAwaitExpression(finalCheckCall.parent), 'finalCheckFinalVideo is awaited')
  assert.ok(ts.isAwaitExpression(verifyCall.parent), 'verifyFinalVideo is awaited')
  assert.ok(finalCheckCall.pos > compositionCall.pos, 'finalCheckFinalVideo appears after runFinalComposition')
  assert.ok(verifyCall.pos > finalCheckCall.pos, 'verifyFinalVideo appears after finalCheckFinalVideo in the enclosing block')
  assert.deepEqual(verifyCall.arguments.map(arg => arg.getText(sourceFile)), ['job', 'compResolvedPath', 'compFinalName', 'totalRenderDuration', 'loudness'])
})

test('the job says which encoder made the video, and why software when hardware was wanted', () => {
  const hardware = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  const software = video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'ultrafast' })
  assert.equal(video.describeEncoder(hardware, true), 'Encoder: hardware (VideoToolbox h264)')
  assert.equal(video.describeEncoder(software, false), 'Encoder: software (libx264)', 'a saved CPU preset needs no excuse')
  assert.equal(
    video.describeEncoder(software, true, { message: 'FFmpeg exited with code 1', stderr: 'Error while opening encoder\nVTCompressionSessionCreate failed (-12902)\n' }),
    'Encoder: software (libx264) — hardware unavailable: VTCompressionSessionCreate failed (-12902)',
  )
  assert.equal(video.encoderKind(hardware), 'hardware (VideoToolbox h264)')
})

test('encoder reporting reads the output codec after PNG input decoder options', () => {
  const input = ['-y', '-c:v', 'png', '-i', 'frame.png']
  const software = [...input, ...video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'ultrafast' })]
  const hardware = [...input, ...video.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'hardware' })]
  assert.equal(video.encoderKind(software), 'software (libx264)')
  assert.equal(video.describeEncoder(hardware, true), 'Encoder: hardware (VideoToolbox h264)')
})

test('encoder reporting says unknown when no complete output codec follows the final input', () => {
  assert.equal(video.encoderKind(['-y', '-i', 'frame.png']), 'software (unknown)')
  assert.equal(video.encoderKind(['-y', '-c:v', 'png', '-i', 'frame.png']), 'software (unknown)')
  assert.equal(video.encoderKind(['-y', '-i', 'frame.png', '-c:v']), 'software (unknown)')
})
