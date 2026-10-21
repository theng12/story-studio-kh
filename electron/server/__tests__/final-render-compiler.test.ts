import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import ts from 'typescript'

import { buildFinalLogoFilters } from '../lib/final-render-core.js'
import {
  compileFinalRenderPacket,
  UnsupportedFinalRenderCombination,
} from '../lib/final-render-compiler.js'

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url))
const SERVER_ROOT = path.resolve(TEST_DIR, '..')
const fixture = JSON.parse(readFileSync(path.join(TEST_DIR, 'fixtures/final-render-compiler-v1.json'), 'utf8')) as any

function localAssets(value: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(value))
}

function compileVector(vector: any) {
  const packet = structuredClone(vector.packet)
  const before = JSON.stringify(packet)
  const assets = localAssets(vector.local_assets ?? {
    base: fixture.paths.local_assets.base,
    audio: fixture.paths.local_assets.audio,
  })
  const result = compileFinalRenderPacket(packet, assets, vector.output_path ?? fixture.paths.output)
  assert.equal(JSON.stringify(packet), before, 'compilation must not mutate its packet')
  assert.deepEqual([...assets], [...localAssets(vector.local_assets ?? {
    base: fixture.paths.local_assets.base,
    audio: fixture.paths.local_assets.audio,
  })], 'compilation must not mutate its asset map')
  return result
}

function graph(argv: readonly string[]): string {
  const index = argv.indexOf('-filter_complex')
  assert.notEqual(index, -1, 'full tier must carry the final filter graph')
  return argv[index + 1]!
}

function tierView(tier: any): Record<string, unknown> {
  const result: Record<string, unknown> = { label: tier.label }
  if (tier.note !== undefined) result.note = tier.note
  if (tier.degraded !== undefined) result.degraded = tier.degraded
  if (tier.dropsBurnedInFeatures !== undefined) result.drops_burned_in_features = tier.dropsBurnedInFeatures
  result.argv = tier.build()
  return result
}

test('compiler fixture is schema-only derived evidence with a frozen historical source', () => {
  assert.equal(fixture.schema_test_only, true)
  assert.equal(fixture.qualification, 'none')
  assert.equal(fixture.source.story_base, '5283a0ccc50e9f52a0205a1278e549c584331465')
  assert.match(fixture.source.derivation, /not a historical no-font render or output\/hardware\/profile\/file-byte qualification/)
  const oldGolden = readFileSync(path.join(TEST_DIR, 'fixtures/final-composition-argv-v1.json'))
  assert.equal(createHash('sha256').update(oldGolden).digest('hex'), fixture.source.historical_golden_sha256)
})

test('F0 base/audio compiles to the literal historical graph and full/minimal argv', () => {
  const vector = fixture.f0_base_audio
  const result = compileVector(vector)
  assert.deepEqual(result.inputUses, vector.expected_input_uses)
  assert.deepEqual(result.requestedBurnIns, vector.expected_requested_burn_ins)
  assert.equal(result.tiers.length, 4)
  assert.equal(graph(result.tiers[0].build()), vector.expected_graph)
  assert.deepEqual(result.tiers[0].build(), vector.expected_full_argv)
  assert.deepEqual(result.tiers[3].build(), vector.expected_minimal_argv)
})

test('F1-derived no-font case preserves literal input order, graph labels, burn-ins and argv', () => {
  const vector = fixture.f1_derived_no_font
  const result = compileVector(vector)
  assert.deepEqual(result.inputUses, vector.expected_input_uses)
  assert.deepEqual(result.requestedBurnIns, vector.expected_requested_burn_ins)
  assert.equal(graph(result.tiers[0].build()), vector.expected_graph)
  assert.deepEqual(result.tiers[0].build(), vector.expected_full_argv)
  assert.deepEqual(result.tiers[3].build(), vector.expected_minimal_argv)
  assert.equal(vector.expected_graph.includes('ass='), false)
  assert.equal(vector.expected_graph.includes('drawtext='), false)
  assert.match(vector.expected_graph, /\[v20\]\[logo\]overlay=4:4:enable='between\(t,0\.25,1\.75\)'\[v21\];\n\[v21\]null\[vout\]$/)
})

test('input order and repeated references preserve explicit modes and literal overlay formulas', () => {
  const vector = fixture.overlay_input_and_formula_vector
  const result = compileVector(vector)
  assert.deepEqual(result.inputUses, vector.expected_input_uses)
  assert.equal(graph(result.tiers[0].build()), vector.expected_graph)
  assert.deepEqual(result.tiers[0].build(), vector.expected_full_argv)
  assert.deepEqual(result.inputUses.filter((use: any) => use.logicalId === 'overlay').map((use: any) => use.index), [2, 3, 4, 5])
})

test('a present zero-start/null-end overlay range emits no enable term', () => {
  const vector = fixture.zero_start_null_end_overlay_vector
  const result = compileVector(vector)
  const actualGraph = graph(result.tiers[0].build())
  assert.deepEqual(result.inputUses, vector.expected_input_uses)
  assert.equal(actualGraph, vector.expected_graph)
  assert.deepEqual(result.tiers[0].build(), vector.expected_full_argv)
  assert.deepEqual(vector.packet.recipe.operations[0].time_range, { start_sec: 0, end_sec: null })
  assert.equal(actualGraph.includes(':enable='), false)
})

test('repeated overlays compile by occurrence when plain input objects are aliased', () => {
  const vector = fixture.aliased_repeated_overlay_vector
  const distinct = compileVector(vector)
  assert.deepEqual(distinct.inputUses, vector.expected_input_uses)
  assert.equal(graph(distinct.tiers[0].build()), vector.expected_graph)
  assert.deepEqual(distinct.tiers[0].build(), vector.expected_full_argv)

  const packet = structuredClone(vector.packet)
  packet.recipe.operations[1] = packet.recipe.operations[0]
  const aliased = compileFinalRenderPacket(
    packet,
    localAssets(vector.local_assets),
    vector.output_path,
  )
  assert.deepEqual(aliased.inputUses, vector.expected_input_uses)
  assert.equal(graph(aliased.tiers[0].build()), vector.expected_graph)
  assert.deepEqual(aliased.tiers[0].build(), vector.expected_full_argv)
  assert.deepEqual(aliased.inputUses, distinct.inputUses)
  assert.deepEqual(aliased.tiers[0].build(), distinct.tiers[0].build())
})

test('all global gate branches retain their frozen precision and strictness', () => {
  for (const vector of fixture.gate_vectors) {
    const result = compileVector(vector)
    assert.equal(graph(result.tiers[0].build()), vector.expected_graph, vector.name)
  }
})

test('fractional frame controls round only after height scaling', () => {
  for (const vector of fixture.fractional_frame_vectors) {
    const result = compileVector(vector)
    assert.equal(graph(result.tiers[0].build()), vector.expected_graph, vector.name)
  }
  assert.match(fixture.fractional_frame_vectors[0].expected_graph, /overlay=23:23/)
  assert.match(fixture.fractional_frame_vectors[0].expected_graph, /lt\(X,10\)/)
  assert.match(fixture.fractional_frame_vectors[1].expected_graph, /overlay=55:55/)
  assert.match(fixture.fractional_frame_vectors[1].expected_graph, /lt\(X,21\)/)
})

test('logo gates and nonzero private margins remain source-compatible', () => {
  for (const vector of fixture.logo_vectors) {
    const result = compileFinalRenderPacket(
      structuredClone(vector.packet),
      localAssets({
        base: fixture.paths.local_assets.base,
        audio: fixture.paths.local_assets.audio,
        logo: fixture.paths.local_assets.logo,
      }),
      fixture.paths.output,
    )
    assert.equal(graph(result.tiers[0].build()), vector.expected_graph, vector.name)
  }
})

test('zero logo margin is refused privately while the shared local helper keeps legacy zero to twenty', () => {
  const zero = fixture.unsupported_vectors.find((vector: any) => vector.name === 'zero-logo-margin')
  assert.throws(
    () => compileFinalRenderPacket(
      structuredClone(zero.packet),
      localAssets({
        base: fixture.paths.local_assets.base,
        audio: fixture.paths.local_assets.audio,
        logo: fixture.paths.local_assets.logo,
      }),
      fixture.paths.output,
    ),
    (error: unknown) => error instanceof UnsupportedFinalRenderCombination
      && error.reason === 'logo_margin_default',
  )

  const vector = fixture.local_legacy_logo_zero
  let index = 1
  const actual = buildFinalLogoFilters(
    { input: vector.input, allocLabel: () => `[v${index++}]` },
    vector.logo,
    vector.input_index,
    vector.width,
    vector.height,
    '',
  )
  assert.deepEqual(actual, vector.expected)
})

test('unsupported letterbox and logo gate combinations refuse the whole compilation', () => {
  for (const vector of fixture.unsupported_vectors.filter((item: any) => item.name !== 'zero-logo-margin')) {
    const needsLogo = vector.packet.manifest.some((entry: any) => entry.role === 'logo')
    const assets: Record<string, string> = {
      base: fixture.paths.local_assets.base,
      audio: fixture.paths.local_assets.audio,
    }
    if (needsLogo) assets.logo = fixture.paths.local_assets.logo
    assert.throws(
      () => compileFinalRenderPacket(structuredClone(vector.packet), localAssets(assets), fixture.paths.output),
      (error: unknown) => error instanceof UnsupportedFinalRenderCombination
        && error.reason === vector.reason,
      vector.name,
    )
  }
})

test('tier plan preserves requested, full CPU, libx265 -22 and minimal definitions', () => {
  const matching = { stderr: 'encoder libx265 failed with return code -22' }
  const withoutLibx265 = { stderr: 'encoder failed with return code -22' }
  const withoutCode = { stderr: 'libx265 encoder failed' }
  for (const vector of fixture.tier_vectors) {
    const result = compileVector(vector)
    assert.equal(result.tiers.length, 4, vector.name)
    assert.deepEqual(result.tiers.map(tierView), vector.expected_tiers, vector.name)
    assert.equal(result.tiers[1].shouldRun?.({}), vector.expected_predicates.hardware_fallback, `${vector.name}: hardware predicate`)
    assert.equal(result.tiers[2].shouldRun?.(matching), vector.expected_predicates.h265_matching_error, `${vector.name}: h265 matching predicate`)
    assert.equal(result.tiers[2].shouldRun?.(withoutLibx265), vector.expected_predicates.h265_missing_libx265, `${vector.name}: h265 libx265 predicate`)
    assert.equal(result.tiers[2].shouldRun?.(withoutCode), vector.expected_predicates.h265_missing_return_code, `${vector.name}: h265 code predicate`)
    assert.equal(result.tiers[2].shouldRun?.({}), vector.expected_predicates.h265_empty_error, `${vector.name}: h265 empty predicate`)
    for (const tier of result.tiers) {
      const first = tier.build()
      const second = tier.build()
      assert.notStrictEqual(first, second, `${vector.name}: build returns a fresh array`)
      assert.deepEqual(first, second, `${vector.name}: fresh arrays preserve content`)
      first.push('mutation-probe')
      assert.equal(tier.build().includes('mutation-probe'), false, `${vector.name}: prior result is not retained`)
    }
  }
})

test('closed adapter refuses invalid/local-only bindings before it can emit argv', () => {
  const vector = fixture.f0_base_audio
  const packet = structuredClone(vector.packet)
  const before = JSON.stringify(packet)
  const invalidAssetBindings: Record<string, string>[] = [
    { base: fixture.paths.local_assets.base },
    { base: fixture.paths.local_assets.base, audio: fixture.paths.local_assets.audio, extra: '/schema/assets/extra.png' },
    { base: fixture.paths.local_assets.base, audio: '' },
    { base: fixture.paths.local_assets.base, audio: '/schema/assets/audio\0.wav' },
  ]
  for (const assets of invalidAssetBindings) {
    assert.throws(() => compileFinalRenderPacket(packet, localAssets(assets), fixture.paths.output))
  }
  assert.throws(() => compileFinalRenderPacket(packet, localAssets(vector.local_assets), ''))
  assert.throws(() => compileFinalRenderPacket(packet, localAssets(vector.local_assets), '/schema/output/final\0.mp4'))

  const unknown = structuredClone(packet)
  unknown.recipe.operations.push({ kind: 'unknown_effect' })
  assert.throws(
    () => compileFinalRenderPacket(unknown, localAssets(vector.local_assets), fixture.paths.output),
    /Invalid render packet: recipe\.operations\[0\]\.kind is unsupported/,
  )
  assert.equal(JSON.stringify(packet), before)
})

function hasRuntimeImport(clause: ts.ImportClause | undefined): boolean {
  if (!clause) return true
  if (clause.isTypeOnly) return false
  if (clause.name) return true
  const bindings = clause.namedBindings
  if (!bindings) return false
  if (ts.isNamespaceImport(bindings)) return true
  return bindings.elements.some(element => !element.isTypeOnly)
}

function runtimeSpecifiers(relativeFile: string): string[] {
  const absolute = path.join(SERVER_ROOT, relativeFile)
  const source = ts.createSourceFile(absolute, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const result = new Set<string>()
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)
        && hasRuntimeImport(statement.importClause)) result.add(statement.moduleSpecifier.text)
    if (ts.isExportDeclaration(statement) && !statement.isTypeOnly && statement.moduleSpecifier
        && ts.isStringLiteral(statement.moduleSpecifier)) result.add(statement.moduleSpecifier.text)
  }
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const argument = node.arguments[0]
      result.add(argument && ts.isStringLiteral(argument) ? argument.text : '<dynamic>')
    }
    ts.forEachChild(node, visit)
  }
  visit(source)
  return [...result].sort()
}

function resolveLocal(from: string, specifier: string): string {
  return path.relative(SERVER_ROOT, path.resolve(path.dirname(path.join(SERVER_ROOT, from)), specifier.replace(/\.js$/, '.ts')))
}

function namedFunction(source: ts.SourceFile, name: string): ts.FunctionDeclaration {
  const found = source.statements.find((statement): statement is ts.FunctionDeclaration =>
    ts.isFunctionDeclaration(statement) && statement.name?.text === name)
  assert.ok(found?.body, `missing function body: ${name}`)
  return found
}

function directCalls(root: ts.Node): Set<string> {
  const calls = new Set<string>()
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) calls.add(node.expression.text)
    ts.forEachChild(node, visit)
  }
  visit(root)
  return calls
}

test('compiler/core closure is pure and local video has one implementation of moved formulas', () => {
  const allowed = new Set([
    'lib/final-render-core.ts', 'lib/final-render-compiler.ts', 'lib/final-render-encoder.ts',
    'lib/final-render-recipe.ts', 'lib/render-hash-v1.ts', 'lib/video-effects.ts',
    'lib/video-frame-filter.ts', 'lib/color-grade.ts', 'lib/scene-effect-compiler.ts',
    'lib/grade-balance.ts', 'lib/ffmpeg-filter-escape.ts', 'lib/well-formed-text.ts',
    'contracts/scene-effects.ts', 'contracts/effect-loops.ts',
  ])
  const external = new Set(['node:crypto', 'node:util'])
  const pending = ['lib/final-render-core.ts', 'lib/final-render-compiler.ts']
  const seen = new Set<string>()
  while (pending.length) {
    const file = pending.pop()!
    if (seen.has(file)) continue
    seen.add(file)
    assert.ok(allowed.has(file), `unreviewed compiler dependency: ${file}`)
    for (const specifier of runtimeSpecifiers(file)) {
      assert.notEqual(specifier, '<dynamic>', `${file} must not use dynamic imports`)
      if (!specifier.startsWith('.')) {
        assert.ok(external.has(specifier), `unreviewed external compiler dependency: ${file} -> ${specifier}`)
        continue
      }
      const dependency = resolveLocal(file, specifier)
      assert.ok(allowed.has(dependency), `unreviewed compiler dependency: ${file} -> ${dependency}`)
      pending.push(dependency)
    }
  }
  assert.ok(seen.has('lib/final-render-encoder.ts'))
  assert.ok(seen.has('lib/final-render-recipe.ts'))
  assert.ok(seen.has('lib/render-hash-v1.ts'))
  assert.ok(seen.has('lib/video-frame-filter.ts'))
  assert.ok(seen.has('lib/ffmpeg-filter-escape.ts'))

  const video = readFileSync(path.join(SERVER_ROOT, 'generators/video.ts'), 'utf8')
  const core = readFileSync(path.join(SERVER_ROOT, 'lib/final-render-core.ts'), 'utf8')
  const videoSource = ts.createSourceFile('generators/video.ts', video, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const finalComposition = namedFunction(videoSource, 'runFinalComposition')
  const finalCompositionBody = finalComposition.body!.getText(videoSource)
  const finalCompositionCalls = directCalls(finalComposition.body!)
  for (const builder of [
    'buildFinalOverlayFilters',
    'buildFinalVignetteFilters',
    'buildFinalFilmGrainFilters',
    'buildFinalArchiveFilters',
    'buildFinalLogoFilters',
    'describeFinalBurnIns',
    'buildFinalEncodeTiers',
  ]) assert.ok(finalCompositionCalls.has(builder), `runFinalComposition must call ${builder}`)

  const loopingInput = namedFunction(videoSource, 'buildLoopingMediaInputArgs')
  const loopingCalls = directCalls(loopingInput.body!)
  for (const helper of ['buildFinalInputArgs', 'isStaticImagePath', 'stillDecoderArgs']) {
    assert.ok(loopingCalls.has(helper), `buildLoopingMediaInputArgs must call ${helper}`)
  }

  const shapingCalls: ts.CallExpression[] = []
  const findShaping = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)
        && node.expression.text === 'writeShapedLogo') shapingCalls.push(node)
    ts.forEachChild(node, findShaping)
  }
  findShaping(finalComposition.body!)
  assert.equal(shapingCalls.length, 1, 'logo shaping stays local')
  assert.equal(shapingCalls[0]!.arguments[2]!.getText(videoSource), 'Math.round(w * (logo.scale || 0.1))')

  assert.match(video, /from '\.\.\/lib\/final-render-core\.js'/)
  assert.match(video, /export type \{ EncodeTier \} from '\.\.\/lib\/final-render-core\.js'/)
  assert.match(video, /export async function runEncodeTierChain/)
  for (const marker of [
    'Math.round(w * Math.min(0.95, layer.scale_pct))',
    "label: 'H.264 · no effects (recovery)'",
  ]) {
    assert.equal(finalCompositionBody.includes(marker), false, `runFinalComposition must no longer own ${marker}`)
    assert.equal(core.split(marker).length - 1, 1, `core must own one ${marker}`)
  }
  assert.equal(core.split('Math.round(w * (logo.scale || 0.1))').length - 1, 1,
    'core owns one final-logo sizing formula while local shaping keeps its separate call')
})
