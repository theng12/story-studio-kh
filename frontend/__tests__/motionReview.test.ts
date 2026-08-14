import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import ts from 'typescript'
import { variantsForVideoOperation, videoVariantKey } from '../utils/genstudio-video-variants.js'

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

function objectProperty(object: ts.ObjectLiteralExpression, name: string): ts.PropertyAssignment {
  const property = object.properties.find((candidate): candidate is ts.PropertyAssignment => (
    ts.isPropertyAssignment(candidate) && candidate.name.getText() === name
  ))
  assert.ok(property, `expected ${name} property`)
  return property
}

function assertSelectedOperationContract(vueSource: string): void {
  const file = scriptAst(vueSource)
  for (const name of ['generateOne', 'generateMissing']) {
    const post = descendants(namedFunction(file, name)).find((node): node is ts.CallExpression => (
      ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'post'
    ))
    assert.ok(post, `${name} must submit through post()`)
    const payload = post.arguments.at(-1)
    assert.ok(payload && ts.isObjectLiteralExpression(payload), `${name} must submit an object payload`)
    const operation = payload.properties.find((property): property is ts.PropertyAssignment => (
      ts.isPropertyAssignment(property) && property.name.getText() === 'operation'
    ))
    assert.ok(operation, `${name} must submit the selected operation`)
    assert.equal(
      operation.initializer.getText(file),
      'selectedVideoVariant.value.operation',
      `${name} must submit the selected operation`,
    )
  }

  const presetCall = descendants(file).find((node): node is ts.CallExpression => (
    ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'usePresets'
  ))
  assert.ok(presetCall, 'Motion Review must define presets')
  const presetOptions = presetCall.arguments[0]
  assert.ok(presetOptions && ts.isObjectLiteralExpression(presetOptions), 'usePresets must receive options')
  const snapshot = objectProperty(presetOptions, 'snapshot').initializer
  assert.ok(ts.isArrowFunction(snapshot), 'preset snapshot must be a function')
  const snapshotObject = snapshot.body
  assert.ok(ts.isParenthesizedExpression(snapshotObject) || ts.isObjectLiteralExpression(snapshotObject), 'snapshot must return data')
  const returned = ts.isParenthesizedExpression(snapshotObject) ? snapshotObject.expression : snapshotObject
  assert.ok(ts.isObjectLiteralExpression(returned), 'snapshot must return an object')
  assert.equal(objectProperty(returned, 'operation').initializer.getText(file), 'selectedVideoVariant.value?.operation')

  const apply = objectProperty(presetOptions, 'apply').initializer
  assert.ok(ts.isArrowFunction(apply), 'preset apply must be a function')
  const operationKey = descendants(apply).find((node): node is ts.PropertyAssignment => (
    ts.isPropertyAssignment(node)
    && node.name.getText() === 'operation'
    && node.initializer.getText(file).includes('data?.operation')
  ))
  assert.ok(operationKey, 'preset restore must select using saved data.operation')
}

test('Motion Review exposes every live variant and queues the exact selected pair', () => {
  assert.match(source, /<select\s+v-model="videoVariantKey"/)
  assert.match(source, /v-for="variant in selectedVideoVariants"/)
  assert.match(source, /variant\.credits_per_video/)
  assert.match(source, /variant\.minimum_credits/)
  assert.match(source, /variant\.price_version/)
  const selected = variantsForVideoOperation([
    { operation: 'text-to-video', duration_seconds: 5, resolution: '720p' },
    { operation: 'image-to-video', duration_seconds: 5, resolution: '720p' },
  ], 'image-to-video')
  assert.equal(selected.length, 1)
  assert.equal(videoVariantKey(selected[0]!), 'image-to-video:5:720p')
})

test('Motion Review uses cheapest only as an initial default and clamps when the selected model changes', () => {
  assert.match(source, /const videoVariantKey = ref\(''\)/)
  assert.match(source, /watch\(selectedVideoVariants, \(variants\) =>/)
  assert.match(source, /variants\.some\(variant => variantKey\(variant\) === videoVariantKey\.value\)/)
  assert.match(source, /videoVariantKey\.value = variantKey\(cheapestVariant\(variants\)!\)/)
})

test('Motion Review saves and restores the selected exact variant with its preset', () => {
  assert.match(source, /duration_seconds:\s*selectedVideoVariant\.value\?\.duration_seconds/)
  assert.match(source, /resolution:\s*selectedVideoVariant\.value\?\.resolution/)
  assert.match(source, /operation: selectedVideoVariant\.value\?\.operation/)
})

test('Motion Review sends and restores the selected operation as behavioral data', () => {
  assertSelectedOperationContract(source)

  // Mutation proof: the AST harness rejects either route losing this field,
  // rather than merely matching unrelated page text.
  const operation = 'operation: selectedVideoVariant.value.operation,'
  assert.throws(
    () => assertSelectedOperationContract(source.replace(operation, '')),
    /generateOne must submit the selected operation/,
  )
  const secondOperation = source.indexOf(operation, source.indexOf(operation) + operation.length)
  assert.ok(secondOperation >= 0, 'both Motion Review posts must carry an operation before mutation')
  assert.throws(
    () => assertSelectedOperationContract(source.slice(0, secondOperation) + source.slice(secondOperation + operation.length)),
    /generateMissing must submit the selected operation/,
  )
  assert.throws(
    () => assertSelectedOperationContract(source.replaceAll('data?.operation', 'data?.retired_operation')),
    /preset restore must select using saved data\.operation/,
  )
})

test('Motion Review never replaces a named missing model with the first available row', () => {
  assert.match(source, /selectLiveImageToVideoModel\(raw, genStudioVideoModels\.value\)/)
  assert.doesNotMatch(source, /exact \|\| mapped \|\| genStudioVideoModels\.value\.find/)
  assert.doesNotMatch(source, /find\(model => model\.available && model\.modes\.includes\('image-to-video'\)\)/)
})
