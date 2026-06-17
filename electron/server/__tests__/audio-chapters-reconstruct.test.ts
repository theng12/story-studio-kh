/**
 * Reconstructing a missing audio_chapters.json from on-disk chapter audio
 * (v1.0.398). The IO wrappers need ffprobe + real files, so we test the pure
 * math core (buildReconstructedSidecar): grouping multi-part chapters, order
 * preservation, and deriving the inter-chapter gap from the merged duration.
 *
 * The lib imports chapterKeyOf/compareChapterFilenames from the audio-merge
 * generator, which pulls project-manager transitively — set the data dir first.
 */

import { test, describe, before } from 'node:test'
import assert from 'node:assert/strict'
import { useTempDataDir } from './_helpers.js'

let buildReconstructedSidecar: typeof import('../lib/audio-chapters-reconstruct.js').buildReconstructedSidecar

before(async () => {
  await useTempDataDir()
  const mod = await import('../lib/audio-chapters-reconstruct.js')
  buildReconstructedSidecar = mod.buildReconstructedSidecar
})

const SS0048 = [
  ['SS0048_Introduction.mp3', 181.394],
  ['SS0048_Chapter_01.mp3', 260.435],
  ['SS0048_Chapter_02.mp3', 244.088],
  ['SS0048_Chapter_03.mp3', 274.181],
  ['SS0048_Chapter_04.mp3', 253.330],
  ['SS0048_Chapter_05.mp3', 239.119],
  ['SS0048_Chapter_06.mp3', 255.930],
  ['SS0048_Chapter_07.mp3', 251.519],
  ['SS0048_Chapter_08.mp3', 240.373],
  ['SS0048_Chapter_09.mp3', 213.763],
  ['SS0048_Chapter_10.mp3', 201.038],
].map(([filename, duration_s]) => ({ filename: filename as string, duration_s: duration_s as number }))

describe('buildReconstructedSidecar', () => {
  test('derives the gap from the merged duration (real SS0048 numbers)', () => {
    const merged = 2674.72
    const out = buildReconstructedSidecar(SS0048, 'SS0048', merged)!
    assert.ok(out, 'sidecar built')
    assert.equal(out.sections.length, 11)
    assert.equal(out.sections[0]!.slug, 'Introduction')
    assert.equal(out.sections[1]!.slug, 'Chapter_01')
    assert.equal(out.sections[10]!.slug, 'Chapter_10')
    assert.equal(out.gap_source, 'derived')
    // (2674.72 − 2615.17) / 10 gaps ≈ 5.955
    assert.ok(Math.abs(out.gap_duration_s - 5.955) < 0.01, `gap was ${out.gap_duration_s}`)
  })

  test('groups multi-part chapters into one section summed by duration', () => {
    const files = [
      { filename: 'EP0001_Chapter_04_part1.mp3', duration_s: 100 },
      { filename: 'EP0001_Chapter_04_part2.mp3', duration_s: 50 },
    ]
    const out = buildReconstructedSidecar(files, 'EP0001')!
    assert.equal(out.sections.length, 1)
    assert.equal(out.sections[0]!.slug, 'Chapter_04')
    assert.equal(out.sections[0]!.duration_s, 150)
    assert.equal(out.sections[0]!.source_files.length, 2)
  })

  test('falls back to the 5 s default gap when no merged duration is known', () => {
    const out = buildReconstructedSidecar(SS0048, 'SS0048')!
    assert.equal(out.gap_source, 'default')
    assert.equal(out.gap_duration_s, 5)
  })

  test('clamps an absurd derived gap to the 15 s ceiling', () => {
    // merged wildly larger than the chapters → derived gap would blow up.
    const out = buildReconstructedSidecar(SS0048, 'SS0048', 999999)!
    assert.equal(out.gap_source, 'derived')
    assert.equal(out.gap_duration_s, 15)
  })

  test('returns null when there are no usable chapter files', () => {
    assert.equal(buildReconstructedSidecar([], 'SS0048'), null)
    assert.equal(buildReconstructedSidecar([{ filename: 'x.mp3', duration_s: 0 }], 'SS0048'), null)
  })
})
