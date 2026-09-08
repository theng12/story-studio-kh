import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { variantsForVideoOperation } from '../utils/genstudio-video-variants.js'

const source = readFileSync(new URL('../pages/projects/[slug]/motion-review.vue', import.meta.url), 'utf8')

function scriptAst(vueSource: string): ts.SourceFile {
  const match = vueSource.match(/<script setup lang="ts">([\s\S]*?)<\/script>/)
  assert.ok(match, 'Motion Review must keep its typed setup script')
  return ts.createSourceFile('motion-review.ts', match[1]!, ts.ScriptTarget.Latest, true)
}

function descendants(node: ts.Node): ts.Node[] {
  const nodes: ts.Node[] = []
  const visit = (current: ts.Node): void => {
    nodes.push(current)
    current.forEachChild(visit)
  }
  visit(node)
  return nodes
}

function namedFunction(file: ts.SourceFile, name: string): ts.FunctionLikeDeclarationBase {
  const found = descendants(file).find((node): node is ts.FunctionDeclaration => (
    ts.isFunctionDeclaration(node) && node.name?.text === name
  ))
  assert.ok(found, `expected ${name} function`)
  return found
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment | ts.ShorthandPropertyAssignment {
  const found = object.properties.find((candidate): candidate is ts.PropertyAssignment | ts.ShorthandPropertyAssignment => (
    (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate))
    && candidate.name.getText() === name
  ))
  assert.ok(found, `expected ${name} property`)
  return found
}

test('Motion Review derives resolution and duration controls from priced image-to-video rows', () => {
  assert.match(source, /aria-label="Published resolution"/)
  assert.match(source, /v-for="resolution in availableResolutions"/)
  assert.match(source, /variantsForVideoOperation\(selectedVideoModel\.value\?\.variants, STORY_STUDIO_VIDEO_OPERATION\)/)
  assert.doesNotMatch(source, /capability\.durations|provider.*duration/i)

  const selected = variantsForVideoOperation([
    { operation: 'text-to-video', duration_seconds: 5, resolution: '720p' },
    { operation: 'image-to-video', duration_seconds: 30, resolution: '4k' },
  ], 'image-to-video')
  assert.deepEqual(selected, [{ operation: 'image-to-video', duration_seconds: 30, resolution: '4k' }])
})

test('Motion Review generation payload keeps operation, resolution, mode, and manual duration at the request boundary', () => {
  const file = scriptAst(source)
  const generationPayload = namedFunction(file, 'generationPayload')
  const returned = descendants(generationPayload).find((node): node is ts.ReturnStatement => (
    ts.isReturnStatement(node) && !!node.expression && ts.isObjectLiteralExpression(node.expression)
  ))
  assert.ok(returned?.expression && ts.isObjectLiteralExpression(returned.expression))
  const payload = returned.expression
  assert.equal((property(payload, 'operation') as ts.PropertyAssignment).initializer.getText(file), 'STORY_STUDIO_VIDEO_OPERATION')
  assert.equal((property(payload, 'duration_mode') as ts.PropertyAssignment).initializer.getText(file), 'durationMode.value')
  assert.equal((property(payload, 'resolution') as ts.PropertyAssignment).initializer.getText(file), 'selectedResolution.value')
  assert.match(payload.getText(file), /durationMode\.value === 'manual'/)
  assert.match(payload.getText(file), /duration_seconds: selectedManualVariant\.value\.duration_seconds/)

  for (const name of ['generateOne', 'generateMissing']) {
    const body = namedFunction(file, name).getText(file)
    assert.match(body, /const payload = generationPayload\(\)/)
    assert.match(body, /\.\.\.payload/)
  }
})

test('Motion Review presets persist timing mode while missing mode restores legacy manual behavior', () => {
  assert.match(source, /duration_seconds: manualDurationSeconds\.value \?\? undefined/)
  assert.match(source, /resolution: selectedResolution\.value \|\| undefined/)
  assert.match(source, /duration_mode: durationMode\.value/)
  assert.match(source, /data\?\.duration_mode === 'follow_narration' \? 'follow_narration' : 'manual'/)
})

test('Motion Review keeps catalogue selection healing and batch eligibility explicit', () => {
  assert.match(source, /selectLiveImageToVideoModel\(raw, genStudioVideoModels\.value\)/)
  assert.match(source, /scene\.motion_choice !== 'still'/)
  assert.match(source, /!scene\.clip_exists/)
  assert.match(source, /scene\.end_sec - scene\.start_sec >= animateMinSeconds\.value/)
  assert.doesNotMatch(source, /exact \|\| mapped \|\| genStudioVideoModels\.value\.find/)
})
