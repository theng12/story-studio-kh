import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const root = new URL('..', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')

const ideas = read('pages/projects/[slug]/ideas.vue')
const scripts = read('pages/projects/[slug]/scripts.vue')
const research = read('pages/projects/[slug]/research.vue')
const metadata = read('pages/projects/[slug]/metadata.vue')
const outline = read('components/OutlineReviewPanel.vue')
const preview = read('components/ScriptPreview.vue')

test('writing actions retain an accepted request identity until the POST confirms it', () => {
  assert.match(ideas, /freshIdeaCampaignAction\.begin\(body\)/)
  assert.match(ideas, /operation_id: operationId/)
  assert.match(ideas, /freshIdeaCampaignAction\.complete\(operationId\)/)

  assert.match(scripts, /const operationId = freshScriptAction\.begin\(params\)/)
  assert.match(scripts, /params\.operation_id = operationId/)

  assert.match(outline, /freshOutlineExpansionAction\.begin\(body/)
  assert.match(outline, /operation_id: operationId/)

  assert.match(metadata, /freshMetadataAction\.begin\(payload\)/)
  assert.match(metadata, /operation_id: operationId/)
  assert.match(metadata, /freshMetadataAction\.complete\(operationId\)/)
})

test('late writing loads use a request sequence as well as target equality', () => {
  for (const [label, source, sequence] of [
    ['research', research, 'loadExistingSequence'],
    ['finalizer', metadata, 'metadataLoadSequence'],
    ['outline', outline, 'outlineLoadSequence'],
    ['script preview', preview, 'loadSequence'],
  ] as const) {
    assert.match(source, new RegExp(`let ${sequence} = 0`), `${label} needs a sequence invalidator`)
    assert.match(source, new RegExp(`const requestSequence = \\+\\+${sequence}`), `${label} needs a sequence per request`)
    assert.match(source, new RegExp(`requestSequence !== ${sequence}`), `${label} must reject A→B→A and overlapping same-target replies`)
  }
})

test('research and finalizer scope late replies and writes to the captured project and episode', () => {
  assert.match(research, /const projectSlug = slug\.value[\s\S]*?\/projects\/\$\{projectSlug\}\/research\/\$\{ep\}/)
  assert.match(research, /slug\.value !== projectSlug \|\| episodeId\.value !== ep/)
  assert.match(research, /watch\(\[slug, episodeId\], \(\) => \{\s*researchScopeEpoch\+\+\s*void loadExisting\(\)\s*\}, \{ immediate: true \}\)/)
  assert.match(research, /target\?\.projectSlug === slug\.value && target\?\.episodeId === episodeId\.value/)

  assert.match(metadata, /const projectSlug = slug\.value[\s\S]*?\/projects\/\$\{projectSlug\}\/episodes\/\$\{code\}\/metadata/)
  assert.match(metadata, /requestSequence !== metadataLoadSequence \|\| metadataScopeEpoch !== scopeEpoch \|\| slug\.value !== projectSlug \|\| episodeId\.value !== code/)
  assert.match(metadata, /watch\(\[slug, episodeId\], async \(\[projectSlug, code\]\)/)
  assert.match(metadata, /async function waitForJob\(projectSlug: string, jobId: string\)/)
  assert.match(metadata, /\/projects\/\$\{projectSlug\}\/generate\/metadata\/save/)
  assert.match(metadata, /slug\.value !== projectSlug \|\| episodeId\.value !== code\) return/)
})
