import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

import * as encoder from '../lib/final-render-encoder.js'
import * as legacyVideo from '../generators/video.js'
import { FINAL_AAC_ARGS as legacyFinalAacArgs } from '../lib/level-audio.js'
import * as escaping from '../lib/ffmpeg-filter-escape.js'
import {
  escapeFilterArgValue as legacyEscapeFilterArgValue,
  escapeFilterPath as legacyEscapeFilterPath,
} from '../lib/ffmpeg-utils.js'

test('pure encoder module preserves the frozen encoder matrix', () => {
  assert.deepEqual(encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'medium' }), [
    '-c:v', 'libx264', '-crf', '23', '-preset', 'medium',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.deepEqual(encoder.buildEncoderArgs({ codec: 'h265', format: 'mp4', crf: 18, effort: 'slow' }), [
    '-c:v', 'libx265', '-crf', '18', '-preset', 'slow', '-tag:v', 'hvc1',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.deepEqual(encoder.buildEncoderArgs({ codec: 'h264', format: 'webm', crf: 28, effort: 'ultrafast' }), [
    '-c:v', 'libvpx-vp9', '-crf', '28', '-b:v', '0', '-c:a', 'libopus',
  ])
  assert.deepEqual(encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'hardware' }), [
    '-c:v', 'h264_videotoolbox', '-q:v', '65',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.deepEqual(encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'hardware', bitrateKbps: 2500 }), [
    '-c:v', 'h264_videotoolbox', '-b:v', '2500k', '-maxrate', '3750k', '-bufsize', '5000k',
    '-c:a', 'aac', '-b:a', '384k', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  ])
  assert.deepEqual(
    encoder.buildEncoderArgs({ codec: 'h265', format: 'mp4', crf: 23, effort: 'hardware' }),
    encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 23, effort: 'hardware' }),
  )
  assert.equal(encoder.crfToVideotoolboxQ(18), 80)
  assert.equal(encoder.crfToVideotoolboxQ(40), 25)
  assert.equal(encoder.videoBitrateCapKbps(499), 0)
  assert.equal(encoder.videoBitrateCapKbps(100_001), 100_000)
})

test('legacy video exports are the exact pure encoder and report functions', () => {
  for (const name of [
    'crfToVideotoolboxQ',
    'videoBitrateCapKbps',
    'defaultEncodingEffort',
    'encoderKind',
    'describeEncoder',
    'buildEncoderArgs',
  ] as const) {
    assert.strictEqual(legacyVideo[name], encoder[name], name)
  }

  const hardware = encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'hardware' })
  const software = encoder.buildEncoderArgs({ codec: 'h264', format: 'mp4', crf: 28, effort: 'ultrafast' })
  assert.equal(legacyVideo.defaultEncodingEffort({}, { h264: true }), 'hardware')
  assert.equal(legacyVideo.defaultEncodingEffort({ encoding_effort: 'slow' }, { h264: true }), undefined)
  assert.equal(legacyVideo.defaultEncodingEffort({ codec: 'h265' }, { h264: true }), undefined)
  assert.equal(legacyVideo.defaultEncodingEffort({ format: 'webm' }, { h264: true }), undefined)
  assert.equal(legacyVideo.defaultEncodingEffort({}, { h264: false }), undefined)
  assert.equal(legacyVideo.encoderKind(hardware), 'hardware (VideoToolbox h264)')
  assert.equal(legacyVideo.describeEncoder(software, false), 'Encoder: software (libx264)')
  assert.equal(
    legacyVideo.describeEncoder(software, true, { stderr: 'first line\nVTCompressionSessionCreate failed (-12902)\n' }),
    'Encoder: software (libx264) — hardware unavailable: VTCompressionSessionCreate failed (-12902)',
  )
})

test('level-audio re-exports the one final AAC array', () => {
  assert.strictEqual(legacyFinalAacArgs, encoder.FINAL_AAC_ARGS)
  assert.deepEqual(legacyFinalAacArgs, ['-c:a', 'aac', '-b:a', '384k'])
})

test('pure escaping module preserves two-pass values and legacy exports', () => {
  assert.strictEqual(legacyEscapeFilterArgValue, escaping.escapeFilterArgValue)
  assert.strictEqual(legacyEscapeFilterPath, escaping.escapeFilterPath)
  assert.equal(escaping.escapeFilterArgValue('Constantinople 542'), 'Constantinople 542')
  assert.equal(escaping.escapeFilterArgValue("'"), String.raw`\\\'`)
  assert.equal(escaping.escapeFilterArgValue(':'), String.raw`\\:`)
  assert.equal(escaping.escapeFilterArgValue(','), String.raw`\,`)
  assert.equal(escaping.escapeFilterArgValue('['), String.raw`\[`)
  assert.equal(escaping.escapeFilterArgValue(']'), String.raw`\]`)
  assert.equal(escaping.escapeFilterArgValue(';'), String.raw`\;`)
  assert.equal(escaping.escapeFilterArgValue('\\'), String.raw`\\\\`)
  assert.equal(escaping.escapeFilterArgValue('Title\nSubtitle'), 'Title\nSubtitle')
  assert.equal(escaping.escapeFilterPath(String.raw`C:\Users\kh\subs.srt`), String.raw`C\\:/Users/kh/subs.srt`)
})

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function hasRuntimeImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some(element => !element.isTypeOnly)
}

function hasRuntimeExport(node: ts.ExportDeclaration): boolean {
  if (node.isTypeOnly) return false
  if (!node.exportClause || ts.isNamespaceExport(node.exportClause)) return true
  return node.exportClause.elements.some(element => !element.isTypeOnly)
}

function resolvedRuntimeImports(relativeFile: string): string[] {
  const absoluteFile = path.join(SERVER_ROOT, relativeFile)
  const source = ts.createSourceFile(
    absoluteFile,
    readFileSync(absoluteFile, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  )
  const specifiers = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        && hasRuntimeImport(statement.importClause)) {
      specifiers.add(statement.moduleSpecifier.text)
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier) && hasRuntimeExport(statement)) {
      specifiers.add(statement.moduleSpecifier.text)
    }
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      specifiers.add(argument && ts.isStringLiteral(argument) ? argument.text : '<dynamic>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)

  return [...specifiers].map(specifier => {
    if (!specifier.startsWith('.')) return `external:${specifier}`
    const resolved = path.resolve(path.dirname(absoluteFile), specifier.replace(/\.js$/, '.ts'))
    return path.relative(SERVER_ROOT, resolved)
  }).sort()
}

test('extracted modules and the reusable effects closure have only reviewed runtime dependencies', () => {
  const expected = new Map<string, string[]>([
    ['lib/final-render-encoder.ts', []],
    ['lib/ffmpeg-filter-escape.ts', []],
    ['lib/video-effects.ts', ['lib/color-grade.ts', 'lib/scene-effect-compiler.ts']],
    ['lib/scene-effect-compiler.ts', [
      'contracts/effect-loops.ts',
      'contracts/scene-effects.ts',
      'lib/color-grade.ts',
      'lib/ffmpeg-filter-escape.ts',
    ]],
    ['lib/color-grade.ts', ['contracts/scene-effects.ts', 'lib/grade-balance.ts']],
    ['contracts/scene-effects.ts', ['contracts/effect-loops.ts', 'lib/well-formed-text.ts']],
    ['contracts/effect-loops.ts', []],
    ['lib/grade-balance.ts', []],
    ['lib/well-formed-text.ts', []],
    ['lib/video-frame-filter.ts', []],
  ])
  for (const [file, dependencies] of expected) {
    assert.deepEqual(resolvedRuntimeImports(file), dependencies, file)
  }
})
