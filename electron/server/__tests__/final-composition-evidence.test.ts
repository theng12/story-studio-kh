import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'

import {
  F2CaseOwner,
  classifyFontSelectionReport,
  runBoundedChild,
  type F2NativePhase,
} from './fixtures/final-composition-evidence.js'

function fakeChild(options: { closeAfterMs?: number, ignoreTerm?: boolean } = {}) {
  const emitter = new EventEmitter()
  const stdout = new PassThrough()
  const stderr = new PassThrough()
  const kills: string[] = []
  const child = Object.assign(emitter, {
    exitCode: null as number | null,
    signalCode: null as string | null,
    stdout,
    stderr,
    kill(signal: 'SIGTERM' | 'SIGKILL') {
      kills.push(signal)
      if (signal === 'SIGKILL' || !options.ignoreTerm) {
        queueMicrotask(() => {
          child.signalCode = signal
          emitter.emit('close', null, signal)
        })
      }
      return true
    },
  })
  if (options.closeAfterMs !== undefined) {
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        child.exitCode = 0
        emitter.emit('close', 0, null)
      }
    }, options.closeAfterMs)
  }
  return { child, kills }
}

test('font evidence retains a resolved base face and unresolved Khmer fallback', () => {
  const fallback = '[Parsed_ass_0 @ 0x100] Glyph 0x1780 not found, selecting one more font for (Helvetica, 400, 0)'
  const unresolved = '[Parsed_ass_0 @ 0x100] fontselect: (Helvetica, 400, 0) -> Khmer MN, 0, Khmer MN'
  const evidence = classifyFontSelectionReport([
    '[Parsed_ass_0 @ 0x100] Using font provider fontconfig',
    '[Parsed_ass_0 @ 0x100] fontselect: (Helvetica, 400, 0) -> /System/Library/Fonts/Helvetica.ttc, 0, Helvetica',
    fallback,
    unresolved,
  ].join('\n'))

  assert.equal(evidence.complete, false)
  assert.equal(evidence.glyph_warning_present, true)
  assert.deepEqual(evidence.events.filter(event => event.status === 'unresolved').map(event => ({
    filter_id: event.filter_id,
    raw_line: event.raw_line,
  })), [
    { filter_id: 'Parsed_ass_0', raw_line: fallback },
    { filter_id: 'Parsed_ass_0', raw_line: unresolved },
  ])
})

test('font evidence is complete when every relevant selection is resolved', () => {
  const evidence = classifyFontSelectionReport([
    '[Parsed_ass_0 @ 0x100] Using font provider fontconfig',
    '[Parsed_ass_0 @ 0x100] fontselect: (Helvetica, 400, 0) -> /Library/Fonts/Helvetica.ttf',
    '[Parsed_drawtext_2 @ 0x200] Using "/Library/Fonts/Arial.ttf"',
  ].join('\n'))

  assert.equal(evidence.complete, true)
  assert.equal(evidence.glyph_warning_present, false)
  assert.deepEqual(evidence.events.map(event => [event.renderer, event.filter_id, event.status]), [
    ['ass', 'Parsed_ass_0', 'resolved'],
    ['drawtext', 'Parsed_drawtext_2', 'resolved'],
  ])
})

test('font evidence retains an unresolved drawtext filter beside a resolved filter', () => {
  const unresolved = '[Parsed_drawtext_3 @ 0x300] Using font family "Helvetica"'
  const evidence = classifyFontSelectionReport([
    '[Parsed_drawtext_2 @ 0x200] Using "/Library/Fonts/Arial.ttf"',
    unresolved,
  ].join('\n'))

  assert.equal(evidence.complete, false)
  assert.deepEqual(evidence.events.at(-1), {
    renderer: 'drawtext', filter_id: 'Parsed_drawtext_3', raw_line: unresolved,
    status: 'unresolved', requested: 'Helvetica', path: null,
    collection_index: null, face: null,
  })
})

test('a TTC path without a reported face and collection index remains unresolved', () => {
  const rawLine = '[Parsed_ass_0 @ 0x100] fontselect: (Helvetica, 400, 0) -> /System/Library/Fonts/Helvetica.ttc'
  const evidence = classifyFontSelectionReport(rawLine)

  assert.equal(evidence.complete, false)
  assert.deepEqual(evidence.events, [{
    renderer: 'ass', filter_id: 'Parsed_ass_0', raw_line: rawLine,
    status: 'unresolved', requested: 'Helvetica, 400, 0',
    path: '/System/Library/Fonts/Helvetica.ttc', collection_index: null, face: null,
  }])
})

test('retained CoreText trace preserves negative indices, fallback warning, and five incomplete drawtext bindings', () => {
  const evidence = classifyFontSelectionReport([
    '[Parsed_ass_1 @ 0x1302057a0] Using font provider coretext',
    '[Parsed_ass_1 @ 0x1302057a0] fontselect: (Helvetica, 400, 0) -> /System/Library/Fonts/Helvetica.ttc, -1, Helvetica',
    '[Parsed_ass_1 @ 0x1302057a0] Glyph 0x1796 not found, selecting one more font for (Helvetica, 400, 0)',
    '[Parsed_ass_1 @ 0x1302057a0] fontselect: (Helvetica, 400, 0) -> /System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf, -1, KhmerSangamMN',
    '[Parsed_drawtext_2 @ 0x130205a70] Using "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"',
    '[Parsed_drawtext_3 @ 0x130205bb0] Using "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"',
    '[Parsed_drawtext_4 @ 0x130205da0] Using "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"',
    '[Parsed_drawtext_5 @ 0x130205f40] Using "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"',
    '[Parsed_drawtext_6 @ 0x130206130] Using "/System/Library/Fonts/ヒラギノ丸ゴ ProN W4.ttc"',
  ].join('\n'))

  assert.equal(evidence.complete, false)
  assert.equal(evidence.glyph_warning_present, true)
  assert.deepEqual(evidence.events.filter(event => event.raw_line.includes('fontselect:')).map(event => ({
    path: event.path,
    collection_index: event.collection_index,
    face: event.face,
    status: event.status,
  })), [
    { path: '/System/Library/Fonts/Helvetica.ttc', collection_index: -1, face: 'Helvetica', status: 'unresolved' },
    { path: '/System/Library/Fonts/Supplemental/Khmer Sangam MN.ttf', collection_index: -1, face: 'KhmerSangamMN', status: 'unresolved' },
  ])
  const drawtext = evidence.events.filter(event => event.renderer === 'drawtext')
  assert.deepEqual(drawtext.map(event => event.filter_id), [
    'Parsed_drawtext_2', 'Parsed_drawtext_3', 'Parsed_drawtext_4', 'Parsed_drawtext_5', 'Parsed_drawtext_6',
  ])
  assert.equal(drawtext.every(event => event.status === 'unresolved'
    && event.collection_index === null && event.face === null), true)
})

test('an already-aborted F2 owner refuses preparation without launching a child', async () => {
  const controller = new AbortController()
  controller.abort()
  const owner = new F2CaseOwner(controller.signal)
  let launches = 0

  await assert.rejects(runBoundedChild(owner, 'source_encode', () => {
    launches += 1
    const fixture = fakeChild({ closeAfterMs: 0 })
    return fixture.child
  }, { timeoutMs: 20, killGraceMs: 5 }), /refused|aborted/i)
  assert.equal(launches, 0)
  assert.equal(owner.counts.source_encode, 0)
  await owner.settle()
})

test('abort while awaiting font evidence settles the body before restoration and refuses the probe', async () => {
  const controller = new AbortController()
  const owner = new F2CaseOwner(controller.signal)
  let releaseEvidence!: () => void
  const evidence = new Promise<void>(resolve => { releaseEvidence = resolve })
  let laterLaunch = 0
  const body = owner.track((async () => {
    await evidence
    owner.assertCanLaunch('output probe')
    owner.begin('output_probe')
    laterLaunch += 1
  })())

  controller.abort()
  let settled = false
  const settlement = owner.settle().then(() => { settled = true })
  await Promise.resolve()
  assert.equal(settled, false, 'restoration waits for the owned body')
  releaseEvidence()
  await assert.rejects(body, /refused|aborted/i)
  await settlement
  assert.equal(laterLaunch, 0)
  assert.equal(owner.counts.output_probe, 0)
})

test('source and probe timeouts stop their fake child, settle, and refuse later launches', async () => {
  for (const phase of ['source_encode', 'source_probe'] as F2NativePhase[]) {
    const owner = new F2CaseOwner(new AbortController().signal)
    const fixture = fakeChild({ closeAfterMs: 30, ignoreTerm: true })
    await assert.rejects(runBoundedChild(owner, phase, () => fixture.child, {
      timeoutMs: 2, killGraceMs: 2,
    }), /timed out/i)
    await owner.settle()
    assert.deepEqual(fixture.kills, ['SIGTERM', 'SIGKILL'])
    assert.throws(() => owner.begin('output_probe'), /refused|closed|aborted/i)
    assert.equal(owner.counts[phase], 1)
    assert.equal(owner.counts.output_probe, 0)
  }
})

test('a final-child failure closes the owner and refuses the output probe', async () => {
  const owner = new F2CaseOwner(new AbortController().signal)
  owner.begin('final_encode')
  await assert.rejects(owner.track(Promise.reject(new Error('final child failed'))), /final child failed/)
  assert.throws(() => owner.begin('output_probe'), /refused|closed|aborted/i)
  await owner.settle()
  assert.deepEqual(owner.counts, {
    source_encode: 0, source_probe: 0, final_encode: 1, output_probe: 0,
  })
})
