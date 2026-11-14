import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import test from 'node:test'

import { ChartSpecValidationError, describeChart, parseChartSpec } from '../contracts/chart-spec.js'
import { buildChartSvg, renderChartPng } from '../services/chart-render.js'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

function pngSize(png: Buffer): { width: number; height: number } {
  assert.ok(png.length >= 24, 'PNG too short for an IHDR')
  assert.ok(png.subarray(0, 8).equals(PNG_SIGNATURE), 'missing PNG signature')
  // IHDR is always the first chunk: width at byte 16, height at byte 20.
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }
}

const BAR = {
  kind: 'bar' as const,
  title: 'Scene coverage',
  labels: ['Jan', 'Feb', 'Mar', 'Apr'],
  values: [42, 61, 82, 55],
}
const LINE = {
  kind: 'line' as const,
  title: 'Retention',
  labels: ['Ep1', 'Ep2', 'Ep3', 'Ep4'],
  values: [12, 30, 27, 44],
}
const PIE = {
  kind: 'pie' as const,
  title: 'Runtime split',
  labels: ['A', 'B', 'C'],
  values: [50, 30, 20],
}

test('bar, line and pie render as PNG with the requested IHDR size', async () => {
  for (const spec of [BAR, LINE, PIE]) {
    const { png, width, height, summary } = await renderChartPng(spec)
    const size = pngSize(png)
    assert.equal(size.width, 1280, `${spec.kind} default width`)
    assert.equal(size.height, 720, `${spec.kind} default height`)
    assert.equal(width, 1280)
    assert.equal(height, 720)
    assert.match(summary, /^Bar chart, 4 values/)
  }

  const custom = await renderChartPng({ ...BAR, width: 640, height: 400 })
  const size = pngSize(custom.png)
  assert.equal(size.width, 640)
  assert.equal(size.height, 400)
  assert.equal(custom.width, 640)
  assert.equal(custom.height, 400)
})

test('identical spec produces a byte-identical PNG', async () => {
  const first = await renderChartPng(BAR)
  const second = await renderChartPng({ ...BAR })
  assert.ok(first.png.equals(second.png), 'same spec must rasterise to the same bytes')
})

test('bad input is refused with the typed error', () => {
  const bad: unknown[] = [
    null,
    'bar',
    { kind: 'scatter', labels: ['a'], values: [1] },
    { kind: 'bar', labels: [], values: [] },
    { kind: 'bar', labels: ['a', 'b'], values: [1] },
    { kind: 'bar', labels: ['a'], values: [Number.NaN] },
    { kind: 'bar', labels: ['a'], values: [Infinity] },
    { kind: 'bar', labels: [''], values: [1] },
    { kind: 'bar', labels: ['a'], values: [1], width: 10 },
    { kind: 'pie', labels: ['a', 'b'], values: [-1, 2] },
    { kind: 'pie', labels: ['a', 'b'], values: [0, 0] },
    { kind: 'bar', labels: Array.from({ length: 65 }, (_, i) => `l${i}`), values: Array.from({ length: 65 }, () => 1) },
    { kind: 'bar', labels: ['x'.repeat(161)], values: [1] },
  ]
  for (const value of bad) {
    assert.throws(() => parseChartSpec(value), ChartSpecValidationError, `should refuse ${JSON.stringify(value)?.slice(0, 60)}`)
  }
  // The renderer validates on the way in too, not only the contract helper.
  assert.throws(() => buildChartSvg({ kind: 'bar', labels: [], values: [] } as never), ChartSpecValidationError)
})

test('over-long labels are truncated with an ellipsis and still render', async () => {
  const long = 'A tremendously long category label that cannot possibly fit its slot'
  const spec = {
    kind: 'bar' as const,
    labels: [long, 'Short', 'Mid-length label here', 'Another very long category label indeed'],
    values: [10, 20, 30, 40],
    width: 640,
    height: 400,
  }
  const svg = buildChartSvg(spec)
  assert.ok(svg.includes('…'), 'truncated labels carry an ellipsis')
  assert.ok(!svg.includes(long), 'the full over-long label is not painted into the chart')
  assert.ok(svg.length > 0)

  const { png, width, height, summary } = await renderChartPng(spec)
  const size = pngSize(png)
  assert.equal(size.width, width)
  assert.equal(size.height, height)
  // The summary keeps the complete label for alt text.
  assert.ok(summary.includes(long), 'summary keeps the full label')
  assert.equal(summary, describeChart(parseChartSpec(spec)))
})

test('chart segment summary is plain and names highest and lowest', () => {
  assert.equal(
    describeChart(parseChartSpec({ kind: 'bar', labels: ['March', 'May'], values: [82, 11] })),
    'Bar chart, 2 values; highest 82 in March; lowest 11 in May',
  )
  assert.match(describeChart(parseChartSpec(PIE)), /^Pie chart, 3 values; highest 50 in A \(50%\); lowest 20 in C \(20%\)$/)
})

test('zero-credit path: the renderer imports no Gateway or client module', async () => {
  const chartRender = await fs.readFile(new URL('../services/chart-render.ts', import.meta.url), 'utf8')
  const chartSpec = await fs.readFile(new URL('../contracts/chart-spec.ts', import.meta.url), 'utf8')
  for (const [name, source] of [['chart-render.ts', chartRender], ['chart-spec.ts', chartSpec]] as const) {
    assert.doesNotMatch(
      source,
      /from ['"][^'"]*(gateway|genstudio|ai-client|openrouter|openai|client)['"]/i,
      `${name} must not import a Gateway/client module`,
    )
    // The SVG xmlns is a namespace string, not a request: only calls and key lookups count.
    assert.doesNotMatch(source, /getApiKey|\bfetch\s*\(/, `${name} must not reach the network`)
  }
  // chart-spec is pure data + validation; sharp belongs to the renderer alone.
  assert.doesNotMatch(chartSpec, /from ['"]sharp['"]/, 'the contract must not depend on sharp')
  assert.match(chartRender, /from 'sharp'/, 'the renderer rasterises with the installed sharp')
})
